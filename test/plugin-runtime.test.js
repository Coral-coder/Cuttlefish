'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PluginModule, PluginInstance, transformSource } = require('../src/devicehost/plugin-runtime');

const SRC = `
export function Name() { return "Test Keyboard"; }
export function VendorId() { return 0x1234; }
export function ProductId() { return [0x0001, 0x0002]; }
export function Publisher() { return "test"; }
export function Size() { return [3, 1]; }
export function DefaultPosition() { return [10, 10]; }
export function DefaultScale() { return 8; }
export function ControllableParameters() {
  return [
    {"property":"LightingMode", "label":"Lighting Mode", "type":"combobox", "values":["Canvas","Forced"], "default":"Canvas"},
    {"property":"forcedColor", "label":"Forced", "type":"color", "default":"#ff0000"},
    {"property":"turbo", "label":"Turbo", "type":"boolean", "default":"false"},
  ];
}
const vLedNames = ["A", "B", "C"];
const vLedPositions = [[0,0],[1,0],[2,0]];
export function LedNames() { return vLedNames; }
export function LedPositions() { return vLedPositions; }
export function Validate(endpoint) { return endpoint.interface === 1 && endpoint.usage_page === 0xff00; }
export function Initialize() { device.setName("Renamed"); device.addChannel("Strip", 60, 5); device.write([0x00, 0x01], 65); }
export function Render() {
  const out = [0x00, turbo ? 1 : 0];
  for (const p of vLedPositions) {
    const c = LightingMode === "Forced" ? hexToRgb(forcedColor) : device.color(p[0], p[1]);
    out.push(...c);
  }
  const ch = device.channel("Strip").getColors("Seperate");
  out.push(ch[0].length);
  device.write(out, 65);
}
export function ontrubo() {}
export function onturboChanged() { device.log("turbo changed " + turbo); }
export function Shutdown() { device.write([0x00, 0xff], 65); }
`;

function fakeHost() {
  return {
    sample: (key, x, y) => [x * 10, y * 10 + 1, key.length],
    brightness: () => 1,
    paramValue: () => undefined,
    channelCount: () => undefined,
    pause: () => {},
    log: () => {},
  };
}

test('transformSource strips export keywords and collects exports', () => {
  const out = transformSource('export function A(){}\nexport const B = 1;\nexport class C {}');
  assert.ok(!/export/.test(out.split(';globalThis.__cfExports')[0]));
  assert.ok(out.includes('"A"') && out.includes('"B"') && out.includes('"C"'));
});

test('plugin metadata and validation', () => {
  const m = new PluginModule('test.js', SRC);
  assert.strictEqual(m.meta.name, 'Test Keyboard');
  assert.deepStrictEqual(m.meta.vendorIds, [0x1234]);
  assert.ok(m.matches(0x1234, 2));
  assert.ok(!m.matches(0x1234, 3));
  const eps = [{ interface: 0, usage: 6, usage_page: 1 }, { interface: 1, usage: 1, usage_page: 0xff00 }];
  assert.deepStrictEqual(m.validate(eps), [eps[1]]);
});

test('plugin instance renders canvas colours through device.write', () => {
  const m = new PluginModule('test.js', SRC);
  const writes = [];
  const hid = { write: (d, l) => writes.push({ d, l }), sendFeature() {}, read: () => [], getFeature: () => [], clearReadBuffer() {}, setEndpoint() {}, close() {} };
  const inst = new PluginInstance(m, { kind: 'hid', vendorId: 0x1234, productId: 1, endpoints: [], hid }, fakeHost(), 'hid:1234:0001');
  inst.initialize();
  assert.strictEqual(inst.name, 'Renamed');
  inst.render();
  const last = writes[writes.length - 1].d;
  assert.strictEqual(last[1], 0, 'boolean default "false" must be falsy');
  assert.deepStrictEqual([...last.slice(2, 5)], [0, 1, 13]);
  assert.strictEqual(last[last.length - 1], 5, 'channel default LED count');
  const items = inst.items();
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[1].key, 'hid:1234:0001#ch:Strip');
  inst.setParam('turbo', true);
  inst.setParam('LightingMode', 'Forced');
  inst.render();
  const l2 = writes[writes.length - 1].d;
  assert.strictEqual(l2[1], 1);
  assert.deepStrictEqual([...l2.slice(2, 5)], [255, 0, 0]);
  assert.ok(inst.logs.some((l) => l.includes('turbo changed true')));
  inst.shutdown();
  assert.deepStrictEqual([...writes[writes.length - 1].d], [0x00, 0xff]);
});

test('a plugin stuck in an infinite loop is interrupted', () => {
  const m = new PluginModule('loop.js', 'export function Name(){return "x"} export function VendorId(){return 1} export function Render(){ while(true){} } export function Initialize(){}');
  const host = { ...fakeHost(), callTimeout: 50 };
  const inst = new PluginInstance(m, { kind: 'hid', endpoints: [] }, host, 'k');
  inst.initialize();
  const t = Date.now();
  inst.render();
  assert.ok(Date.now() - t < 1000);
  assert.strictEqual(inst.errorCount, 1);
});
