'use strict';
/* global cf */
// Hidden capture window: system audio (loopback) analysis for engine.audio and
// low-resolution screen sampling for engine.zone + vision meters.

let stream = null;
let config = { audio: false, screen: false, meters: [] };
let audioTimer = null;
let screenTimer = null;
const canvas = document.getElementById('c');
const ctx2d = canvas.getContext('2d', { willReadFrequently: true });

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

function inRange(v, spec, wrap) {
  const [a, b] = String(spec).split('-').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  if (wrap && a > b) return v >= a || v <= b;
  return v >= a && v <= b;
}

async function ensureStream() {
  if (stream) return stream;
  stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 480, height: 270, frameRate: 15 } });
  return stream;
}

function stopAll() {
  clearInterval(audioTimer);
  clearInterval(screenTimer);
  audioTimer = null;
  screenTimer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function startAudio() {
  const s = await ensureStream();
  const tracks = s.getAudioTracks();
  if (!tracks.length) {
    cf.log('No loopback audio track available');
    return;
  }
  const ac = new AudioContext();
  const src = ac.createMediaStreamSource(new MediaStream(tracks));
  const split = ac.createChannelSplitter(2);
  const an = ac.createAnalyser();
  an.fftSize = 4096;
  an.smoothingTimeConstant = 0.6;
  const anL = ac.createAnalyser();
  const anR = ac.createAnalyser();
  anL.fftSize = anR.fftSize = 1024;
  src.connect(an);
  src.connect(split);
  split.connect(anL, 0);
  split.connect(anR, 1);
  const spec = new Float32Array(an.frequencyBinCount);
  const td = new Float32Array(an.fftSize);
  const tl = new Float32Array(anL.fftSize);
  const tr = new Float32Array(anR.fftSize);
  const nyq = ac.sampleRate / 2;
  // 200 log-spaced bands, 30 Hz .. 16 kHz
  const edges = [];
  for (let i = 0; i <= 200; i++) edges.push(30 * Math.pow(16000 / 30, i / 200));
  const binOf = (f) => Math.min(spec.length - 1, Math.max(0, Math.round((f / nyq) * spec.length)));
  audioTimer = setInterval(() => {
    an.getFloatFrequencyData(spec);
    an.getFloatTimeDomainData(td);
    anL.getFloatTimeDomainData(tl);
    anR.getFloatTimeDomainData(tr);
    let sum = 0;
    for (let i = 0; i < td.length; i++) sum += td[i] * td[i];
    const rms = Math.sqrt(sum / td.length);
    const level = Math.max(-100, Math.min(0, 20 * Math.log10(rms + 1e-9)));
    const freq = new Array(200);
    let logSum = 0;
    let linSum = 0;
    let n = 0;
    for (let b = 0; b < 200; b++) {
      const lo = binOf(edges[b]);
      const hi = Math.max(lo, binOf(edges[b + 1]));
      let m = -200;
      for (let k = lo; k <= hi; k++) if (spec[k] > m) m = spec[k];
      const v = Math.max(0, Math.min(127, Math.round((m + 100) * 1.4)));
      freq[b] = v;
      const p = Math.pow(10, m / 10) + 1e-12;
      logSum += Math.log(p);
      linSum += p;
      n++;
    }
    const flatness = Math.exp(logSum / n) / (linSum / n);
    let diff = 0;
    let tot = 0;
    for (let i = 0; i < tl.length; i++) {
      diff += (tl[i] - tr[i]) ** 2;
      tot += tl[i] ** 2 + tr[i] ** 2;
    }
    const width = tot > 1e-9 ? Math.min(1, Math.sqrt(diff / tot)) : 0;
    cf.sendAudio({ level, density: Math.max(0, Math.min(1, flatness)), width, freq });
  }, 16);
}

async function startScreen() {
  const s = await ensureStream();
  const vt = s.getVideoTracks()[0];
  if (!vt) return;
  const video = document.createElement('video');
  video.srcObject = new MediaStream([vt]);
  video.muted = true;
  await video.play();
  screenTimer = setInterval(() => {
    const W = canvas.width;
    const H = canvas.height;
    ctx2d.drawImage(video, 0, 0, W, H);
    const px = ctx2d.getImageData(0, 0, W, H).data;
    const hue = new Array(560);
    const sat = new Array(560);
    const lig = new Array(560);
    for (let zy = 0; zy < 20; zy++) {
      for (let zx = 0; zx < 28; zx++) {
        const x = Math.floor(((zx + 0.5) / 28) * W);
        const y = Math.floor(((zy + 0.5) / 20) * H);
        const i = (y * W + x) * 4;
        const [h, sv, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
        const k = zy * 28 + zx;
        hue[k] = Math.round(h);
        sat[k] = Math.round(sv);
        lig[k] = Math.round(l);
      }
    }
    const vision = {};
    for (const m of config.meters || []) {
      if (m.type !== 'linear' && m.type !== 'area') {
        vision[m.name] = -1; // OCR meters are not supported
        continue;
      }
      const x0 = Math.floor(m.x * W);
      const y0 = Math.floor(m.y * H);
      const w = Math.max(1, Math.round(m.width * W));
      const h = m.type === 'area' ? Math.max(1, Math.round(m.height * H)) : 1;
      let hit = 0;
      let all = 0;
      for (let y = y0; y < Math.min(H, y0 + h); y++) {
        for (let x = x0; x < Math.min(W, x0 + w); x++) {
          const i = (y * W + x) * 4;
          const [hh, ss, ll] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
          all++;
          if (inRange(hh, m.h, true) && inRange(ss, m.s) && inRange(ll, m.l)) hit++;
        }
      }
      vision[m.name] = all ? hit / all : 0;
    }
    cf.sendScreen({ zone: { hue, saturation: sat, lightness: lig }, vision });
  }, 66);
}

cf.onConfig(async (c) => {
  const prev = config;
  config = c;
  const need = (c.audio ? 'a' : '') + (c.screen ? 's' : '');
  const had = (prev.audio ? 'a' : '') + (prev.screen ? 's' : '');
  if (need === had && stream) return;
  stopAll();
  if (!need) return;
  try {
    if (c.audio) await startAudio();
    if (c.screen) await startScreen();
  } catch (e) {
    cf.log(`capture failed: ${e.message}`);
    stopAll();
  }
});
