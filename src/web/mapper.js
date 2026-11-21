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

  function decode(total, bits) {
    const dark = frames[0];
    const full = frames[1];
    const N = W * H;
    const ids = new Int32Array(N).fill(-1);
    const weight = new Float32Array(N);
    const peak = new Map(); // id -> { i, w }
    for (let p = 0; p < N; p++) {
      const range = full[p] - dark[p];
      if (range < 18) continue;
      let code = 0;
      let ok = true;
      for (let b = 0; b < bits; b++) {
        const on = frames[2 + b * 2][p];
        const off = frames[3 + b * 2][p];
        const d = on - off;
        if (Math.abs(d) < range * 0.28) { ok = false; break; }
        if (d > 0) code |= 1 << b;
      }
      if (!ok) continue;
      const id = fromGray(code);
      if (id >= total) continue;
      ids[p] = id;
      weight[p] = range;
      const pk = peak.get(id);
      if (!pk || range > pk.w) peak.set(id, { i: p, w: range });
    }
    // Second pass: only keep pixels near each LED's brightest pixel (rejects reflections).
    const R = Math.max(6, Math.round(W / 26));
    const acc = new Map();
    for (let p = 0; p < N; p++) {
      const id = ids[p];
      if (id < 0) continue;
      const pk = peak.get(id);
      const px = p % W, py = (p / W) | 0;
      const qx = pk.i % W, qy = (pk.i / W) | 0;
      if (Math.abs(px - qx) > R || Math.abs(py - qy) > R) continue;
      let a = acc.get(id);
      if (!a) { a = { sx: 0, sy: 0, sw: 0, n: 0 }; acc.set(id, a); }
      const w = weight[p];
      a.sx += (px + 0.5) * w;
      a.sy += (py + 0.5) * w;
      a.sw += w;
      a.n++;
    }
    const points = [];
    for (const [id, a] of acc) {
      if (a.n < 2) continue;
      points.push({ id, x: a.sx / a.sw, y: a.sy / a.sw, n: a.n });
    }
    return points;
  }

  function drawPoints(points) {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    const k = overlay.width / W;
    octx.lineWidth = Math.max(2, k);
    for (const p of points) {
      const hue = (p.id * 137.5) % 360;
      octx.strokeStyle = `hsl(${hue} 90% 60%)`;
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
        await lockExposure(true);
        break;
      case 'step': {
        progress(m.step, m.of, `Capturing pattern ${m.step + 1} of ${m.of}… keep still`);
        frames[m.step] = await captureAveraged(3);
        send({ type: 'captured', step: m.step });
        break;
      }
      case 'decode': {
        progress(1, 1, 'Decoding…');
        const points = decode(m.total, m.bits);
        drawPoints(points);
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
    send({ type: 'preview', on: framing });
    if (!framing) send({ type: 'preview-end' });
  };
  $('btnMap').onclick = () => {
    if (busy) return;
    busy = true;
    framing = false;
    $('btnFrame').textContent = 'Light all LEDs';
    $('btnMap').disabled = true;
    $('result').hidden = true;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    send({ type: 'start', settleMs: Number($('settle').value) });
  };
  $('settle').oninput = () => { $('settleOut').textContent = `${$('settle').value} ms`; };
})();
