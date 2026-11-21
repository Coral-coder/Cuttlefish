'use strict';
// Minimal OpenRGB SDK client (protocol version 3). Lets Cuttlefish drive any
// device an OpenRGB server already supports, alongside native plugins.

const net = require('net');
const { EventEmitter } = require('events');

const PKT = {
  REQUEST_CONTROLLER_COUNT: 0,
  REQUEST_CONTROLLER_DATA: 1,
  REQUEST_PROTOCOL_VERSION: 40,
  SET_CLIENT_NAME: 50,
  DEVICE_LIST_UPDATED: 100,
  UPDATELEDS: 1050,
  SETCUSTOMMODE: 1100,
};
const PROTOCOL = 3;
const DEVICE_TYPES = ['motherboard', 'dram', 'gpu', 'cooler', 'ledstrip', 'keyboard', 'mouse', 'mousemat', 'headset',
  'headset_stand', 'gamepad', 'light', 'speaker', 'virtual', 'storage', 'case', 'microphone', 'accessory', 'keypad', 'laptop', 'monitor'];

function header(dev, id, size) {
  const b = Buffer.alloc(16);
  b.write('ORGB', 0, 'ascii');
  b.writeUInt32LE(dev, 4);
  b.writeUInt32LE(id, 8);
  b.writeUInt32LE(size, 12);
  return b;
}

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  str() {
    const n = this.u16();
    const s = this.b.toString('utf8', this.o, this.o + Math.max(0, n - 1));
    this.o += n;
    return s;
  }
}

function parseController(buf, proto = PROTOCOL) {
  const r = new Reader(buf);
  r.u32(); // data size
  const c = { type: DEVICE_TYPES[r.i32()] || 'unknown' };
  c.name = r.str();
  if (proto >= 1) c.vendor = r.str();
  c.description = r.str();
  c.version = r.str();
  c.serial = r.str();
  c.location = r.str();
  const numModes = r.u16();
  c.activeMode = r.i32();
  c.modes = [];
  for (let i = 0; i < numModes; i++) {
    const m = { name: r.str(), value: r.i32(), flags: r.u32(), speedMin: r.u32(), speedMax: r.u32() };
    if (proto >= 3) { m.brightnessMin = r.u32(); m.brightnessMax = r.u32(); }
    m.colorsMin = r.u32(); m.colorsMax = r.u32(); m.speed = r.u32();
    if (proto >= 3) m.brightness = r.u32();
    m.direction = r.u32(); m.colorMode = r.u32();
    const nc = r.u16();
    m.colors = [];
    for (let k = 0; k < nc; k++) m.colors.push(r.u32());
    c.modes.push(m);
  }
  const numZones = r.u16();
  c.zones = [];
  for (let i = 0; i < numZones; i++) {
    const z = { name: r.str(), type: r.i32(), ledsMin: r.u32(), ledsMax: r.u32(), ledsCount: r.u32() };
    const matrixLen = r.u16();
    if (matrixLen > 0) {
      z.matrix = { height: r.u32(), width: r.u32(), map: [] };
      for (let k = 0; k < z.matrix.height * z.matrix.width; k++) z.matrix.map.push(r.u32());
    }
    if (proto >= 4) {
      const ns = r.u16();
      for (let k = 0; k < ns; k++) { r.str(); r.i32(); r.u32(); r.u32(); }
    }
    if (proto >= 5) r.u32();
    c.zones.push(z);
  }
  const numLeds = r.u16();
  c.leds = [];
  for (let i = 0; i < numLeds; i++) c.leds.push({ name: r.str(), value: r.u32() });
  return c;
}

// Build layout items (one per zone) from a parsed controller.
function controllerItems(c, keyBase) {
  const items = [];
  let ledStart = 0;
  c.zones.forEach((z, zi) => {
    const n = z.ledsCount;
    if (!n) return;
    let size;
    let positions;
    let ledIndex; // zone-local LED index for each position
    if (z.matrix && z.matrix.width && z.matrix.height) {
      size = [z.matrix.width, z.matrix.height];
      positions = [];
      ledIndex = [];
      for (let y = 0; y < z.matrix.height; y++) {
        for (let x = 0; x < z.matrix.width; x++) {
          const v = z.matrix.map[y * z.matrix.width + x];
          if (v !== 0xffffffff && v < n) {
            positions.push([x, y]);
            ledIndex.push(v);
          }
        }
      }
    } else {
      const vertical = c.type === 'dram';
      size = vertical ? [1, n] : [n, 1];
      positions = Array.from({ length: n }, (_, i) => (vertical ? [0, n - 1 - i] : [i, 0]));
      ledIndex = Array.from({ length: n }, (_, i) => i);
    }
    items.push({
      key: `${keyBase}#z${zi}`,
      name: c.zones.length > 1 ? `${c.name} — ${z.name}` : c.name,
      size,
      ledNames: ledIndex.map((i) => (c.leds[ledStart + i] ? c.leds[ledStart + i].name : `LED ${i + 1}`)),
      ledPositions: positions,
      ledStart,
      ledIndex,
      zoneLeds: n,
    });
    ledStart += n;
  });
  return items;
}

class OpenRGBClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 6742, name = 'Cuttlefish' } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.name = name;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.controllers = [];
    this.connected = false;
    this.lastSent = new Map();
  }

  connect(timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const t = setTimeout(() => { s.destroy(); reject(new Error('OpenRGB connection timed out')); }, timeoutMs);
      s.once('connect', () => { clearTimeout(t); this.connected = true; resolve(); });
      s.once('error', (e) => { clearTimeout(t); this.connected = false; reject(e); });
      s.on('close', () => { this.connected = false; this.emit('close'); });
      s.on('data', (d) => this._onData(d));
      s.setNoDelay(true);
      this.sock = s;
    }).then(async () => {
      const nameBuf = Buffer.from(`${this.name}\0`);
      this._send(0, PKT.SET_CLIENT_NAME, nameBuf);
      const pv = Buffer.alloc(4);
      pv.writeUInt32LE(PROTOCOL);
      this._send(0, PKT.REQUEST_PROTOCOL_VERSION, pv);
      const reply = await this._wait(PKT.REQUEST_PROTOCOL_VERSION, 1000).catch(() => null);
      this.protocol = reply ? Math.min(PROTOCOL, reply.readUInt32LE(0)) : 0;
    });
  }

  _send(dev, id, payload) {
    if (!this.sock || !this.connected) return;
    const p = payload || Buffer.alloc(0);
    this.sock.write(Buffer.concat([header(dev, id, p.length), p]));
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 16) {
      if (this.buf.toString('ascii', 0, 4) !== 'ORGB') {
        this.buf = Buffer.alloc(0);
        return;
      }
      const size = this.buf.readUInt32LE(12);
      if (this.buf.length < 16 + size) return;
      const id = this.buf.readUInt32LE(8);
      const dev = this.buf.readUInt32LE(4);
      const payload = this.buf.subarray(16, 16 + size);
      this.buf = this.buf.subarray(16 + size);
      if (id === PKT.DEVICE_LIST_UPDATED) this.emit('updated');
      const w = this.waiters.findIndex((x) => x.id === id && (x.dev === undefined || x.dev === dev));
      if (w >= 0) {
        const [x] = this.waiters.splice(w, 1);
        clearTimeout(x.t);
        x.resolve(Buffer.from(payload));
      }
    }
  }

  _wait(id, ms, dev) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x.t !== t);
        reject(new Error('OpenRGB timeout'));
      }, ms);
      this.waiters.push({ id, dev, resolve, t });
    });
  }

  async refresh() {
    this._send(0, PKT.REQUEST_CONTROLLER_COUNT);
    const cnt = (await this._wait(PKT.REQUEST_CONTROLLER_COUNT, 2000)).readUInt32LE(0);
    const list = [];
    for (let i = 0; i < cnt; i++) {
      const pv = Buffer.alloc(4);
      pv.writeUInt32LE(this.protocol);
      this._send(i, PKT.REQUEST_CONTROLLER_DATA, pv);
      const data = await this._wait(PKT.REQUEST_CONTROLLER_DATA, 3000, i);
      try {
        const c = parseController(data, this.protocol);
        c.index = i;
        list.push(c);
      } catch (e) {
        this.emit('log', `OpenRGB controller ${i} parse failed: ${e.message}`);
      }
    }
    this.controllers = list;
    return list;
  }

  setCustomMode(index) {
    this._send(index, PKT.SETCUSTOMMODE);
  }

  // colors: Array of [r,g,b] for every LED of controller `index`
  updateLeds(index, colors) {
    const n = colors.length;
    const p = Buffer.alloc(4 + 2 + n * 4);
    p.writeUInt32LE(p.length, 0);
    p.writeUInt16LE(n, 4);
    for (let i = 0; i < n; i++) {
      const c = colors[i];
      p[6 + i * 4] = c[0];
      p[7 + i * 4] = c[1];
      p[8 + i * 4] = c[2];
    }
    const prev = this.lastSent.get(index);
    if (prev && prev.equals(p)) return false;
    this.lastSent.set(index, p);
    this._send(index, PKT.UPDATELEDS, p);
    return true;
  }

  close() {
    if (this.sock) this.sock.destroy();
    this.connected = false;
  }
}

module.exports = { OpenRGBClient, parseController, controllerItems, PKT, header };
