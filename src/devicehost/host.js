'use strict';
// Device host: runs in an Electron utility process (or a plain Node child for
// tests). One instance drives USB/HID + OpenRGB devices, a second instance
// drives SMBus devices so slow memory transactions never stall the USB loop.

const path = require('path');
const { PluginInstance, loadPlugins, sleepSync } = require('./plugin-runtime');
const hid = require('./hid-backend');
const { OpenRGBClient, controllerItems } = require('./openrgb');
const { FuryController } = require('./fury');
const smbus = require('./smbus');
const L = require('../shared/layout');

const port = process.parentPort || {
  postMessage: (m) => process.send && process.send(m),
  on: (ev, fn) => process.on('message', (m) => fn({ data: m })),
};

const role = process.argv.includes('--role=smbus') ? 'smbus' : 'usb';

const state = {
  config: {
    pluginDirs: [],
    placements: {},
    params: {},
    enabled: {},
    brightness: 1,
    deviceBrightness: {},
    channelCounts: {},
    fps: 60,
    openrgb: { enabled: false, host: '127.0.0.1', port: 6742 },
    fury: { enabled: true, profile: 'balanced' },
    smbusPlugins: false,
    motherboard: '',
    pawnioDir: '',
  },
  frame: null,
  fw: L.CANVAS_W,
  fh: L.CANVAS_H,
  mapping: null, // { pattern, offsets: { itemKey: start } }
  identify: null, // { key, until }
  devices: new Map(), // key -> wrapper
  items: new Map(), // itemKey -> { item, posMap, owner }
  modules: [],
  buses: [],
  smbusError: null,
  running: true,
  lastPublish: 0,
  dirty: true,
};

function log(msg) {
  port.postMessage({ type: 'log', role, msg: String(msg), t: Date.now() });
}

// ------------------------------------------------------------- colour access
function itemEntry(key) {
  return state.items.get(key);
}

function brightnessFor(deviceKey) {
  const b = state.config.deviceBrightness[deviceKey];
  return state.config.brightness * (b === undefined ? 1 : b);
}

function sample(itemKey, gx, gy, brightness) {
  const e = itemEntry(itemKey);
  if (!e) return [0, 0, 0];
  const idx = e.posMap.get(`${gx},${gy}`);
  if (state.identify && Date.now() < state.identify.until) {
    const on = state.identify.key === itemKey || state.identify.key === e.owner;
    const blink = Math.floor(Date.now() / 250) % 2 === 0;
    return on && blink ? [255, 255, 255] : [0, 0, 0];
  }
  if (state.mapping) {
    const start = state.mapping.offsets[itemKey];
    if (start === undefined || idx === undefined) return [0, 0, 0];
    return L.mappingColor(state.mapping.pattern, start + idx);
  }
  if (state.config.enabled[e.owner] === false || state.config.enabled[itemKey] === false) return [0, 0, 0];
  const p = state.config.placements[itemKey] || e.defaultPlacement;
  let pt;
  if (p.leds && idx !== undefined && p.leds[idx]) pt = p.leds[idx];
  else pt = L.gridToCanvas(p, e.item.size[0], e.item.size[1], gx, gy);
  const c = L.sampleBGRA(state.frame, state.fw, state.fh, pt[0], pt[1]);
  const b = brightness === undefined ? 1 : brightness;
  if (b !== 1) {
    c[0] = Math.round(c[0] * b);
    c[1] = Math.round(c[1] * b);
    c[2] = Math.round(c[2] * b);
  }
  return c;
}

const hostApi = {
  sample,
  brightness: brightnessFor,
  paramValue: (key, prop) => (state.config.params[key] || {})[prop],
  channelCount: (key, ch) => (state.config.channelCounts[key] || {})[ch],
  log,
  get motherboardName() { return state.config.motherboard; },
  callTimeout: 3000,
};

function rebuildItems() {
  state.items.clear();
  for (const dev of state.devices.values()) {
    for (const item of dev.items()) {
      const posMap = new Map();
      item.ledPositions.forEach((p, i) => {
        const k = `${p[0]},${p[1]}`;
        if (!posMap.has(k)) posMap.set(k, i);
      });
      const w = item.size[0] || 1;
      const h = item.size[1] || 1;
      state.items.set(item.key, {
        item,
        posMap,
        owner: dev.key,
        defaultPlacement: L.defaultPlacement(w, h, item.defaultPosition, item.defaultScale),
      });
    }
  }
  state.dirty = true;
}

