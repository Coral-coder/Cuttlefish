'use strict';
/* global cf, CFLayout, CFControls */
(function () {
  const { el, control, debounce } = CFControls;
  const $ = (id) => document.getElementById(id);
  const L = CFLayout;
  const W = L.CANVAS_W;
  const H = L.CANVAS_H;

  let S = null; // state snapshot
  let devices = [];
  let frameRGBA = new Uint8ClampedArray(W * H * 4);
  let srcFilter = 'all';
  let page = 'lighting';
  let selectedItem = null;
  const logs = [];
  let fps = 0;

  // ------------------------------------------------------------ navigation
  document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
  function go(p) {
    page = p;
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === p));
    document.querySelectorAll('.page').forEach((s) => s.classList.toggle('active', s.id === `page-${p}`));
    if (p === 'devices') renderDevices();
    if (p === 'layout') { renderLayoutList(); drawLayout(); }
    if (p === 'settings') renderSettings();
    if (p === 'diagnostics') renderDiagnostics();
    if (p === 'mapping') startMapping();
  }

  // ------------------------------------------------------------ helpers
  function items() {
    const out = [];
    for (const d of devices) for (const it of d.items || []) out.push({ ...it, owner: d.key, ownerName: d.name });
    return out;
  }

  function placementOf(it) {
    const p = S && S.settings.placements[it.key];
    if (p) return p;
    return L.defaultPlacement(it.size[0] || 1, it.size[1] || 1, it.defaultPosition, it.defaultScale);
  }

  function ledPoint(it, p, i) {
    if (p.leds && p.leds[i]) return p.leds[i];
    const g = it.ledPositions[i];
    return L.gridToCanvas(p, it.size[0], it.size[1], g[0], g[1]);
  }

  function frameColor(x, y) {
    const xi = Math.max(0, Math.min(W - 1, Math.floor(x)));
    const yi = Math.max(0, Math.min(H - 1, Math.floor(y)));
    const i = (yi * W + xi) * 4;
    return [frameRGBA[i], frameRGBA[i + 1], frameRGBA[i + 2]];
  }

  function rot(x, y, deg) {
    const r = (deg * Math.PI) / 180;
    return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
  }

  // canvas point -> item-local (grid units, origin at centre)
  function toLocal(p, w, h, x, y) {
    const s = p.scale;
    const cx = p.x + (w * s) / 2;
    const cy = p.y + (h * s) / 2;
    let [lx, ly] = rot(x - cx, y - cy, -(p.rotation || 0));
    if (p.flip) lx = -lx;
    return [lx / s, ly / s];
  }
  function fromLocal(p, w, h, u, v) {
    const s = p.scale;
    let lx = u * s;
    const ly = v * s;
    if (p.flip) lx = -lx;
    const [rx, ry] = rot(lx, ly, p.rotation || 0);
    return [p.x + (w * s) / 2 + rx, p.y + (h * s) / 2 + ry];
  }
  function movePlacement(it, oldP, newP) {
    if (oldP.leds) {
      const leds = {};
      for (const [i, pt] of Object.entries(oldP.leds)) {
        const [u, v] = toLocal(oldP, it.size[0], it.size[1], pt[0], pt[1]);
        leds[i] = fromLocal(newP, it.size[0], it.size[1], u, v).map((n) => Math.round(n * 100) / 100);
      }
      newP.leds = leds;
    }
    return newP;
  }

  // ------------------------------------------------------------ frames
  const prev = $('preview');
  const pctx = prev.getContext('2d');
  const img = pctx.createImageData(W, H);
  cf.onFrame(({ data }) => {
    const src = data;
    const dst = img.data;
    for (let i = 0; i < W * H * 4; i += 4) {
      dst[i] = src[i + 2];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i];
      dst[i + 3] = 255;
    }
    frameRGBA = dst;
    if (page === 'lighting') {
      pctx.putImageData(img, 0, 0);
      drawLedOverlay();
    } else if (page === 'layout') drawLayout();
  });
  cf.onStats((st) => {
    fps = st.canvasFps;
    renderLiveStats();
  });

  const ledCanvas = $('previewLeds');
  const lctx = ledCanvas.getContext('2d');
  function drawLedOverlay() {
    const k = ledCanvas.width / W;
    lctx.clearRect(0, 0, ledCanvas.width, ledCanvas.height);
    for (const it of items()) {
      if (S && (S.settings.enabled[it.owner] === false || S.settings.enabled[it.key] === false)) continue;
      const p = placementOf(it);
      for (let i = 0; i < it.ledPositions.length; i++) {
        const [x, y] = ledPoint(it, p, i);
        const c = frameColor(x, y);
        lctx.beginPath();
        lctx.arc(x * k, y * k, 4, 0, Math.PI * 2);
        lctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        lctx.fill();
        lctx.lineWidth = 1;
        lctx.strokeStyle = 'rgba(0,0,0,.75)';
        lctx.stroke();
      }
    }
  }

  function renderLiveStats() {
    const box = $('liveStats');
    const totalLeds = items().reduce((a, it) => a + it.ledPositions.length, 0);
    const devFps = devices.map((d) => `${d.name}: ${d.stats ? d.stats.fps : 0} fps`).slice(0, 6);
    box.replaceChildren(
      el('span', {}, `Canvas ${fps || 0} fps`),
      el('span', {}, `${devices.length} devices · ${totalLeds} LEDs`),
      ...devFps.map((t) => el('span', {}, t)),
    );
  }

  // ------------------------------------------------------------ effects
  function renderEffects() {
    const q = $('search').value.trim().toLowerCase();
    const fav = new Set(S.settings.favorites || []);
    const list = S.effects.filter((e) => {
      if (srcFilter === 'fav' && !fav.has(e.id)) return false;
      if (!['all', 'fav'].includes(srcFilter) && e.source !== srcFilter) return false;
      return !q || e.title.toLowerCase().includes(q) || (e.description || '').toLowerCase().includes(q);
    });
    const cur = S.effect && S.effect.id;
    $('effectList').replaceChildren(...list.map((e) => {
      const star = el('button', { class: `star ${fav.has(e.id) ? 'on' : ''}`, title: 'Favourite', onclick: (ev) => { ev.stopPropagation(); cf.toggleFavorite(e.id); } }, fav.has(e.id) ? '★' : '☆');
      return el('div', { class: `effect ${e.id === cur ? 'active' : ''}`, onclick: () => cf.setEffect(e.id), title: e.description || '' },
        el('span', { class: 'name' }, e.title), e.usesAudio ? el('span', { class: 'src' }, '♪') : null, el('span', { class: 'src' }, e.source), star);
    }));
    if (!list.length) $('effectList').append(el('p', { class: 'muted small' }, 'No effects match.'));
  }

  function renderEffect() {
    const e = S.effect;
    $('effTitle').textContent = e ? e.title : 'No effect';
    $('effDesc').textContent = e ? e.description || '' : '';
    $('effBadges').replaceChildren(...(e ? [e.usesAudio ? el('span', { class: 'tag' }, 'audio reactive') : null, e.usesScreen ? el('span', { class: 'tag' }, 'screen') : null] : []).filter(Boolean));
    const box = $('effProps');
    if (!e || !e.properties.length) {
      box.replaceChildren(el('p', { class: 'muted small' }, 'This effect has no settings.'));
      return;
    }
    box.replaceChildren(...e.properties.map((p) => control(p, e.values[p.property], (v) => cf.setEffectValue(p.property, v))));
  }

  $('search').addEventListener('input', debounce(renderEffects, 80));
  $('sourceChips').addEventListener('click', (ev) => {
    const b = ev.target.closest('.chip');
    if (!b) return;
    srcFilter = b.dataset.src;
    document.querySelectorAll('#sourceChips .chip').forEach((c) => c.classList.toggle('active', c === b));
    renderEffects();
  });
  $('btnImport').onclick = () => cf.importEffects();
  $('btnReload').onclick = () => cf.reloadEffects();
  $('btnResetEffect').onclick = () => cf.resetEffect();

  // ------------------------------------------------------------ power
  $('power').addEventListener('change', () => cf.setPaused(!$('power').checked));
  $('brightness').addEventListener('input', () => {
    $('brightnessOut').textContent = `${$('brightness').value}%`;
    setBrightness(Number($('brightness').value) / 100);
  });
  const setBrightness = debounce((v) => cf.setBrightness(v), 40);

  // ------------------------------------------------------------ layout editor
  const lc = $('layoutCanvas');
  const lx = lc.getContext('2d');
  const LK = lc.width / W;
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  const tctx = tmp.getContext('2d');
  let drag = null;
  let localPlacements = {};

  function effPlacement(it) {
    return localPlacements[it.key] || placementOf(it);
  }

  function drawLayout() {
    if (page !== 'layout') return;
    tctx.putImageData(new ImageData(frameRGBA.slice(), W, H), 0, 0);
    lx.imageSmoothingEnabled = true;
    lx.globalAlpha = 0.55;
    lx.drawImage(tmp, 0, 0, lc.width, lc.height);
    lx.globalAlpha = 1;
    // grid
    lx.strokeStyle = 'rgba(255,255,255,.06)';
    lx.lineWidth = 1;
    for (let x = 0; x <= W; x += 20) { lx.beginPath(); lx.moveTo(x * LK, 0); lx.lineTo(x * LK, lc.height); lx.stroke(); }
    for (let y = 0; y <= H; y += 20) { lx.beginPath(); lx.moveTo(0, y * LK); lx.lineTo(lc.width, y * LK); lx.stroke(); }
    for (const it of items()) {
      const p = effPlacement(it);
      const w = it.size[0];
      const h = it.size[1];
      const s = p.scale;
      const cx = (p.x + (w * s) / 2) * LK;
      const cy = (p.y + (h * s) / 2) * LK;
      const sel = selectedItem === it.key;
      const disabled = S.settings.enabled[it.owner] === false || S.settings.enabled[it.key] === false;
      lx.save();
      lx.translate(cx, cy);
      lx.rotate(((p.rotation || 0) * Math.PI) / 180);
      lx.strokeStyle = sel ? '#3ad1c3' : disabled ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.55)';
      lx.lineWidth = sel ? 2.5 : 1.2;
      lx.setLineDash(disabled ? [6, 6] : []);
      lx.strokeRect((-w * s * LK) / 2, (-h * s * LK) / 2, w * s * LK, h * s * LK);
      lx.restore();
      for (let i = 0; i < it.ledPositions.length; i++) {
        const [x, y] = ledPoint(it, p, i);
        const c = frameColor(x, y);
        lx.beginPath();
        lx.arc(x * LK, y * LK, Math.max(2.5, Math.min(7, s * LK * 0.3)), 0, Math.PI * 2);
        lx.fillStyle = disabled ? '#333' : `rgb(${c[0]},${c[1]},${c[2]})`;
        lx.fill();
        lx.lineWidth = 1.5;
        lx.strokeStyle = p.leds && p.leds[i] ? 'rgba(170,130,255,.95)' : 'rgba(0,0,0,.85)';
        lx.stroke();
      }
      if (sel || w * s * LK > 80) {
        lx.fillStyle = sel ? '#3ad1c3' : 'rgba(255,255,255,.7)';
        lx.font = '12px Segoe UI, sans-serif';
        lx.fillText(it.name, (p.x) * LK, (p.y) * LK - 4);
      }
    }
  }

  function hit(x, y) {
    const list = items();
    for (let k = list.length - 1; k >= 0; k--) {
      const it = list[k];
      const p = effPlacement(it);
      const [u, v] = toLocal(p, it.size[0], it.size[1], x, y);
      const padU = Math.max(it.size[0] / 2, 6 / p.scale);
      const padV = Math.max(it.size[1] / 2, 6 / p.scale);
      if (Math.abs(u) <= padU && Math.abs(v) <= padV) return it;
    }
    return null;
  }

  function canvasPoint(ev) {
    const r = lc.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H];
  }

  function commitPlacement(it, p) {
    localPlacements[it.key] = p;
    S.settings.placements[it.key] = p;
    cf.setPlacement(it.key, p);
    renderLayoutEdit();
  }

  lc.addEventListener('mousedown', (ev) => {
    const [x, y] = canvasPoint(ev);
    const it = hit(x, y);
    selectedItem = it ? it.key : null;
    renderLayoutList();
    renderLayoutEdit();
    if (it) {
      const p = { ...effPlacement(it) };
      drag = { it, start: [x, y], orig: p };
      lc.style.cursor = 'grabbing';
    }
    drawLayout();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!drag) return;
    const [x, y] = canvasPoint(ev);
    const np = { ...drag.orig, x: drag.orig.x + (x - drag.start[0]), y: drag.orig.y + (y - drag.start[1]) };
    localPlacements[drag.it.key] = movePlacement(drag.it, drag.orig, np);
    drawLayout();
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const p = localPlacements[drag.it.key];
    if (p) commitPlacement(drag.it, p);
    drag = null;
    lc.style.cursor = 'grab';
  });
  lc.addEventListener('wheel', (ev) => {
    const it = items().find((i) => i.key === selectedItem);
    if (!it) return;
    ev.preventDefault();
    const p = effPlacement(it);
    const f = ev.deltaY < 0 ? 1.08 : 1 / 1.08;
    const w = it.size[0];
    const h = it.size[1];
    const cx = p.x + (w * p.scale) / 2;
    const cy = p.y + (h * p.scale) / 2;
    const s = Math.max(0.2, Math.min(200, p.scale * f));
    const np = { ...p, scale: s, x: cx - (w * s) / 2, y: cy - (h * s) / 2 };
    localPlacements[it.key] = movePlacement(it, p, np);
    drawLayout();
    debouncedCommit(it);
  }, { passive: false });
  const debouncedCommit = debounce((it) => commitPlacement(it, localPlacements[it.key]), 250);
  window.addEventListener('keydown', (ev) => {
    if (page !== 'layout' || !selectedItem || /input|select|textarea/i.test(document.activeElement.tagName)) return;
    const it = items().find((i) => i.key === selectedItem);
    if (!it) return;
    const p = effPlacement(it);
    let np = null;
    if (ev.key === 'r' || ev.key === 'R') np = { ...p, rotation: ((p.rotation || 0) + (ev.shiftKey ? -90 : 90) + 360) % 360 };
    if (ev.key === 'f' || ev.key === 'F') np = { ...p, flip: !p.flip };
    const nudge = ev.shiftKey ? 10 : 1;
    if (ev.key === 'ArrowLeft') np = { ...p, x: p.x - nudge };
    if (ev.key === 'ArrowRight') np = { ...p, x: p.x + nudge };
    if (ev.key === 'ArrowUp') np = { ...p, y: p.y - nudge };
    if (ev.key === 'ArrowDown') np = { ...p, y: p.y + nudge };
    if (np) {
      ev.preventDefault();
      commitPlacement(it, movePlacement(it, p, np));
      drawLayout();
    }
  });

  function renderLayoutList() {
    const list = items();
    $('layoutList').replaceChildren(...list.map((it) => el('div', {
      class: `layout-item ${selectedItem === it.key ? 'active' : ''}`,
      onclick: () => { selectedItem = it.key; renderLayoutList(); renderLayoutEdit(); drawLayout(); },
    }, el('span', { class: 'n' }, it.name), el('span', { class: 'muted small' }, `${it.ledPositions.length} LEDs`))));
    if (!list.length) $('layoutList').append(el('p', { class: 'muted small' }, 'No devices yet.'));
  }

  function renderLayoutEdit() {
    const box = $('layoutEdit');
    const it = items().find((i) => i.key === selectedItem);
    if (!it) {
      box.replaceChildren(el('p', { class: 'muted small' }, 'Select a device on the canvas or in the list.'));
      return;
    }
    const p = effPlacement(it);
    const num = (label, key, step) => {
      const input = el('input', { type: 'number', step, value: Math.round((p[key] || 0) * 100) / 100 });
      input.addEventListener('change', () => {
        const np = { ...p, [key]: Number(input.value) };
        commitPlacement(it, movePlacement(it, p, np));
        drawLayout();
      });
      return [el('span', { class: 'muted' }, label), input];
    };
    const flip = el('input', { type: 'checkbox' });
    flip.checked = !!p.flip;
    flip.addEventListener('change', () => { commitPlacement(it, movePlacement(it, p, { ...p, flip: flip.checked })); drawLayout(); });
    box.replaceChildren(
      el('h3', {}, it.name),
      el('div', { class: 'field-grid' }, ...num('X', 'x', 1), ...num('Y', 'y', 1), ...num('Scale', 'scale', 0.5), ...num('Rotation', 'rotation', 15),
        el('span', { class: 'muted' }, 'Mirror'), el('label', { class: 'switch' }, flip, el('span'))),
      el('div', { class: 'row', style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' },
        el('button', { onclick: () => cf.identify(it.key) }, 'Identify'),
        p.leds ? el('button', { onclick: () => { const np = { ...p, leds: null }; commitPlacement(it, np); drawLayout(); }, title: 'Remove the per-LED positions found by the camera' }, 'Clear camera LEDs') : null,
        el('button', { class: 'ghost', onclick: () => { delete localPlacements[it.key]; delete S.settings.placements[it.key]; cf.setPlacement(it.key, null); renderLayoutEdit(); drawLayout(); } }, 'Reset')),
      p.leds ? el('p', { class: 'muted small' }, `${Object.keys(p.leds).length} LEDs positioned by camera (purple ring).`) : null,
    );
  }
  $('btnAutoMap').onclick = () => go('mapping');

  // ------------------------------------------------------------ devices page
  function deviceValue(d, p) {
    const saved = (S.settings.params[d.key] || {})[p.property];
    if (saved !== undefined) return saved;
    if (d.paramValues && d.paramValues[p.property] !== undefined) return d.paramValues[p.property];
    return p.default;
  }

  function renderDevices() {
    if (page !== 'devices' || !S) return;
    const grid = $('deviceGrid');
    $('deviceEmpty').hidden = devices.length > 0;
    if (!devices.length) {
      $('deviceEmpty').replaceChildren(el('div', { class: 'card' },
        el('h3', {}, 'No devices found yet'),
        el('p', { class: 'muted' }, 'Cuttlefish drives devices using SignalRGB-format device plugins. Install the public plugin library (466 plugins) to support most RGB hardware, or point Cuttlefish at your SignalRGB plugin folder in Settings.'),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          el('button', { class: 'primary', onclick: installPlugins }, S.officialPlugins.installed ? 'Update device plugin library' : 'Install device plugin library'),
          S.platform === 'win32' && !S.pawnio.driver ? el('button', { onclick: installPawnIO }, 'Enable RGB RAM / SMBus (PawnIO)') : null,
          el('button', { onclick: () => go('diagnostics') }, 'See detected hardware'))));
    }
    const open = new Set([...grid.querySelectorAll('details[open]')].map((d) => d.dataset.key));
    grid.replaceChildren(...devices.map((d) => deviceCard(d, open.has(d.key))));
  }

  function deviceCard(d, detailsOpen) {
    const enabled = S.settings.enabled[d.key] !== false;
    const sw = el('input', { type: 'checkbox' });
    sw.checked = enabled;
    sw.addEventListener('change', () => cf.setEnabled(d.key, sw.checked));
    const bVal = Math.round(((S.settings.deviceBrightness[d.key] ?? 1) * 100));
    const bOut = el('span', {}, `${bVal}%`);
    const bright = el('input', { type: 'range', min: 0, max: 100, value: bVal });
    bright.addEventListener('input', () => { bOut.textContent = `${bright.value}%`; cf.setDeviceBrightness(d.key, Number(bright.value) / 100); });
    const leds = (d.items || []).reduce((a, it) => a + it.ledPositions.length, 0);
    const card = el('div', { class: 'card device' },
      el('div', { class: 'top' },
        el('div', { class: 't' }, el('b', {}, d.name), el('span', { class: 'meta' }, `${d.plugin || ''} · ${leds} LEDs · ${d.stats ? d.stats.fps : 0} fps`)),
        el('label', { class: 'switch', title: 'Enable' }, sw, el('span'))),
      ...(d.failed ? [el('div', { class: 'alert' }, d.failed)] : []),
      ...(d.alerts || []).map((a) => el('div', { class: 'alert' }, el('b', {}, a.title), ' ', a.description)),
      ...(d.messages || []).map((m) => el('div', { class: 'msg', title: m.tooltip }, m.message)),
      d.battery ? el('div', { class: 'meta' }, `Battery: ${d.battery.level ?? '?'}%`) : null,
      el('div', { class: 'ctl' }, el('label', {}, el('span', {}, 'Brightness'), bOut), el('div', { class: 'row' }, bright)),
    );
    for (const ch of d.channels || []) {
      const input = el('input', { type: 'number', min: 0, max: ch.limit || 1000, value: ch.count, style: 'width:90px' });
      input.addEventListener('change', () => cf.setChannelCount(d.key, ch.id, Number(input.value)));
      card.append(el('div', { class: 'ctl' }, el('label', {}, el('span', {}, `${ch.id} LED count`), el('span', {}, `max ${ch.limit}`)), input));
    }
    if (d.furyStats) card.append(furyPanel(d));
    if ((d.params || []).length) {
      const det = el('details', { 'data-key': d.key }, el('summary', {}, 'Device settings'));
      if (detailsOpen) det.open = true;
      for (const p of d.params) {
        const pp = { ...p, __plugin: true };
        det.append(control(pp, deviceValue(d, p), (v) => {
          S.settings.params[d.key] = { ...(S.settings.params[d.key] || {}), [p.property]: v };
          cf.setParam(d.key, p.property, v);
        }));
      }
      card.append(det);
    }
    card.append(el('div', { style: 'display:flex;gap:8px' },
      el('button', { onclick: () => cf.identify(d.key) }, 'Identify'),
      el('div', { class: 'grow' }),
      el('span', { class: 'muted small' }, d.backend || '')));
    return card;
  }

  function furyPanel(d) {
    const st = d.furyStats;
    return el('div', { class: 'ctl' },
      el('label', {}, el('span', {}, 'Memory update rate'), el('span', { class: st.fps >= 30 ? 'ok' : st.fps >= 15 ? 'warn' : '' }, `${st.fps} fps · ${st.lastFrameMs.toFixed(1)} ms/frame`)),
      el('div', { class: 'kv' },
        el('span', {}, 'Profile'), el('span', {}, `${st.profile && st.profile.busyWait ? 'turbo (busy-wait SMBus)' : ''} begin ${st.profile.beginDelay} ms / end ${st.profile.endDelay} ms${st.profile.budget ? ` / ${st.profile.budget} writes per frame` : ''}`),
        el('span', {}, 'Writes'), el('span', {}, `${st.writes} (${st.failures} failed, ${st.skipped} deferred)`),
        el('span', {}, 'Modules'), el('span', {}, (d.sticks || []).map((s) => `slot ${s.slot + 1} @0x${s.addr.toString(16)}`).join(', '))),
      el('button', { onclick: (ev) => { ev.target.disabled = true; ev.target.textContent = 'Tuning… (lights will flicker)'; cf.furyAutotune(); } }, 'Auto-tune timing'),
    );
  }

  $('btnRescan').onclick = () => cf.rescan();
  cf.onAutotune((m) => {
    const msg = m.error ? `Auto-tune failed: ${m.error}` : `Auto-tune done: settle delay ${m.result.chosenDelay} ms (${m.result.results.map((r) => `${r.delay}ms→${r.fps}fps${r.errors ? ' ✗' : ''}`).join(', ')})`;
    showBanner(msg, 'info', 12000);
    renderDevices();
  });

  async function installPlugins() {
    showBanner('Downloading the device plugin library…', 'info');
    const r = await cf.installPlugins();
    showBanner(r.error ? `Plugin download failed: ${r.error}` : `Installed ${r.count} device plugins. Scanning for hardware…`, r.error ? '' : 'info', 8000);
  }

  async function installPawnIO() {
    showBanner('Installing the PawnIO SMBus driver (Windows may ask for confirmation)…', 'info');
    const r = await cf.installPawnIO();
    showBanner(r.driver ? `PawnIO ready (${r.modules.length} SMBus modules). Restart Cuttlefish to scan memory.` : `PawnIO install: ${r.driverResult}. You can also install it from pawnio.eu.`, 'info', 15000);
  }

  // ------------------------------------------------------------ mapping
  let mappingStarted = false;
  async function startMapping() {
    if (mappingStarted) return;
    $('btnStartMapping').disabled = true;
    const r = await cf.startMapping();
    $('btnStartMapping').disabled = false;
    if (r.error) {
      $('mapStatus').textContent = `Could not start: ${r.error}`;
      return;
    }
    mappingStarted = true;
    $('qrBox').replaceChildren(el('img', { src: r.qr, alt: 'QR code' }));
    $('mapUrl').textContent = r.url;
    $('mapStatus').textContent = r.urls.length > 1 ? `Also reachable at: ${r.urls.slice(1).join('  ')}` : 'Waiting for your phone…';
  }
  $('btnStartMapping').onclick = startMapping;
  cf.onMapping((m) => {
    if (m.info) $('mapStatus').textContent = m.info.clients ? `Phone connected (${m.info.clients}).` : 'Waiting for your phone…';
    if (m.session && m.session.active) $('mapStatus').textContent = 'Mapping in progress — keep the phone still…';
    if (m.result) {
      const rows = m.result.items || [];
      $('mapResult').replaceChildren(el('h3', {}, 'Last result'), el('table', {}, el('tr', {}, el('th', {}, 'Device'), el('th', {}, 'Seen'), el('th', {}, 'Fit error')),
        ...rows.map((x) => el('tr', {}, el('td', {}, x.name), el('td', { class: x.detected ? 'ok' : 'bad' }, `${x.detected}/${x.total}`), el('td', {}, x.error !== undefined ? `${x.error}px` : '—')))));
      showBanner('Layout updated from the phone camera.', 'info', 6000);
    }
  });

  // ------------------------------------------------------------ settings
  function settingRow(label, help, input) {
    return el('div', { class: 'setting' }, el('div', { class: 'l' }, label, help ? el('small', {}, help) : null), input);
  }
  function toggle(key, value, onChange) {
    const i = el('input', { type: 'checkbox' });
    i.checked = !!value;
    i.addEventListener('change', () => (onChange ? onChange(i.checked) : cf.setSetting(key, i.checked)));
    return el('label', { class: 'switch' }, i, el('span'));
  }
  function dirList(kind, dirs) {
    return el('div', { class: 'dirlist' }, ...(dirs || []).map((d) => el('div', {}, el('code', { title: d }, d), el('button', { class: 'ghost', onclick: () => cf.removeFolder(kind, d) }, '✕'))),
      el('button', { onclick: () => cf.addFolder(kind) }, '+ Add folder'));
  }

  function renderSettings() {
    if (page !== 'settings' || !S) return;
    const st = S.settings;
    const fpsSel = el('select', {}, [15, 30, 45, 60, 90, 120].map((v) => el('option', { value: v, selected: Number(st.fps) === v }, `${v} fps`)));
    fpsSel.addEventListener('change', () => cf.setSetting('fps', Number(fpsSel.value)));
    const orgbHost = el('input', { type: 'text', value: st.openrgb.host, style: 'width:130px' });
    const orgbPort = el('input', { type: 'number', value: st.openrgb.port, style: 'width:80px' });
    const saveOrgb = () => cf.setSetting('openrgb', { ...st.openrgb, host: orgbHost.value, port: Number(orgbPort.value) });
    orgbHost.addEventListener('change', saveOrgb);
    orgbPort.addEventListener('change', saveOrgb);
    const furyProfile = el('select', {}, ['safe', 'balanced', 'turbo'].map((v) => el('option', { value: v, selected: st.fury.profile === v }, v)));
    furyProfile.addEventListener('change', () => cf.setSetting('fury', { ...st.fury, profile: furyProfile.value }));
    const up = S.update || {};
    const upText = { dev: 'Development build (updates disabled)', checking: 'Checking…', current: 'Up to date', downloading: `Downloading v${up.version} (${up.progress || 0}%)`, ready: `v${up.version} ready — installing`, error: `Update error: ${up.error}`, idle: 'Waiting' }[up.state] || up.state;

    $('settingsGrid').replaceChildren(
      el('div', { class: 'card' }, el('h3', {}, 'General'),
        settingRow('Start with Windows', 'Runs in the tray at login (elevated, for RGB memory access).', toggle('autostart', st.autostart)),
        settingRow('Automatic updates', `Installs new versions silently from GitHub. ${upText}`, el('div', { style: 'display:flex;gap:8px;align-items:center' }, el('button', { onclick: () => cf.checkUpdate() }, 'Check now'), toggle('autoUpdate', st.autoUpdate))),
        settingRow('Frame rate', 'Effect rendering and device update rate.', fpsSel),
        settingRow('Audio reactive effects', 'Captures system audio (loopback) for effects that use engine.audio.', toggle('audio', st.audio)),
        settingRow('Screen reactive effects', 'Samples the screen for ambience effects and game meters.', toggle('screen', st.screen))),
      el('div', { class: 'card' }, el('h3', {}, 'Device support'),
        settingRow('Device plugin library', S.officialPlugins.installed ? `${S.officialPlugins.files} plugins, downloaded ${new Date(S.officialPlugins.date).toLocaleDateString()}` : 'Public SignalRGB-format plugins (downloaded from gitlab.com/signalrgb).', el('button', { onclick: installPlugins }, S.officialPlugins.installed ? 'Update' : 'Install')),
        settingRow('Use SignalRGB folders', 'Also load plugins & effects from an existing SignalRGB install / Documents\\WhirlwindFX.', toggle('useSignalRgbFolders', st.useSignalRgbFolders)),
        settingRow('OpenRGB SDK', 'Drive devices exposed by a running OpenRGB server.', el('div', { style: 'display:flex;gap:6px;align-items:center' }, orgbHost, orgbPort, toggle('openrgb', st.openrgb.enabled, (v) => cf.setSetting('openrgb', { ...st.openrgb, enabled: v })))),
        el('h3', { style: 'margin-top:14px' }, 'Extra plugin folders'), dirList('plugins', st.pluginDirs),
        el('h3', { style: 'margin-top:14px' }, 'Extra effect folders'), dirList('effects', st.effectDirs)),
      el('div', { class: 'card' }, el('h3', {}, 'RGB memory & SMBus'),
        settingRow('PawnIO driver', S.platform !== 'win32' ? 'Windows only.' : S.pawnio.driver ? `Installed · modules: ${S.pawnio.modules.join(', ') || 'none found'}` : 'Required for RGB RAM and some motherboards.', S.platform === 'win32' ? el('button', { onclick: installPawnIO }, S.pawnio.driver ? 'Repair' : 'Install') : el('span')),
        settingRow('SMBus devices', 'Scan the system SMBus for RGB memory (restart required).', toggle('smbusEnabled', st.smbusEnabled !== false)),
        settingRow('Native Kingston FURY driver', 'Cuttlefish\'s high-frame-rate driver for FURY Beast / Renegade RGB.', toggle('fury', st.fury.enabled, (v) => cf.setSetting('fury', { ...st.fury, enabled: v }))),
        settingRow('FURY speed profile', 'safe = 10 ms settle (OpenRGB timing), balanced = 3 ms, turbo = 1 ms + busy-wait + error-ordered writes.', furyProfile),
        settingRow('Third-party SMBus plugins', 'Run SMBus plugins from the library (Corsair, G.Skill, … memory). Use with care.', toggle('smbusPlugins', st.smbusPlugins))),
      el('div', { class: 'card' }, el('h3', {}, 'Folders'),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          el('button', { onclick: () => cf.openFolder('effects') }, 'My effects'),
          el('button', { onclick: () => cf.openFolder('plugins') }, 'My plugins'),
          el('button', { onclick: () => cf.openFolder('userdata') }, 'App data')),
        el('p', { class: 'muted small' }, 'Active plugin folders:'), el('div', { class: 'dirlist' }, ...(S.pluginDirs || []).map((d) => el('div', {}, el('code', { title: d }, d)))),
        el('p', { class: 'muted small' }, `Cuttlefish ${S.version} · free & open source · `, el('a', { href: '#', onclick: () => cf.openExternal('https://github.com/Coral-coder/Cuttlefish') }, 'GitHub'))),
    );
  }

  // ------------------------------------------------------------ diagnostics
  async function renderDiagnostics() {
    if (page !== 'diagnostics') return;
    const d = await cf.diagnostics();
    $('hidTable').replaceChildren(el('table', {},
      el('tr', {}, el('th', {}, 'VID:PID'), el('th', {}, 'Product'), el('th', {}, 'Interfaces'), el('th', {}, 'Plugin')),
      ...d.hid.map((h) => el('tr', {},
        el('td', { class: 'mono' }, `${h.vendorId.toString(16).padStart(4, '0')}:${h.productId.toString(16).padStart(4, '0')}`),
        el('td', {}, `${h.manufacturer || ''} ${h.product || ''}`),
        el('td', { class: 'small muted' }, h.endpoints.map((e) => `if${e.interface} ${e.usage_page.toString(16)}:${e.usage.toString(16)}`).join(', ')),
        el('td', { class: h.plugin ? 'ok' : 'muted' }, h.plugin || '—')))));
    const sm = d.smbus;
    $('smbusInfo').replaceChildren(
      !sm ? el('p', { class: 'muted' }, S.platform === 'win32' ? 'SMBus host not running.' : 'SMBus access is Windows-only.') :
        el('div', {}, sm.error ? el('p', { class: 'bad' }, sm.error) : null,
          ...sm.buses.map((b) => el('p', {}, el('b', {}, b.name), ` vendor 0x${(b.info.vendor || 0).toString(16)} · ${b.stats.tx} transactions · ${b.stats.errors} errors · avg ${(b.stats.us / Math.max(1, b.stats.tx)).toFixed(0)} µs`))),
      el('p', { class: 'muted small' }, `OpenRGB: ${d.openrgb && d.openrgb.connected ? 'connected' : d.openrgb && d.openrgb.error ? d.openrgb.error : 'off'}`),
      el('p', { class: 'muted small' }, `Motherboard: ${d.state.motherboard || 'unknown'} · ${d.state.os}`));
    logs.splice(0, logs.length, ...d.logs);
    renderLogs();
  }
  function renderLogs() {
    if (page !== 'diagnostics') return;
    $('logBox').textContent = logs.slice(-300).map((l) => `${new Date(l.t).toLocaleTimeString()} [${l.role}] ${l.msg}`).join('\n');
    $('logBox').scrollTop = $('logBox').scrollHeight;
  }
  cf.onLog((l) => { logs.push(l); if (logs.length > 600) logs.shift(); renderLogs(); });
  $('btnSaveDiag').onclick = () => cf.saveDiagnostics();

  // ------------------------------------------------------------ banner
  let bannerTimer = null;
  function showBanner(text, kind, ms, actions) {
    const b = $('banner');
    b.className = `banner ${kind || ''}`;
    b.replaceChildren(el('span', { class: 'grow' }, text), ...(actions || []), el('button', { class: 'ghost', onclick: () => { b.hidden = true; } }, '✕'));
    b.hidden = false;
    clearTimeout(bannerTimer);
    if (ms) bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
  }
  function conflictBanner(list) {
    if (!list || !list.length) return false;
    showBanner(`Other RGB software is running and holding your devices: ${list.join(', ')}.`, '', 0,
      [el('button', { class: 'primary', onclick: () => { cf.closeConflicts(); showBanner('Closing other RGB software…', 'info', 5000); } }, 'Close them')]);
    return true;
  }
  cf.onConflicts(conflictBanner);

  function startupBanner() {
    if (!S) return;
    if (conflictBanner(S.conflicts)) return;
    if (!S.officialPlugins.installed && !devices.length) {
      showBanner('Setting up device support…', 'info', 0, [el('button', { class: 'primary', onclick: installPlugins }, 'Download device plugins')]);
    } else if (S.platform === 'win32' && !S.pawnio.driver) {
      showBanner('RGB memory (e.g. Kingston FURY) needs the free PawnIO SMBus driver.', '', 0, [el('button', { class: 'primary', onclick: installPawnIO }, 'Install PawnIO')]);
    }
  }
  cf.onLibrary((p) => {
    if (p.task === 'plugins' && p.state === 'downloading') showBanner(`Downloading device plugins… ${Math.round((p.progress || 0) * 100)}%`, 'info');
    if (p.task === 'plugins' && p.state === 'done') showBanner(`Installed ${p.files} device plugins. Scanning for hardware…`, 'info', 6000);
    if (p.task === 'plugins' && p.state === 'error') showBanner(`Device plugin download failed: ${p.error}. Retrying in 10 minutes.`, '', 0, [el('button', { onclick: installPlugins }, 'Retry now')]);
    if (p.task === 'pawnio') showBanner(`PawnIO: ${p.state}`, 'info', p.state === 'done' ? 6000 : 0);
  });
  cf.onUpdate((u) => {
    if (S) S.update = u;
    if (u.state === 'downloading') $('version').textContent = `v${S ? S.version : ''} · updating ${u.progress || 0}%`;
    if (u.state === 'ready') showBanner(`Cuttlefish ${u.version} downloaded — restarting to install…`, 'info');
    if (page === 'settings') renderSettings();
  });

  // ------------------------------------------------------------ state
  function applyState(s) {
    S = s;
    devices = s.devices || devices;
    $('version').textContent = `v${s.version}`;
    $('brightness').value = Math.round(s.settings.brightness * 100);
    $('brightnessOut').textContent = `${$('brightness').value}%`;
    $('power').checked = !s.settings.paused;
    $('devCount').textContent = devices.length;
    localPlacements = {};
    renderEffects();
    renderEffect();
    renderDevices();
    if (page === 'layout') { renderLayoutList(); renderLayoutEdit(); }
    renderSettings();
  }
  cf.onState(applyState);
  cf.onDevices((list) => {
    const structural = JSON.stringify(list.map((d) => [d.key, (d.items || []).map((i) => i.key)])) !== JSON.stringify(devices.map((d) => [d.key, (d.items || []).map((i) => i.key)]));
    devices = list;
    $('devCount').textContent = devices.length;
    if (page === 'devices' && !document.activeElement.closest('.device')) renderDevices();
    if (structural && page === 'layout') renderLayoutList();
  });

  cf.state().then((s) => {
    applyState(s);
    startupBanner();
  });
})();
