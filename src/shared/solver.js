'use strict';
// Turns LED positions observed by the phone camera into canvas placements.
//
// Input
//   items:   [{ key, size:[w,h], ledPositions:[[gx,gy],...] }]
//   offsets: { itemKey: globalStartIndex }
//   points:  [{ id: globalLedIndex, x, y }] in camera pixels
//   camera:  { width, height }
// Output
//   { placements: { key: placement }, report: [{ key, detected, total, error }] }
//
// Each item gets a similarity transform (scale + rotation + translation, with
// optional mirror) fitted by least squares (2D Umeyama), so LEDs the camera
// missed are still placed sensibly; LEDs it did see get exact per-LED overrides.

const { CANVAS_W, CANVAS_H, placementFromTransform } = require('./layout');

function percentile(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
}

// Map camera coordinates to the canvas, preserving aspect ratio, with margin.
function cameraToCanvasFn(points, margin = 0.06) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = percentile(xs, 0.0);
  const x1 = percentile(xs, 1.0);
  const y0 = percentile(ys, 0.0);
  const y1 = percentile(ys, 1.0);
  const bw = Math.max(1e-6, x1 - x0);
  const bh = Math.max(1e-6, y1 - y0);
  const k = Math.min((CANVAS_W * (1 - 2 * margin)) / bw, (CANVAS_H * (1 - 2 * margin)) / bh);
  const ox = (CANVAS_W - bw * k) / 2 - x0 * k;
  const oy = (CANVAS_H - bh * k) / 2 - y0 * k;
  return { k, map: (x, y) => [x * k + ox, y * k + oy] };
}

// Least-squares similarity fit dst ≈ s R src + t. Returns { s, theta, tx, ty, err }.
function fitSimilarity(src, dst) {
  const n = src.length;
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
    const px = s * (c * src[i][0] - sn * src[i][1]) + tx;
    const py = s * (sn * src[i][0] + c * src[i][1]) + ty;
    err += (px - dst[i][0]) ** 2 + (py - dst[i][1]) ** 2;
  }
  return { s, theta, tx, ty, err: Math.sqrt(err / n) };
}

function solve({ items, offsets, points, existing }) {
  const placements = {};
  const report = [];
  const valid = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!valid.length) return { placements, report, error: 'No LEDs were detected' };
  const cam = cameraToCanvasFn(valid);
  const byId = new Map();
  for (const p of valid) byId.set(p.id, p);

  for (const item of items) {
    const start = offsets[item.key];
    if (start === undefined) continue;
    const [w, h] = item.size;
    const src = [];
    const srcFlip = [];
    const dst = [];
    const leds = {};
    item.ledPositions.forEach((g, i) => {
      const p = byId.get(start + i);
      if (!p) return;
      const c = cam.map(p.x, p.y);
      // grid cell centres expressed relative to the grid origin (placementFromTransform convention)
      src.push([g[0] + 0.5, g[1] + 0.5]);
      srcFlip.push([w - (g[0] + 0.5), g[1] + 0.5]);
      dst.push(c);
      leds[i] = [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100];
    });
    const total = item.ledPositions.length;
    if (!dst.length) {
      report.push({ key: item.key, detected: 0, total });
      continue;
    }
    let placement = null;
    let err = 0;
    const f1 = fitSimilarity(src, dst);
    const f2 = fitSimilarity(srcFlip, dst);
    if (f1 || f2) {
      const useFlip = f2 && (!f1 || f2.err < f1.err * 0.8);
      const f = useFlip ? f2 : f1;
      err = f.err;
      // src was expressed with origin at grid corner; placementFromTransform wants the
      // transform of grid coordinates relative to that same corner (with flip applied
      // about the vertical centre line) -> for the flipped fit the corner is at x=w.
      if (useFlip) {
        // canvas = s R (w - gx, gy) + t ; rewrite as s R F (gx - w/2, ...) about centre
        placement = placementFromTransform(w, h, f.s, f.theta, true, f.tx + 0, f.ty + 0);
        // placementFromTransform assumes canvas = sR F g + t with F mirroring about the
        // grid centre; mirroring about x=w/2 maps g.x -> w - g.x which is what we fitted.
        const c = Math.cos(f.theta), sn = Math.sin(f.theta);
        const cx = f.s * (c * (w / 2) - sn * (h / 2)) + f.tx;
        const cy = f.s * (sn * (w / 2) + c * (h / 2)) + f.ty;
        placement.x = cx - (w * f.s) / 2;
        placement.y = cy - (h * f.s) / 2;
      } else {
        placement = placementFromTransform(w, h, f.s, f.theta, false, f.tx, f.ty);
      }
    } else {
      // Single LED (or all at one spot): keep scale/rotation, move it there.
      const prev = (existing && existing[item.key]) || { scale: 10, rotation: 0, flip: false };
      const s = prev.scale || 10;
      placement = { x: dst[0][0] - (w * s) / 2, y: dst[0][1] - (h * s) / 2, scale: s, rotation: prev.rotation || 0, flip: !!prev.flip };
    }
    placement.leds = leds;
    placements[item.key] = placement;
    report.push({ key: item.key, detected: dst.length, total, error: Math.round(err * 100) / 100 });
  }
  return { placements, report, scale: cam.k };
}

module.exports = { solve, fitSimilarity, cameraToCanvasFn };