// ------------------------------------------------------------ device wrappers
class PluginDevice {
  constructor(inst, io, extra) {
    this.inst = inst;
    this.io = io;
    this.key = inst.key;
    this.extra = extra || {};
    this.stats = { fps: 0, ms: 0 };
  }
  items() { return this.inst.items(); }
  render() { this.inst.render(); }
  shutdown(s) { this.inst.shutdown(s); }
  setParam(n, v) { this.inst.setParam(n, v); }
  get changed() { return this.inst.changed; }
  set changed(v) { this.inst.changed = v; }
  describe() {
    const io = this.io.hid || {};
    return { ...this.inst.describe(), ...this.extra, stats: this.stats,
      usb: { writes: io.writes || 0, errors: io.errors || 0, lastError: io.lastError || null } };
  }
  close() { if (this.io.hid) this.io.hid.close(); }
}

class FuryDevice {
  constructor(bus, sticks) {
    this.bus = bus;
    this.ctrl = new FuryController(bus, sticks, { profile: state.config.fury.profile });
    this.key = `fury:${bus.name}`;
    this.changed = true;
    this.stats = { fps: 0, ms: 0 };
  }
  items() {
    const n = this.ctrl.ledsPerStick;
    return this.ctrl.sticks.map((s) => ({
      key: `${this.key}#dimm${s.slot}`,
      name: `Kingston ${s.name} (slot ${s.slot + 1})`,
      size: [1, n],
      ledNames: Array.from({ length: n }, (_, i) => `LED ${i + 1}`),
      ledPositions: Array.from({ length: n }, (_, i) => [0, n - 1 - i]),
      defaultPosition: [150 + s.slot * 14, 40],
      defaultScale: 10,
      parent: this.key,
    }));
  }
  render() {
    const b = brightnessFor(this.key);
    const n = this.ctrl.ledsPerStick;
    const colors = this.ctrl.sticks.map((s) => {
      const key = `${this.key}#dimm${s.slot}`;
      return Array.from({ length: n }, (_, i) => sample(key, 0, n - 1 - i, b));
    });
    this.ctrl.render(colors);
  }
  shutdown() { try { this.ctrl.fill([0, 0, 0]); } catch { /* ignore */ } this.ctrl.ready = false; }
  setParam(name, v) {
    if (name === 'profile') this.ctrl.setProfile(String(v));
  }
  describe() {
    return {
      key: this.key,
      name: `Kingston FURY RGB memory (${this.ctrl.sticks.length} module${this.ctrl.sticks.length > 1 ? 's' : ''})`,
      plugin: 'native: Kingston FURY (Cuttlefish)',
      backend: `smbus:${this.bus.name}`,
      params: [{ property: 'profile', label: 'Speed profile', type: 'combobox', values: ['safe', 'balanced', 'turbo'], default: 'balanced' }],
      paramValues: { profile: this.ctrl.profileName },
      furyStats: { ...this.ctrl.stats, profile: this.ctrl.profile },
      sticks: this.ctrl.sticks,
      items: this.items(),
      stats: this.stats,
      alerts: [], messages: [],
    };
  }
  close() {}
}

class OpenRGBDevice {
  constructor(client, c) {
    this.client = client;
    this.c = c;
    this.key = `orgb:${c.name}:${c.location || c.serial || c.index}`;
    this._items = controllerItems(c, this.key);
    this.changed = true;
    this.stats = { fps: 0, ms: 0 };
    this.total = c.leds.length;
    client.setCustomMode(c.index);
  }
  items() { return this._items; }
  render() {
    const colors = new Array(this.total).fill(null).map(() => [0, 0, 0]);
    const b = brightnessFor(this.key);
    for (const it of this._items) {
      it.ledPositions.forEach((p, j) => {
        const led = it.ledStart + it.ledIndex[j];
        if (led < colors.length) colors[led] = sample(it.key, p[0], p[1], b);
      });
    }
    this.client.updateLeds(this.c.index, colors);
  }
  shutdown() {}
  describe() {
    return { key: this.key, name: this.c.name, plugin: 'OpenRGB SDK', backend: 'openrgb', vendor: this.c.vendor,
      type: this.c.type, items: this._items, params: [], alerts: [], messages: [], stats: this.stats };
  }
  close() {}
}

