'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MockBus } = require('../src/devicehost/smbus');
const { FuryController, PROFILES } = require('../src/devicehost/fury');

function furyStick(model) {
  const regs = {};
  let inTx = false;
  return {
    regs,
    onWrite(reg, val) { if (reg === 0x08) inTx = val === 0x53; },
    readWord(reg) {
      if (inTx && reg >= 1 && reg <= 4) return 'FURY'.charCodeAt(reg - 1) << 8 | 0x5a;
      if (reg === 0x06) return (model << 8) | 0x5a;
      return ((regs[reg] || 0) << 8) | 0x5a;
    },
  };
}

function makeBus(slots, ddr = 5) {
  const devices = {};
  for (const s of slots) {
    devices[0x50 + s] = { regs: ddr === 5 ? { 0: 0x51 } : { 2: 0x0c } };
    devices[(ddr === 5 ? 0x60 : 0x58) + s] = furyStick(ddr === 5 ? 0x10 : 0x23);
  }
  return new MockBus(devices);
}

test('detects FURY DDR5 sticks by signature', () => {
  const bus = makeBus([0, 2]);
  const sticks = FuryController.detect(bus);
  assert.strictEqual(sticks.length, 2);
  assert.deepStrictEqual(sticks.map((s) => s.addr), [0x60, 0x62]);
  assert.strictEqual(sticks[0].ddr, 5);
});

test('detects DDR4 sticks and uses 10 LEDs', () => {
  const bus = makeBus([1], 4);
  const sticks = FuryController.detect(bus);
  assert.strictEqual(sticks[0].addr, 0x59);
  const c = new FuryController(bus, sticks, { profile: 'balanced', custom: { beginDelay: 0, endDelay: 0 } });
  assert.strictEqual(c.ledsPerStick, 10);
});

test('never writes to SPD addresses', () => {
  const bus = makeBus([0, 1, 2, 3]);
  const sticks = FuryController.detect(bus);
  const c = new FuryController(bus, sticks, { custom: { beginDelay: 0, endDelay: 0 } });
  c.render(sticks.map(() => Array(12).fill([1, 2, 3])));
  assert.ok(bus.writes.every(([addr]) => addr >= 0x60), 'only RGB controller addresses written');
});

test('delta + batched writes: unchanged frames cost only begin/apply', () => {
  const bus = makeBus([0, 1]);
  const sticks = FuryController.detect(bus);
  const c = new FuryController(bus, sticks, { custom: { beginDelay: 0, endDelay: 0 } });
  const frame = sticks.map(() => Array.from({ length: 12 }, (_, i) => [i, 2 * i, 3 * i]));
  c.render(frame);
  const after1 = bus.writes.length;
  c.render(frame);
  assert.strictEqual(bus.writes.length, after1, 'identical frame writes nothing');
  frame[0][5] = [200, 10, 15];
  c.render(frame);
  // begin x2 sticks + 1 changed colour register (red) + apply x2
  assert.strictEqual(bus.writes.length - after1, 2 + 1 + 2);
  assert.strictEqual(bus.devices[0x60].regs[0x50 + 15], 200);
});

test('write budget sends the most visible changes first and converges', () => {
  const bus = makeBus([0]);
  const sticks = FuryController.detect(bus);
  const c = new FuryController(bus, sticks, { profile: 'turbo', custom: { beginDelay: 0, endDelay: 0, budget: 6 } });
  c.render([Array(12).fill([0, 0, 0])]);
  // Let the budgeted renders converge to black first.
  for (let i = 0; i < 10; i++) c.render([Array(12).fill([0, 0, 0])]);
  const target = Array.from({ length: 12 }, (_, i) => (i === 3 ? [255, 255, 255] : [5, 0, 0]));
  bus.writes.length = 0;
  c.render([target]);
  const colourWrites = bus.writes.filter(([, reg]) => reg >= 0x50);
  assert.strictEqual(colourWrites.length, 6);
  assert.ok(colourWrites.slice(0, 3).every(([, reg]) => reg >= 0x50 + 9 && reg <= 0x50 + 11), 'brightest change first');
  for (let i = 0; i < 10; i++) c.render([target]);
  for (let i = 0; i < 12; i++) assert.deepStrictEqual([0, 1, 2].map((k) => bus.devices[0x60].regs[0x50 + i * 3 + k]), target[i]);
});

test('profiles exist', () => {
  assert.ok(PROFILES.safe.beginDelay > PROFILES.turbo.beginDelay);
});
