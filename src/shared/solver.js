'use strict';
// Turns LED positions observed by the phone camera into canvas placements.
//
// Input
//   items:   [{ key, size:[w,h], ledPositions:[[gx,gy],...] }]
//   offsets: { itemKey: globalStartIndex }
//   points:  [{ id: globalLedIndex, x, y, cands?: [{ x, y, w }] }] in camera pixels.
//            `cands` are alternative blobs that decoded to the same LED (the real LED
//            plus reflections on a white/reflective case); x,y is the brightest.
// Output
//   { placements: { key: placement }, report: [{ key, detected, rejected, total, error }] }
//
// Per device we run RANSAC over similarity transforms (scale + rotation +
// translation, optionally mirrored): random pairs of LEDs propose a transform,
// and the hypothesis that explains the most LEDs (choosing, for each LED, the
// candidate blob closest to where the device's geometry says it should be) wins.
// Reflections don't fit the device's shape, so they are rejected. The winning
// transform places LEDs the camera missed; LEDs that fit get exact positions.

const { CANVAS_W, CANVAS_H, placementFromTransform } = require('./layout');

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Least-squares similarity fit dst ≈ s R src + t. Returns { s, theta, tx, ty, err }.
function fitSimilarity(src, dst) {
  const n = src.length;
  if (n < 2) return null;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) {
    mx += src[i][0]; my += src[i][1];
    nx += dst[i][0]; ny += dst[i][1];
  }
  mx /= n; my /= n; nx /= n; ny /= n;
  let a = 0, b = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const ux = src[i][0] - mx, uy = src[i][1] - my;
    const vx = dst[i][0] - nx, vy = dst[i][1] - ny;
    a += ux * vx + uy * vy;
    b += ux * vy - uy * vx;
    ss += ux * ux + uy * uy;
  }
  if (ss < 1e-9) return null;
  const theta = Math.atan2(b, a);
  const s = Math.sqrt(a * a + b * b) / ss;
  const c = Math.cos(theta), sn = Math.sin(theta);
  const tx = nx - s * (c * mx - sn * my);
  const ty = ny - s * (sn * mx + c * my);
  let err = 0;
  for (let i = 0; i < n; i++) {
    const p = apply({ s, theta, tx, ty }, src[i]);
    err += (p[0] - dst[i][0]) ** 2 + (p[1] - dst[i][1]) ** 2;
  }
  return { s, theta, tx, ty, err: Math.sqrt(err / n) };
}

function apply(f, p) {
  const c = Math.cos(f.theta), sn = Math.sin(f.theta);
  return [f.s * (c * p[0] - sn * p[1]) + f.tx, f.s * (sn * p[0] + c * p[1]) + f.ty];
}

function nearest(cands, p) {
  let best = null;
  let bd = Infinity;
  for (const c of cands) {
    const d = Math.hypot(c.x - p[0], c.y - p[1]);
    if (d < bd) { bd = d; best = c; }
  }
  return { cand: best, d: bd };
}

// obs: [{ i, src:[x,y], srcFlip:[x,y], cands:[{x,y,w}] }]
function ransacItem(obs, random, typicalSpacing) {
  if (obs.length === 0) return null;
  if (obs.length === 1) return { single: true, inliers: [{ i: obs[0].i, p: [obs[0].cands[0].x, obs[0].cands[0].y] }] };
  const pick = (o) => (random() < 0.7 || o.cands.length === 1 ? o.cands[0] : o.cands[1 + Math.floor(random() * (o.cands.length - 1))]);
  let best = null;
  const iters = Math.min(600, Math.max(60, obs.length * 12));
  for (let it = 0; it < iters; it++) {
    const a = obs[Math.floor(random() * obs.length)];
    let b = obs[Math.floor(random() * obs.length)];
    if (a === b) b = obs[(obs.indexOf(a) + 1) % obs.length];
    const ca = pick(a);
    const cb = pick(b);
    for (const flip of [false, true]) {
      const key = flip ? 'srcFlip' : 'src';
      const f = fitSimilarity([a[key], b[key]], [[ca.x, ca.y], [cb.x, cb.y]]);
      if (!f || !(f.s > 0.3) || f.s > typicalSpacing * 50) continue;
      const thr = Math.max(2, 0.6 * f.s);
      let count = 0;
      let res = 0;
      for (const o of obs) {
        const { d } = nearest(o.cands, apply(f, o[key]));
        if (d < thr) { count++; res += d; }
      }
      if (!best || count > best.count || (count === best.count && res < best.res)) best = { f, flip, count, res };
    }
  }
  if (!best || best.count < 2) {
    // Nothing consistent: fall back to the brightest blob of each LED.
    return { fallback: true, inliers: obs.map((o) => ({ i: o.i, p: [o.cands[0].x, o.cands[0].y] })) };
  }
  // Refine: least squares on inliers, then re-select inliers (twice).
  let f = best.f;
  const key = best.flip ? 'srcFlip' : 'src';
  let inl = [];
  for (let round = 0; round < 3; round++) {
    const thr = Math.max(2, 0.6 * f.s);
    inl = [];
    for (const o of obs) {
      const { cand, d } = nearest(o.cands, apply(f, o[key]));
      if (d < thr) inl.push({ o, p: [cand.x, cand.y] });
    }
    if (inl.length < 2) break;
    const g = fitSimilarity(inl.map((x) => x.o[key]), inl.map((x) => x.p));
    if (!g) break;
    f = g;
  }
  return { f, flip: best.flip, inliers: inl.map((x) => ({ i: x.o.i, p: x.p })), rejected: obs.length - inl.length };
}