// Simulated hardware for demos and end-to-end tests (CF_VIRTUAL=1).
class VirtualDevice {
  constructor(key, name, items) {
    this.key = key;
    this.name = name;
    this._items = items.map((it) => ({ ...it, key: `${key}#${it.id}` }));
    this.changed = true;
    this.stats = { fps: 0, ms: 0 };
    this.colors = {};
  }
  items() { return this._items; }
  render() {
    const b = brightnessFor(this.key);
    for (const it of this._items) this.colors[it.key] = it.ledPositions.map((p) => sample(it.key, p[0], p[1], b));
  }
  shutdown() {}
  close() {}
  describe() {
    return { key: this.key, name: this.name, plugin: 'virtual', backend: 'virtual', items: this._items, params: [], alerts: [], messages: [], stats: this.stats, colors: this.colors };
  }
}

function addVirtualDevices() {
  const ring = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return [Math.round(4 + 4 * Math.cos(a)), Math.round(4 + 4 * Math.sin(a))];
  });
  addDevice(new VirtualDevice('virtual:ram', 'Virtual RGB memory', [
    { id: 'dimm0', name: 'Virtual DIMM 1', size: [1, 12], ledPositions: Array.from({ length: 12 }, (_, i) => [0, 11 - i]), ledNames: [] },
    { id: 'dimm1', name: 'Virtual DIMM 2', size: [1, 12], ledPositions: Array.from({ length: 12 }, (_, i) => [0, 11 - i]), ledNames: [] },
  ]));
  addDevice(new VirtualDevice('virtual:strip', 'Virtual LED strip', [
    { id: 'strip', name: 'Virtual strip', size: [30, 1], ledPositions: Array.from({ length: 30 }, (_, i) => [i, 0]), ledNames: [] },
  ]));
  addDevice(new VirtualDevice('virtual:fan', 'Virtual fan', [
    { id: 'ring', name: 'Virtual fan ring', size: [9, 9], ledPositions: ring, ledNames: [] },
  ]));
  rebuildItems();
}

// ------------------------------------------------------------------ discovery
function loadModules() {
  state.modules = loadPlugins(state.config.pluginDirs, log);
  log(`Loaded ${state.modules.length} device plugins from ${state.config.pluginDirs.length} folder(s)`);
}

function addDevice(dev) {
  state.devices.set(dev.key, dev);
  dev.changed = true;
  // Re-apply the user's saved per-device settings (e.g. FURY speed profile) so a
  // rescan/restart doesn't drop them back to defaults.
  const saved = state.config.params[dev.key];
  if (saved && dev.setParam) {
    for (const [name, value] of Object.entries(saved)) {
      try { dev.setParam(name, value); } catch { /* ignore */ }
    }
  }
}

function removeDevice(key) {
  const d = state.devices.get(key);
  if (!d) return;
  try { d.shutdown(false); } catch { /* ignore */ }
  try { d.close(); } catch { /* ignore */ }
  state.devices.delete(key);
  rebuildItems();
}

function hidKey(g) {
  return `hid:${g.vendorId.toString(16).padStart(4, '0')}:${g.productId.toString(16).padStart(4, '0')}${g.serial ? `:${g.serial}` : ''}`;
}

