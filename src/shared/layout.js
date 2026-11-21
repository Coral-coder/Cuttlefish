'use strict';
// Geometry shared by the device hosts, the UI and the camera mapping solver.
//
// The effect canvas is CANVAS_W x CANVAS_H pixels (the SignalRGB LightScript size).
// Every layout item (a device, a subdevice or a component channel) has a grid
// of `w` x `h` cells. LED positions are integer cell coordinates in that grid.
// A placement puts the grid on the canvas:
//   x, y      top-left corner of the un-rotated rectangle, in canvas pixels
//   scale     canvas pixels per grid cell
//   rotation  degrees, clockwise, around the rectangle centre
//   flip      mirror the grid horizontally before rotation
//   leds      optional per-LED overrides { [ledIndex]: [canvasX, canvasY] }
//             (written by the camera mapper for LEDs it actually saw)

const CANVAS_W = 320;
const CANVAS_H = 200;

function defaultPlacement(w, h, pos, scale) {
  const s = scale || Math.max(1, Math.min(CANVAS_W / Math.max(1, w), CANVAS_H / Math.max(1, h)) * 0.5);
  return {
    x: pos ? pos[0] : (CANVAS_W - w * s) / 2,
    y: pos ? pos[1] : (CANVAS_H - h * s) / 2,
    scale: s,
    rotation: 0,
    flip: false,
    leds: null,
  };
}

// Grid cell centre -> canvas coordinate.
function gridToCanvas(p, w, h, gx, gy) {
  const s = p.scale;
  const hw = (w * s) / 2;
  const hh = (h * s) / 2;
  let lx = (gx + 0.5) * s - hw;
  const ly = (gy + 0.5) * s - hh;
  if (p.flip) lx = -lx;
  const r = ((p.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  return [p.x + hw + lx * c - ly * sn, p.y + hh + lx * sn + ly * c];
}

// Inverse of the similarity part of gridToCanvas, used when the solver hands us
// a fitted transform canvas = s * R(theta) * F * g + t  (g = cell centre).
function placementFromTransform(w, h, s, thetaRad, flip, tx, ty) {
  // centre of grid in grid coords:
  const gcx = w / 2;
  const gcy = h / 2;
  const c = Math.cos(thetaRad);
  const sn = Math.sin(thetaRad);
  const fx = flip ? -gcx : gcx;
  const cx = tx + s * (fx * c - gcy * sn);
  const cy = ty + s * (fx * sn + gcy * c);
  return {
    x: cx - (w * s) / 2,
    y: cy - (h * s) / 2,
    scale: s,
    rotation: (thetaRad * 180) / Math.PI,
    flip: !!flip,
    leds: null,
  };
}

// Bilinear sample of a BGRA frame. Returns [r, g, b].
function sampleBGRA(frame, fw, fh, x, y) {
  if (!frame) return [0, 0, 0];
  x -= 0.5;
  y -= 0.5;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x > fw - 1) x = fw - 1;
  if (y > fh - 1) y = fh - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(fw - 1, x0 + 1);
  const y1 = Math.min(fh - 1, y0 + 1);
  const ax = x - x0;
  const ay = y - y0;
  const i00 = (y0 * fw + x0) * 4;
  const i10 = (y0 * fw + x1) * 4;
  const i01 = (y1 * fw + x0) * 4;
  const i11 = (y1 * fw + x1) * 4;
  const out = [0, 0, 0];
  // BGRA -> RGB
  for (let ch = 0; ch < 3; ch++) {
    const src = 2 - ch;
    const top = frame[i00 + src] * (1 - ax) + frame[i10 + src] * ax;
    const bot = frame[i01 + src] * (1 - ax) + frame[i11 + src] * ax;
    out[ch] = Math.round(top * (1 - ay) + bot * ay);
  }
  return out;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(String(hex || ''));
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

// Reflected binary Gray code helpers used by the structured-light mapper.
function toGray(n) {
  return n ^ (n >>> 1);
}
function fromGray(g) {
  let n = g;
  for (let shift = 1; shift < 32; shift <<= 1) n ^= n >>> shift;
  return n;
}
function bitsFor(count) {
  let b = 1;
  while (1 << b < count) b++;
  return b;
}

// Colour shown on LED `index` (global index) for a mapping pattern.
// pattern: { kind: 'off' | 'full' | 'bit' | 'single' | 'device', bit, inv, index,
//            level (0-255, default 255), mod + phase (sparse: only ids with id % mod === phase light) }
function mappingColor(pattern, index) {
  if (!pattern) return [0, 0, 0];
  const v = pattern.level === undefined ? 255 : Math.max(0, Math.min(255, pattern.level | 0));
  const W = [v, v, v];
  const K = [0, 0, 0];
  if (pattern.mod > 1 && index % pattern.mod !== pattern.phase) return K;
  switch (pattern.kind) {
    case 'full':
      return W;
    case 'single':
      return index === pattern.index ? W : K;
    case 'device':
      return index >= pattern.start && index < pattern.end ? W : K;
    case 'bit': {
      const on = ((toGray(index) >>> pattern.bit) & 1) === 1;
      return on !== !!pattern.inv ? W : K;
    }
    default:
      return K;
  }
}

const api = {
  CANVAS_W,
  CANVAS_H,
  defaultPlacement,
  gridToCanvas,
  placementFromTransform,
  sampleBGRA,
  hexToRgb,
  toGray,
  fromGray,
  bitsFor,
  mappingColor,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else if (typeof window !== 'undefined') window.CFLayout = api;
