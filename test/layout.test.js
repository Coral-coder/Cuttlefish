'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shared/layout');

test('gridToCanvas places cell centres inside the rectangle', () => {
  const p = { x: 10, y: 20, scale: 10, rotation: 0, flip: false };
  assert.deepStrictEqual(L.gridToCanvas(p, 3, 2, 0, 0), [15, 25]);
  assert.deepStrictEqual(L.gridToCanvas(p, 3, 2, 2, 1), [35, 35]);
});

test('rotation by 180 swaps corners, flip mirrors', () => {
  const p = { x: 0, y: 0, scale: 10, rotation: 180, flip: false };
  const a = L.gridToCanvas(p, 2, 1, 0, 0);
  assert.ok(Math.abs(a[0] - 15) < 1e-9 && Math.abs(a[1] - 5) < 1e-9);
  const f = L.gridToCanvas({ ...p, rotation: 0, flip: true }, 2, 1, 0, 0);
  assert.ok(Math.abs(f[0] - 15) < 1e-9);
});

test('placementFromTransform agrees with gridToCanvas', () => {
  const w = 5, h = 3, s = 7, th = 0.6, tx = 50, ty = 40;
  const p = L.placementFromTransform(w, h, s, th, false, tx, ty);
  for (const [gx, gy] of [[0, 0], [4, 2], [2, 1]]) {
    const u = gx + 0.5, v = gy + 0.5;
    const ex = s * (Math.cos(th) * u - Math.sin(th) * v) + tx;
    const ey = s * (Math.sin(th) * u + Math.cos(th) * v) + ty;
    const got = L.gridToCanvas(p, w, h, gx, gy);
    assert.ok(Math.abs(got[0] - ex) < 1e-6 && Math.abs(got[1] - ey) < 1e-6);
  }
});

test('gray code round trips and mapping colours decode', () => {
  for (let i = 0; i < 2000; i++) assert.strictEqual(L.fromGray(L.toGray(i)), i);
  const bits = L.bitsFor(700);
  for (const id of [0, 1, 5, 333, 699]) {
    let code = 0;
    for (let b = 0; b < bits; b++) {
      const on = L.mappingColor({ kind: 'bit', bit: b, inv: false }, id)[0] > 0;
      const off = L.mappingColor({ kind: 'bit', bit: b, inv: true }, id)[0] > 0;
      assert.notStrictEqual(on, off);
      if (on) code |= 1 << b;
    }
    assert.strictEqual(L.fromGray(code), id);
  }
});

test('sampleBGRA reads RGB from BGRA', () => {
  const f = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) { f[i * 4] = 30; f[i * 4 + 1] = 20; f[i * 4 + 2] = 10; f[i * 4 + 3] = 255; }
  assert.deepStrictEqual(L.sampleBGRA(f, 4, 4, 2, 2), [10, 20, 30]);
});