function scanHid() {
  const groups = hid.enumerate();
  // Anything that isn't an SMBus or raw-USB plugin can drive a HID device.
  const hidModules = state.modules.filter((m) => !['SMBUS', 'RAWUSB'].includes(m.meta.type));
  state.hidList = [];
  const seen = new Set();
  for (const g of groups) {
    const key = hidKey(g);
    seen.add(key);
    const entry = {
      vendorId: g.vendorId, productId: g.productId, product: g.product, manufacturer: g.manufacturer,
      serial: g.serial, endpoints: g.endpoints.map(({ path: p, ...rest }) => rest), key,
    };
    const matches = hidModules.filter((m) => m.matches(g.vendorId, g.productId));
    entry.plugin = matches.length ? matches[0].meta.name : null;
    entry.candidates = matches.map((m) => m.meta.name);

    if (state.devices.has(key)) {
      const d = state.devices.get(key);
      const warn = d.inst && d.inst.initWarning;
      const io = d.io && d.io.hid;
      entry.status = d.inst && d.inst.failed ? 'failed' : warn ? 'warn' : 'active';
      entry.detail = d.inst && d.inst.failed ? d.inst.failed
        : io ? `${warn ? warn + '; ' : ''}${io.writes || 0} USB writes${io.errors ? `, ${io.errors} errors (${io.lastError || ''})` : ''}`
        : (warn || 'running');
      state.hidList.push(entry);
      continue;
    }
    let tentative = false;
    if (!matches.length) {
      // No exact VID+PID match. Some keyboard plugins list one representative PID and
      // accept sibling models via Validate(). Try same-vendor HID plugins whose
      // Validate() claims one of this device's interfaces, as a tentative match.
      const sameVendor = hidModules.filter((m) => m.meta.vendorIds.includes(g.vendorId) && m.meta.hasValidate);
      const byValidate = sameVendor.filter((m) => m.validate(g.endpoints).length);
      if (byValidate.length) {
        matches.push(...byValidate.slice(0, 2));
        entry.candidates = matches.map((m) => m.meta.name);
        tentative = true;
      } else {
        entry.status = 'no-plugin';
        if (hidModules.length < 300) {
          entry.detail = `device plugin library incomplete (${hidModules.length} loaded) — still downloading or blocked`;
        } else {
          const sv = state.modules.filter((m) => m.meta.vendorIds.includes(g.vendorId));
          entry.detail = sv.length
            ? `no plugin lists PID 0x${g.productId.toString(16)}. Same-vendor: ${sv.slice(0, 3).map((m) => `${m.meta.name} pids=${m.meta.productIds.map((p) => '0x' + p.toString(16)).join(',') || 'any'}`).join(' · ')}`
            : 'no plugin supports this USB ID yet';
        }
        state.hidList.push(entry);
        continue;
      }
    }
    let started = false;
    const reasons = [];
    for (const mod of matches) {
      const eps = mod.validate(g.endpoints);
      if (!eps.length) {
        reasons.push(`${mod.meta.name}: no interface matched Validate()`);
        continue;
      }
      const io = { kind: 'hid', vendorId: g.vendorId, productId: g.productId, endpoints: eps, hid: new hid.HidIO(eps) };
      if (!io.hid.open()) {
        reasons.push(`${mod.meta.name}: could not open (another RGB app may hold it: close iCUE / Armoury Crate / NZXT CAM / SignalRGB / Glorious Core)`);
        continue;
      }
      try {
        const inst = new PluginInstance(mod, io, hostApi, key);
        inst.initialize();
        const leds = inst.items().reduce((a, it) => a + it.ledPositions.length, 0);
        // A tentative (interface-only) match that registers no LEDs is probably the
        // wrong variant — keep looking for a candidate that actually has LEDs.
        if (tentative && leds === 0 && matches.indexOf(mod) < matches.length - 1) {
          reasons.push(`${mod.meta.name}: started but reported 0 LEDs`);
          inst.shutdown(false);
          io.hid.close();
          continue;
        }
        addDevice(new PluginDevice(inst, io, { product: g.product, manufacturer: g.manufacturer }));
        log(`Started ${inst.name} using ${path.basename(mod.file)} on if${eps[0].interface} (${eps[0].usage_page.toString(16)}:${eps[0].usage.toString(16)}) — ${leds} LEDs`);
        entry.status = inst.failed ? 'failed' : 'active';
        entry.detail = (inst.failed || `started on if${eps[0].interface}, ${leds} LEDs`) + (tentative ? ' (matched by interface, not exact USB ID)' : '');
        started = true;
        break;
      } catch (e) {
        reasons.push(`${mod.meta.name}: ${e.message}`);
        io.hid.close();
      }
    }
    if (!started) {
      entry.status = 'error';
      entry.detail = reasons.join(' · ') || 'could not start';
      log(`Device ${g.manufacturer || ''} ${g.product || ''} [${key}] not started: ${entry.detail}`);
    }
    state.hidList.push(entry);
  }
  for (const key of [...state.devices.keys()]) {
    if (key.startsWith('hid:') && !seen.has(key)) {
      log(`Device removed: ${key}`);
      removeDevice(key);
    }
  }
  rebuildItems();
}

