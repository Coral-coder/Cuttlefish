'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/shared/layout');
const { solve } = require('../src/shared/solver');

function strip(n) {
  return Array.from({ length: n }, (_, i) => [i, 0]);
}

test('solver recovers relative placement of devices from camera points', () => {
  const items = [
    { key: 'a', name: 'strip', size: [10, 1], ledPositions: strip(10) },
    { key: 'b', name: 'ram', size: [1, 12], ledPositions: Array.from({ length: 12 }, (_, i) => [0, 11 - i]) },
    { key: 'c', name: 'fan', size: [4, 4], ledPositions: [[0, 0], [3, 0], [3, 3], [0, 3], [1, 1]] },
  ];
  const truth = {
    a: { x: 30, y: 150, scale: 20, rotation: 0, flip: false },
    b: { x: 200, y: 20, scale: 9, rotation: 0, flip: false },
    c: { x: 120, y: 40, scale: 12, rotation: 30, flip: true },
  };
  const offsets = { a: 0, b: 10, c: 22 };
  // Camera sees the canvas scaled by 2.5 and shifted.
  const points = [];
  for (const it of items) {
    it.ledPositions.forEach((g, i) => {
      const [x, y] = L.gridToCanvas(truth[it.key], it.size[0], it.size[1], g[0], g[1]);
      points.push({ id: offsets[it.key] + i, x: x * 2.5 + 100, y: y * 2.5 + 60 });
    });
  }
  const res = solve({ items, offsets, points });
  // relative geometry must be preserved: compare distances between LEDs after mapping
  const pos = (key, i) => {
    const it = items.find((x) => x.key === key);
    const p = res.placements[key];
    return L.gridToCanvas({ ...p, leds: null }, it.size[0], it.size[1], it.ledPositions[i][0], it.ledPositions[i][1]);
  };
  const tpos = (key, i) => {
    const it = items.find((x) => x.key === key);
    return L.gridToCanvas(truth[key], it.size[0], it.size[1], it.ledPositions[i][0], it.ledPositions[i][1]);
  };
  const k = res.scale * 2.5; // canvas units per truth unit
  const pairs = [['a', 0, 'b', 3], ['a', 9, 'c', 2], ['b', 11, 'c', 4], ['c', 0, 'c', 2]];
  for (const [k1, i1, k2, i2] of pairs) {
    const d1 = Math.hypot(...pos(k1, i1).map((v, j) => v - pos(k2, i2)[j]));
    const d2 = Math.hypot(...tpos(k1, i1).map((v, j) => v - tpos(k2, i2)[j])) * k;
    assert.ok(Math.abs(d1 - d2) < 0.5, `${k1}${i1}-${k2}${i2}: ${d1} vs ${d2}`);
  }
  assert.strictEqual(res.placements.c.flip, true);
  for (const r of res.report) assert.ok(r.error < 0.01, `fit error ${r.error}`);
});

test('solver handles partially visible devices', () => {
  const items = [{ key: 'a', size: [10, 1], ledPositions: strip(10) }];
  const points = [0, 1, 2].map((i) => ({ id: i, x: 10 + i * 5, y: 50 }));
  const res = solve({ items, offsets: { a: 0 }, points });
  const p = res.placements.a;
  assert.strictEqual(Object.keys(p.leds).length, 3);
  assert.ok(Math.abs(p.rotation) < 1e-6 || Math.abs(Math.abs(p.rotation) - 180) < 1e-6);
});

test('solver rejects reflections on a white case', () => {
  const items = [
    { key: 'strip', size: [20, 1], ledPositions: strip(20) },
    { key: 'ram', size: [1, 12], ledPositions: Array.from({ length: 12 }, (_, i) => [0, 11 - i]) },
  ];
  const offsets = { strip: 0, ram: 20 };
  const truthCam = (id) => (id < 20 ? [100 + id * 15, 400] : [500, 380 - (id - 20) * 14]);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const points = [];
  for (let id = 0; id < 32; id++) {
    const [x, y] = truthCam(id);
    const cands = [{ x, y, w: 1 }];
    // a mirror reflection on the case floor/wall, sometimes BRIGHTER than the LED
    cands.push({ x: x + 40 * (rand() - 0.5), y: 760 - y, w: rand() < 0.4 ? 2 : 0.5 });
    // random glow blob on the white panel
    if (rand() < 0.5) cands.push({ x: rand() * 800, y: rand() * 600, w: 0.4 });
    cands.sort((a, b) => b.w - a.w);
    points.push({ id, x: cands[0].x, y: cands[0].y, cands });
  }
  const res = solve({ items, offsets, points });
  for (const r of res.report) assert.ok(r.detected >= r.total - 1, `${r.key}: ${r.detected}/${r.total}`);
  // every accepted LED override must be the real LED, not a reflection
  const k = res.scale;
  for (const it of items) {
    const p = res.placements[it.key];
    for (const [i, pt] of Object.entries(p.leds)) {
      const id = offsets[it.key] + Number(i);
      const t = truthCam(id);
      const ref = truthCam(offsets.strip === 0 && id < 20 ? 0 : 20);
      const refPt = res.placements[id < 20 ? 'strip' : 'ram'].leds[0];
      if (!refPt) continue;
      const dExp = Math.hypot(t[0] - ref[0], t[1] - ref[1]) * k;
      const dGot = Math.hypot(pt[0] - refPt[0], pt[1] - refPt[1]);
      assert.ok(Math.abs(dExp - dGot) < 1, `${it.key}[${i}] off by ${Math.abs(dExp - dGot)}`);
    }
    assert.strictEqual(Math.round(Math.abs(p.rotation) % 180), it.key === 'strip' ? 0 : 0);
  }
});