function solve({ items, offsets, points, existing, seed }) {
  const placements = {};
  const report = [];
  const random = rng(seed || 12345);
  const byId = new Map();
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const cands = (p.cands && p.cands.length ? p.cands : [{ x: p.x, y: p.y, w: 1 }]).filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y));
    if (cands.length) byId.set(p.id, cands);
  }
  if (!byId.size) return { placements, report, error: 'No LEDs were detected' };

  // Pass 1: robust per-item fits in camera space.
  const fits = [];
  for (const item of items) {
    const start = offsets[item.key];
    if (start === undefined) continue;
    const [w] = item.size;
    const obs = [];
    item.ledPositions.forEach((g, i) => {
      const cands = byId.get(start + i);
      if (!cands) return;
      obs.push({ i, src: [g[0] + 0.5, g[1] + 0.5], srcFlip: [w - (g[0] + 0.5), g[1] + 0.5], cands });
    });
    // rough LED spacing in camera pixels, used to bound absurd hypotheses
    const all = obs.map((o) => o.cands[0]);
    const span = all.length > 1 ? Math.hypot(Math.max(...all.map((c) => c.x)) - Math.min(...all.map((c) => c.x)), Math.max(...all.map((c) => c.y)) - Math.min(...all.map((c) => c.y))) : 100;
    const r = ransacItem(obs, random, Math.max(10, span));
    fits.push({ item, r, total: item.ledPositions.length });
  }

  // Camera -> canvas: fit the inlier LEDs (not reflections) into the canvas with a margin.
  const inlierPts = fits.flatMap((x) => (x.r ? x.r.inliers.map((q) => q.p) : []));
  if (!inlierPts.length) return { placements, report, error: 'No LEDs were detected' };
  const xs = inlierPts.map((p) => p[0]);
  const ys = inlierPts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const margin = 0.06;
  const k = Math.min((CANVAS_W * (1 - 2 * margin)) / Math.max(1e-6, x1 - x0), (CANVAS_H * (1 - 2 * margin)) / Math.max(1e-6, y1 - y0));
  const ox = (CANVAS_W - (x1 - x0) * k) / 2 - x0 * k;
  const oy = (CANVAS_H - (y1 - y0) * k) / 2 - y0 * k;
  const toCanvas = (p) => [p[0] * k + ox, p[1] * k + oy];

  for (const { item, r, total } of fits) {
    if (!r) {
      report.push({ key: item.key, detected: 0, rejected: 0, total });
      continue;
    }
    const [w, h] = item.size;
    const leds = {};
    for (const q of r.inliers) {
      const c = toCanvas(q.p);
      leds[q.i] = [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100];
    }
    let placement;
    let err = 0;
    if (r.f) {
      const s = r.f.s * k;
      const tx = r.f.tx * k + ox;
      const ty = r.f.ty * k + oy;
      err = r.f.err * k;
      if (r.flip) {
        // canvas = s R (w - gx, gy) + t  ==  centre + s R F (g - [w/2,h/2])
        const c = Math.cos(r.f.theta), sn = Math.sin(r.f.theta);
        const cx = s * (c * (w / 2) - sn * (h / 2)) + tx;
        const cy = s * (sn * (w / 2) + c * (h / 2)) + ty;
        placement = { x: cx - (w * s) / 2, y: cy - (h * s) / 2, scale: s, rotation: (r.f.theta * 180) / Math.PI, flip: true };
      } else {
        placement = placementFromTransform(w, h, s, r.f.theta, false, tx, ty);
      }
    } else {
      // Single LED (or nothing consistent): keep scale/rotation, centre on the observations.
      const prev = (existing && existing[item.key]) || { scale: 10, rotation: 0, flip: false };
      const s = prev.scale || 10;
      const pts = Object.values(leds);
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      placement = { x: cx - (w * s) / 2, y: cy - (h * s) / 2, scale: s, rotation: prev.rotation || 0, flip: !!prev.flip };
    }
    placement.leds = leds;
    placements[item.key] = placement;
    report.push({ key: item.key, detected: r.inliers.length, rejected: r.rejected || 0, total, error: Math.round(err * 100) / 100 });
  }
  // Transform mapping a camera-space point to the canvas: canvas = cam*k + (ox,oy).
  // Used to place a reference photo of the case behind the layout.
  return { placements, report, scale: k, camera: { k, ox, oy } };
}

module.exports = { solve, fitSimilarity, ransacItem };