let orgb = null;
let orgbConnecting = false;
async function scanOpenRGB() {
  const cfg = state.config.openrgb;
  if (!cfg || !cfg.enabled) {
    if (orgb) {
      orgb.close();
      orgb = null;
      for (const k of [...state.devices.keys()]) if (k.startsWith('orgb:')) removeDevice(k);
    }
    return;
  }
  if (orgbConnecting || (orgb && orgb.connected)) return;
  orgbConnecting = true;
  try {
    orgb = new OpenRGBClient({ host: cfg.host, port: cfg.port });
    orgb.on('log', log);
    await orgb.connect();
    const list = await orgb.refresh();
    for (const c of list) addDevice(new OpenRGBDevice(orgb, c));
    orgb.on('updated', async () => {
      for (const k of [...state.devices.keys()]) if (k.startsWith('orgb:')) state.devices.delete(k);
      const l2 = await orgb.refresh().catch(() => []);
      for (const c of l2) addDevice(new OpenRGBDevice(orgb, c));
      rebuildItems();
    });
    orgb.on('close', () => {
      for (const k of [...state.devices.keys()]) if (k.startsWith('orgb:')) state.devices.delete(k);
      rebuildItems();
    });
    log(`OpenRGB connected: ${list.length} controller(s)`);
    rebuildItems();
  } catch (e) {
    state.openrgbError = e.message;
  } finally {
    orgbConnecting = false;
  }
}

function scanSmbus() {
  if (!state.buses.length) {
    const r = smbus.openBuses({ moduleDir: state.config.pawnioDir, log, sleepMode: 2 });
    state.buses = r.buses;
    state.smbusError = r.error || null;
  }
  for (const bus of state.buses) {
    let nativeFury = false;
    if (state.config.fury.enabled !== false) {
      const key = `fury:${bus.name}`;
      if (!state.devices.has(key)) {
        try {
          const sticks = FuryController.detect(bus, log);
          if (sticks && sticks.length) {
            const d = new FuryDevice(bus, sticks);
            addDevice(d);
            nativeFury = true;
          }
        } catch (e) {
          log(`FURY detection error: ${e.message}`);
        }
      } else nativeFury = true;
    }
    if (!state.config.smbusPlugins) continue;
    for (const mod of state.modules.filter((m) => m.meta.type === 'SMBUS' && m.meta.hasScan)) {
      if (nativeFury && /fury/i.test(mod.meta.name)) continue;
      let addrs = [];
      try {
        addrs = mod.scan(bus.free(log));
      } catch (e) {
        log(`${mod.meta.name} scan failed: ${e.message}`);
      }
      for (const addr of addrs) {
        const key = `smbus:${bus.name}:0x${addr.toString(16)}:${mod.meta.name}`;
        if (state.devices.has(key)) continue;
        const io = { kind: 'smbus', bus: { fixed: () => bus.fixedFor(addr, log) } };
        try {
          const inst = new PluginInstance(mod, io, hostApi, key);
          inst.initialize();
          addDevice(new PluginDevice(inst, io, { address: addr, bus: bus.name }));
          log(`Started ${inst.name} at 0x${addr.toString(16)} on ${bus.name}`);
        } catch (e) {
          log(`${mod.meta.name} failed: ${e.message}`);
        }
      }
    }
  }
  rebuildItems();
}

async function scanAll() {
  try {
    if (role === 'usb') {
      scanHid();
      await scanOpenRGB();
    } else {
      scanSmbus();
    }
  } catch (e) {
    log(`Scan failed: ${e.stack || e.message}`);
  }
  publish(true);
}

// ------------------------------------------------------------------ publishing
function publish(force) {
  let changed = state.dirty;
  for (const d of state.devices.values()) {
    if (d.changed) {
      changed = true;
      d.changed = false;
    }
  }
  if (changed) rebuildItems();
  const now = Date.now();
  if (!force && !changed && now - state.lastPublish < 1000) return;
  state.lastPublish = now;
  state.dirty = false;
  port.postMessage({
    type: 'devices',
    role,
    devices: [...state.devices.values()].map((d) => {
      try { return d.describe(); } catch (e) { return { key: d.key, name: d.key, failed: e.message, items: [] }; }
    }),
    hidList: state.hidList || [],
    smbus: role === 'smbus' ? { buses: state.buses.map((b) => ({ name: b.name, info: b.info, stats: b.stats })), error: state.smbusError } : null,
    openrgb: role === 'usb' ? { connected: !!(orgb && orgb.connected), error: state.openrgbError || null } : null,
  });
}

