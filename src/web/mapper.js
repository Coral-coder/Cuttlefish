'use strict';
// Phone-side structured-light mapper.
// The PC lights LEDs in Gray-code patterns (plus inverse frames); every camera
// pixel that sees an LED decodes to that LED's global index. Centroids per LED
// are sent back and the desktop app fits device placements from them.

(function () {
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.search).get('t') || '';
  const video = $('video');
  const overlay = $('overlay');
  const octx = overlay.getContext('2d');
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });
  let ws = null;
  let stream = null;
  let info = null;
  let frames = [];
  let W = 320;
  let H = 180;
  let framing = false;
  let busy = false;

  if (!window.isSecureContext) {
    $('secureHint').textContent = 'This page must be opened over https for camera access.';
  }

  function status(t, cls) {
    const s = $('status');
    s.textContent = t;
    s.className = `hint ${cls || ''}`;
  }

  function connect() {
    ws = new WebSocket(`wss://${location.host}/ws?t=${encodeURIComponent(token)}`);
    ws.onopen = () => status('Connected to Cuttlefish.', 'ok');
    ws.onclose = () => { status('Disconnected – retrying…', 'bad'); setTimeout(connect, 1500); };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  }

  function send(m) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  async function startCamera() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      });
    } catch (e) {
      $('secureHint').textContent = `Camera unavailable: ${e.message}`;
      return;
    }
    video.srcObject = stream;
    await video.play();
    $('intro').hidden = true;
    $('stage').hidden = false;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    W = 320;
    H = Math.round((W * vh) / vw);
    work.width = W;
    work.height = H;
    overlay.width = vw;
    overlay.height = vh;
    try { await navigator.wakeLock.request('screen'); } catch { /* optional */ }
    connect();
  }

  async function lockExposure(lock) {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    const caps = track.getCapabilities();
    const adv = {};
    if (caps.exposureMode && caps.exposureMode.includes(lock ? 'manual' : 'continuous')) adv.exposureMode = lock ? 'manual' : 'continuous';
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes(lock ? 'manual' : 'continuous')) adv.whiteBalanceMode = lock ? 'manual' : 'continuous';
    if (caps.focusMode && caps.focusMode.includes(lock ? 'manual' : 'continuous')) adv.focusMode = lock ? 'manual' : 'continuous';
    if (Object.keys(adv).length) {
      try { await track.applyConstraints({ advanced: [adv] }); } catch { /* not supported */ }
    }
  }

  function grab() {
    wctx.drawImage(video, 0, 0, W, H);
    const d = wctx.getImageData(0, 0, W, H).data;
    const lum = new Float32Array(W * H);
    for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
    return lum;
  }

  const nextFrame = () => new Promise((r) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => r()) : requestAnimationFrame(() => r())));

  async function captureAveraged(n) {
    await nextFrame();
    await nextFrame();
    const acc = new Float32Array(W * H);
    for (let k = 0; k < n; k++) {
      await nextFrame();
      const f = grab();
      for (let i = 0; i < acc.length; i++) acc[i] += f[i];
    }
    for (let i = 0; i < acc.length; i++) acc[i] /= n;
    return acc;
  }

  function fromGray(g) {
    let n = g;
    for (let s = 1; s < 32; s <<= 1) n ^= n >>> s;
    return n;
  }

  // frames[step] = { pattern, img }. Patterns are either one group (fast mode) or
  // several sparse groups (precise mode: only ids with id % mod === phase light up).
  function decode(total, bits) {
    const dark = frames.find((f) => f && f.pattern.kind === 'off').img;
    const N = W * H;
    const groups = new Map();
    for (const f of frames) {
      if (!f || f.pattern.kind === 'off') continue;
      const g = f.pattern.mod > 1 ? f.pattern.phase : 0;
      if (!groups.has(g)) groups.set(g, { mod: f.pattern.mod || 1, phase: g, bits: [] });
      const grp = groups.get(g);
      if (f.pattern.kind === 'full') grp.full = f.img;
      else {
        grp.bits[f.pattern.bit] = grp.bits[f.pattern.bit] || {};
        grp.bits[f.pattern.bit][f.pattern.inv ? 'off' : 'on'] = f.img;
      }
    }
    const R = Math.max(4, Math.round(W / 40));
    const out = [];
    for (const grp of groups.values()) {
      const ids = new Int32Array(N).fill(-1);
      const weight = new Float32Array(N);
      for (let p = 0; p < N; p++) {
        const range = grp.full[p] - dark[p];
        if (range < 14) continue;
        let code = 0;
        let ok = true;
        for (let b = 0; b < bits; b++) {
          const fr = grp.bits[b];
          const d = fr.on[p] - fr.off[p];
          if (Math.abs(d) < range * 0.35) { ok = false; break; }
          if (d > 0) code |= 1 << b;
        }
        if (!ok) continue;
        const id = fromGray(code);
        if (id >= total || (grp.mod > 1 && id % grp.mod !== grp.phase)) continue;
        ids[p] = id;
        weight[p] = range;
      }
      // Connected blobs per id (8-neighbourhood, small gaps bridged by radius).
      const seen = new Uint8Array(N);
      const blobs = new Map();
      const stack = [];
      for (let p = 0; p < N; p++) {
        if (ids[p] < 0 || seen[p]) continue;
        const id = ids[p];
        let peak = 0, sx = 0, sy = 0, sw = 0, n = 0;
        const members = [];
        stack.push(p);
        seen[p] = 1;
        while (stack.length) {
          const q = stack.pop();
          members.push(q);
          const qx = q % W, qy = (q / W) | 0;
          if (weight[q] > peak) peak = weight[q];
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const nx = qx + dx, ny = qy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const r = ny * W + nx;
            if (!seen[r] && ids[r] === id) { seen[r] = 1; stack.push(r); }
          }
        }
        // centroid of the bright core of the blob (rejects the soft halo)
        for (const q of members) {
          if (weight[q] < peak * 0.6) continue;
          const w = weight[q];
          sx += ((q % W) + 0.5) * w;
          sy += (((q / W) | 0) + 0.5) * w;
          sw += w;
          n++;
        }
        if (members.length < 2) continue;
        const list = blobs.get(id) || [];
        // score: brightness and compactness (an LED is a small intense spot)
        list.push({ x: sx / sw, y: sy / sw, w: peak * Math.sqrt(Math.min(members.length, R * R)), n: members.length });
        blobs.set(id, list);
      }
      for (const [id, list] of blobs) {
        list.sort((a, b) => b.w - a.w);
        const cands = list.filter((c) => c.w >= list[0].w * 0.15).slice(0, 4);
        out.push({ id, x: cands[0].x, y: cands[0].y, n: cands[0].n, cands });
      }
    }
    return out;
  }

  function drawPoints(points) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const k = overlay.width / W;
    octx.lineWidth = Math.max(2, k);
    for (const p of points) {
      const hue = (p.id * 137.5) % 360;
      octx.strokeStyle = p.alt ? 'rgba(255,255,255,0.35)' : `hsl(${hue} 90% 60%)`;
      octx.beginPath();
      octx.arc(p.x * k, p.y * k, 3 * k, 0, Math.PI * 2);
      octx.stroke();
    }
  }

  function progress(step, of, text) {
    $('progress').hidden = false;
    $('bar').style.width = `${Math.round((100 * step) / Math.max(1, of))}%`;
    $('progressText').textContent = text;
  }

  async function onMessage(m) {
    switch (m.type) {
      case 'info':
        info = m;
        status(`Connected. ${m.total} LEDs across ${m.items} device zones.`, 'ok');
        break;
      case 'error':
        status(m.msg, 'bad');
        busy = false;
        $('btnMap').disabled = false;
        break;
      case 'session':
        frames = [];
        break;
      case 'step': {
        progress(m.step, m.of, `Capturing pattern ${m.step + 1} of ${m.of}… keep still`);
        frames[m.step] = { pattern: m.pattern, img: await captureAveraged(3) };
        send({ type: 'captured', step: m.step });
        break;
      }
      case 'decode': {
        progress(1, 1, 'Decoding…');
        const points = decode(m.total, m.bits);
        drawPoints(points.flatMap((p) => p.cands.map((c, k) => ({ id: p.id, x: c.x, y: c.y, alt: k > 0 }))));
        send({ type: 'result', camera: { width: W, height: H }, points });
        await lockExposure(false);
        break;
      }
      case 'done': {
        busy = false;
        $('btnMap').disabled = false;
        $('progress').hidden = true;
        const r = $('result');
        r.hidden = false;
        const rows = (m.report && m.report.items) || [];
        const found = rows.reduce((a, x) => a + x.detected, 0);
        const total = rows.reduce((a, x) => a + x.total, 0);
        r.innerHTML = `<h1 class="${found ? 'ok' : 'bad'}">${found ? 'Layout updated' : 'No LEDs found'}</h1>
          <p class="hint">Saw ${found} of ${total} LEDs. Devices the camera could not see keep their previous position.</p>
          <table>${rows.map((x) => `<tr><td>${x.name}</td><td>${x.detected}/${x.total}</td></tr>`).join('')}</table>`;
        break;
      }
      default:
        break;
    }
  }

  $('btnCamera').onclick = startCamera;
  $('btnFrame').onclick = () => {
    framing = !framing;
    $('btnFrame').textContent = framing ? 'Lights off' : 'Light all LEDs';
    send({ type: 'preview', on: framing, level: Number($('level').value) });
    if (!framing) send({ type: 'preview-end' });
  };
  $('btnMap').onclick = async () => {
    if (busy) return;
    busy = true;
    framing = false;
    $('btnFrame').textContent = 'Light all LEDs';
    $('btnMap').disabled = true;
    $('result').hidden = true;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    // Let auto-exposure settle on the lit LEDs at mapping brightness, then lock it so
    // every pattern is captured with identical exposure.
    progress(0, 1, 'Adjusting exposure…');
    await lockExposure(false);
    send({ type: 'preview', on: true, level: Number($('level').value) });
    await new Promise((r) => setTimeout(r, 1800));
    await lockExposure(true);
    send({ type: 'start', settleMs: Number($('settle').value), mode: $('mode').value, level: Number($('level').value) });
  };
  $('level').oninput = () => {
    $('levelOut').textContent = `${$('level').value}%`;
    if (framing) send({ type: 'preview', on: true, level: Number($('level').value) });
  };
  $('settle').oninput = () => { $('settleOut').textContent = `${$('settle').value} ms`; };
})();
