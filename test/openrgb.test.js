'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { OpenRGBClient, parseController, controllerItems, PKT, header } = require('../src/devicehost/openrgb');

function str(s) {
  const b = Buffer.from(`${s}\0`);
  const l = Buffer.alloc(2);
  l.writeUInt16LE(b.length);
  return Buffer.concat([l, b]);
}
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };

function controllerBlob() {
  const mode = Buffer.concat([str('Direct'), i32(0), u32(1), u32(0), u32(0), u32(0), u32(100), u32(0), u32(0), u32(0), u32(100), u32(0), u32(1), u16(0)]);
  const zoneStrip = Buffer.concat([str('Strip'), i32(1), u32(0), u32(10), u32(3), u16(0)]);
  const matrix = Buffer.concat([u32(2), u32(2), u32(0), u32(1), u32(0xffffffff), u32(2)]);
  const zoneMatrix = Buffer.concat([str('Keys'), i32(2), u32(3), u32(3), u32(3), u16(matrix.length), matrix]);
  const leds = Buffer.concat([u16(6), ...[1, 2, 3, 4, 5, 6].map((i) => Buffer.concat([str(`LED ${i}`), u32(i)]))]);
  const colors = Buffer.concat([u16(6), ...Array(6).fill(u32(0))]);
  const body = Buffer.concat([i32(5), str('Test KB'), str('Vendor'), str('desc'), str('1.0'), str('SN'), str('HID: x'), u16(1), i32(0), mode, u16(2), zoneStrip, zoneMatrix, leds, colors]);
  return Buffer.concat([u32(body.length + 4), body]);
}

test('parses protocol-3 controller data and builds items', () => {
  const c = parseController(controllerBlob(), 3);
  assert.strictEqual(c.name, 'Test KB');
  assert.strictEqual(c.type, 'keyboard');
  assert.strictEqual(c.zones.length, 2);
  assert.strictEqual(c.leds.length, 6);
  const items = controllerItems(c, 'orgb:x');
  assert.strictEqual(items[0].ledPositions.length, 3);
  assert.deepStrictEqual(items[1].size, [2, 2]);
  assert.deepStrictEqual(items[1].ledIndex, [0, 1, 2]);
  assert.strictEqual(items[1].ledStart, 3);
});

test('client talks to an SDK server', async () => {
  const received = [];
  const blob = controllerBlob();
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const size = buf.readUInt32LE(12);
        if (buf.length < 16 + size) break;
        const id = buf.readUInt32LE(8);
        const dev = buf.readUInt32LE(4);
        const payload = buf.subarray(16, 16 + size);
        buf = buf.subarray(16 + size);
        received.push({ id, dev, payload });
        if (id === PKT.REQUEST_PROTOCOL_VERSION) s.write(Buffer.concat([header(0, id, 4), u32(4)]));
        if (id === PKT.REQUEST_CONTROLLER_COUNT) s.write(Buffer.concat([header(0, id, 4), u32(1)]));
        if (id === PKT.REQUEST_CONTROLLER_DATA) s.write(Buffer.concat([header(dev, id, blob.length), blob]));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new OpenRGBClient({ port: server.address().port });
  await client.connect();
  assert.strictEqual(client.protocol, 3);
  const list = await client.refresh();
  assert.strictEqual(list[0].name, 'Test KB');
  assert.ok(client.updateLeds(0, Array(6).fill([1, 2, 3])));
  assert.ok(!client.updateLeds(0, Array(6).fill([1, 2, 3])), 'unchanged frame not resent');
  await new Promise((r) => setTimeout(r, 50));
  const upd = received.find((m) => m.id === PKT.UPDATELEDS);
  assert.ok(upd);
  assert.strictEqual(upd.payload.readUInt16LE(4), 6);
  client.close();
  server.close();
});