// ------------------------------------------------------------------ render loop
function tick() {
  if (!state.running) return;
  const t0 = Date.now();
  for (const d of state.devices.values()) {
    if (state.config.enabled[d.key] === false && !state.mapping) {
      if (!d._parked) {
        try { d.shutdown(false); } catch { /* ignore */ }
        d._parked = true;
      }
      continue;
    }
    if (d._parked) {
      d._parked = false;
      if (d.inst) d.inst.initialize();
    }
    const s = Date.now();
    try {
      d.render();
    } catch (e) {
      log(`${d.key} render: ${e.message}`);
    }
    const ms = Date.now() - s;
    d.stats.ms = d.stats.ms * 0.9 + ms * 0.1;
    d._frames = (d._frames || 0) + 1;
  }
  const spent = Date.now() - t0;
  const interval = 1000 / Math.max(1, state.config.fps || 60);
  setTimeout(tick, Math.max(1, interval - spent));
}

setInterval(() => {
  for (const d of state.devices.values()) {
    d.stats.fps = d._frames || 0;
    d._frames = 0;
  }
  publish(false);
}, 1000);

setInterval(() => {
  if (role === 'usb') scanAll();
}, 8000);

// ------------------------------------------------------------------- messages
port.on('message', async (e) => {
  const m = e.data || e;
  switch (m.type) {
    case 'config': {
      const prevDirs = JSON.stringify(state.config.pluginDirs);
      Object.assign(state.config, m.config);
      if (m.config.params) {
        for (const [key, vals] of Object.entries(m.config.params)) {
          const d = state.devices.get(key);
          if (d && d.setParam) for (const [k, v] of Object.entries(vals)) d.setParam(k, v);
        }
      }
      if (m.config.channelCounts) {
        for (const d of state.devices.values()) d.changed = true;
      }
      if (m.config.pluginDirs && JSON.stringify(m.config.pluginDirs) !== prevDirs) {
        loadModules();
        if (m.rescan !== false) await scanAll();
      }
      if (m.config.openrgb && role === 'usb') scanOpenRGB();
      state.dirty = true;
      break;
    }
    case 'param': {
      const d = state.devices.get(m.key);
      state.config.params[m.key] = { ...(state.config.params[m.key] || {}), [m.name]: m.value };
      if (d && d.setParam) d.setParam(m.name, m.value);
      state.dirty = true;
      break;
    }
    case 'frame':
      state.frame = m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data);
      state.fw = m.w;
      state.fh = m.h;
      break;
    case 'mapping':
      state.mapping = m.active ? { pattern: m.pattern, offsets: m.offsets || {} } : null;
      break;
    case 'identify':
      state.identify = { key: m.key, until: Date.now() + 3000 };
      break;
    case 'rescan':
      await scanAll();
      break;
    case 'fury-autotune': {
      const d = [...state.devices.values()].find((x) => x instanceof FuryDevice);
      if (!d) {
        port.postMessage({ type: 'autotune', error: 'No Kingston FURY memory detected' });
        break;
      }
      const res = d.ctrl.autotune(log);
      port.postMessage({ type: 'autotune', result: res });
      break;
    }
    case 'shutdown':
      state.running = false;
      for (const d of state.devices.values()) {
        try { d.shutdown(!!m.suspending); } catch { /* ignore */ }
        try { d.close(); } catch { /* ignore */ }
      }
      port.postMessage({ type: 'stopped', role });
      setTimeout(() => process.exit(0), 50);
      break;
    default:
      break;
  }
});

log(`Device host started (${role})`);
if (process.env.CF_VIRTUAL === '1' && role === 'usb') addVirtualDevices();
port.postMessage({ type: 'ready', role });
setTimeout(tick, 100);

module.exports = { state, sample, sleepSync };
