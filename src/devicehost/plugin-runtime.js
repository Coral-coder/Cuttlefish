'use strict';
// Runtime for SignalRGB-format device plugins (the JavaScript files with
// `export function Name()`, `VendorId()`, `Render()` ...). The plugin API was
// implemented from the public type definitions and documentation; no plugin
// code is shipped with Cuttlefish. Plugins are loaded from the user's plugin
// folders (or downloaded on request from the public plugin repository).

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { hexToRgb } = require('../shared/layout');

const EXPORT_NAMES = [
  'Name', 'VendorId', 'ProductId', 'Publisher', 'Documentation', 'Size', 'Type', 'DeviceType',
  'DefaultPosition', 'DefaultScale', 'LedNames', 'LedPositions', 'ConflictingProcesses',
  'ControllableParameters', 'Validate', 'Scan', 'Initialize', 'Render', 'Shutdown',
  'ImageUrl', 'Image', 'DeviceMessage', 'SupportsSubdevices', 'SupportsFanControl',
  'DefaultComponentBrand', 'onConnect', 'onDisconnect',
];

const GUARD = new vm.Script('(function(){ const f = __cfTarget; __cfTarget = undefined; return typeof f === "function" ? f.apply(undefined, __cfArgs) : undefined; })()');

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(sleepCell, 0, 0, Math.min(ms, 5000));
}

// Rewrite ES module syntax into a classic script whose exports we can read back.
function transformSource(src) {
  const exported = new Set();
  let out = src.replace(/^﻿/, '');
  out = out.replace(/^\s*import\s+\{([^}]*)\}\s+from\s+["']([^"']+)["'];?/gm, (m, names, mod) =>
    `const {${names.replace(/\s+as\s+/g, ': ')}} = __cfImport(${JSON.stringify(mod)});`);
  out = out.replace(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["'];?/gm, (m, name, mod) =>
    `const ${name} = __cfImport(${JSON.stringify(mod)}).default;`);
  out = out.replace(/^\s*import\s+["'][^"']+["'];?/gm, '');
  out = out.replace(
    /(^|[\n;}])(\s*)export\s+(default\s+)?((?:async\s+)?function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
    (m, pre, ws, def, kw, name) => {
      exported.add(name);
      return `${pre}${ws}${kw} ${name}`;
    });
  out = out.replace(/(^|[\n;}])\s*export\s*\{([^}]*)\};?/g, (m, pre, list) => {
    list.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((n) => exported.add(n));
    return pre;
  });
  for (const n of EXPORT_NAMES) exported.add(n);
  const names = [...exported].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  const tail = `\n;globalThis.__cfExports = {${names
    .map((n) => `${JSON.stringify(n)}: (typeof ${n} !== 'undefined' ? ${n} : undefined)`)
    .join(',')}};`;
  return out + tail;
}

function stubProxy() {
  const fn = function () { return 0; };
  return new Proxy(fn, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : stubProxy()),
    apply: () => 0,
  });
}

function call(fn, ...args) {
  return typeof fn === 'function' ? fn(...args) : undefined;
}

function toIdList(v) {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isFinite(n));
}

// Convert a parameter default/value to the JS type plugins expect.
function coerceParam(param, value) {
  if (value === undefined || value === null) value = param.default;
  switch (param.type) {
    case 'boolean':
      return value === true || value === 1 || value === '1' || value === 'true';
    case 'number':
    case 'hue': {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    default:
      return value === undefined ? '' : String(value);
  }
}

function colorOrderIndices(order) {
  const o = String(order || 'RGB').toUpperCase();
  return [...o].map((c) => ({ R: 0, G: 1, B: 2 }[c] ?? 0));
}

function formatColors(colors, arrayOrder, colorOrder) {
  if (typeof arrayOrder === 'string' && /^sep/i.test(arrayOrder)) {
    const r = [], g = [], b = [];
    for (const c of colors) { r.push(c[0]); g.push(c[1]); b.push(c[2]); }
    return [r, g, b];
  }
  const idx = colorOrderIndices(colorOrder);
  const out = new Array(colors.length * 3);
  let k = 0;
  for (const c of colors) {
    out[k++] = c[idx[0]];
    out[k++] = c[idx[1]];
    out[k++] = c[idx[2]];
  }
  return out;
}

class PluginModule {
  constructor(file, source) {
    this.file = file;
    this.source = source;
    this.code = transformSource(source);
    this.script = new vm.Script(this.code, { filename: file });
    this.meta = this._readMeta();
  }

  static load(file) {
    return new PluginModule(file, fs.readFileSync(file, 'utf8'));
  }

  _readMeta() {
    const ctx = vm.createContext({
      device: stubProxy(), bus: stubProxy(), console: { log() {} }, service: stubProxy(),
      __cfImport: () => ({}), Math, JSON, Date,
    });
    this.script.runInContext(ctx, { timeout: 1000 });
    const ex = ctx.__cfExports || {};
    const safe = (fn, dflt) => {
      try {
        const v = call(fn);
        return v === undefined ? dflt : v;
      } catch {
        return dflt;
      }
    };
    const type = String(safe(ex.Type, 'HID')).toUpperCase();
    return {
      file: this.file,
      name: String(safe(ex.Name, path.basename(this.file, path.extname(this.file)))),
      publisher: String(safe(ex.Publisher, '')),
      type,
      vendorIds: toIdList(safe(ex.VendorId, [])),
      productIds: toIdList(safe(ex.ProductId, [])),
      size: safe(ex.Size, [1, 1]),
      defaultPosition: safe(ex.DefaultPosition, null),
      defaultScale: safe(ex.DefaultScale, null),
      deviceType: String(safe(ex.DeviceType, '')),
      params: safe(ex.ControllableParameters, []) || [],
      hasValidate: typeof ex.Validate === 'function',
      hasScan: typeof ex.Scan === 'function',
      image: safe(ex.ImageUrl, ''),
    };
  }

  matches(vid, pid) {
    return this.meta.vendorIds.includes(vid) && (this.meta.productIds.length === 0 || this.meta.productIds.includes(pid));
  }

  // Run the plugin's Validate(endpoint) against a list of HID endpoints.
  validate(endpoints) {
    if (!this.meta.hasValidate) return endpoints.slice(0, 1);
    const ctx = vm.createContext({ device: stubProxy(), bus: stubProxy(), console: { log() {} }, __cfImport: () => ({}) });
    this.script.runInContext(ctx, { timeout: 1000 });
    const ex = ctx.__cfExports;
    return endpoints.filter((ep) => {
      try {
        return !!ex.Validate({ interface: ep.interface, usage: ep.usage, usage_page: ep.usage_page, collection: ep.collection });
      } catch {
        return false;
      }
    });
  }

  // SMBus discovery: returns the list of addresses this plugin claims on `freeBus`.
  scan(freeBus) {
    const ctx = vm.createContext({ device: stubProxy(), bus: freeBus, console: { log() {} }, __cfImport: () => ({}) });
    this.script.runInContext(ctx, { timeout: 2000 });
    try {
      return toIdList(ctx.__cfExports.Scan(freeBus));
    } catch {
      return [];
    }
  }
}

// A live instance of a plugin bound to one physical device.
// `io` is the backend: { kind, vendorId, productId, endpoints, hid: {...}, bus }
// `host` supplies colours: host.sample(itemKey, gx, gy) -> [r,g,b] and config.
class PluginInstance {
  constructor(module, io, host, key) {
    this.module = module;
    this.io = io;
    this.host = host;
    this.key = key;
    this.name = module.meta.name;
    this.size = Array.isArray(module.meta.size) ? module.meta.size.slice(0, 2) : [1, 1];
    this.ledNames = [];
    this.ledPositions = [];
    this.subdevices = new Map();
    this.channels = new Map();
    this.params = [];
    this.alerts = new Map();
    this.messages = new Map();
    this.features = {};
    this.battery = null;
    this.logs = [];
    this.lastReadSize = 0;
    this.imageUrl = module.meta.image || '';
    this.supportsSubdevices = false;
    this.failed = null;
    this.changed = true; // device structure changed -> host republishes
    this._build();
  }

  log(msg) {
    const line = typeof msg === 'string' ? msg : (() => { try { return JSON.stringify(msg); } catch { return String(msg); } })();
    this.logs.push(line);
    if (this.logs.length > 200) this.logs.shift();
    this.host.log && this.host.log(`[${this.name}] ${line}`);
  }

  _build() {
    const self = this;
    const io = this.io;
    const brightness = () => this.host.brightness(this.key);

    const device = {
      vendorId: () => io.vendorId || 0,
      productId: () => io.productId || 0,
      write(data, len) { io.hid && io.hid.write(data, len); },
      send_report(data, len) { io.hid && io.hid.sendFeature(data, len); },
      read(data, len, timeout) {
        const r = io.hid ? io.hid.read(data, len, timeout) : [];
        self.lastReadSize = r.length;
        const out = r.slice(0, len);
        while (out.length < len) out.push(0);
        return out;
      },
      get_report(data, len) {
        const r = io.hid ? io.hid.getFeature(data, len) : [];
        self.lastReadSize = r.length;
        const out = r.slice(0, len);
        while (out.length < len) out.push(0);
        return out;
      },
      flush() {},
      bulk_transfer() { return []; },
      control_transfer() {},
      getLastReadSize: () => self.lastReadSize,
      clearReadBuffer() { io.hid && io.hid.clearReadBuffer(); },
      set_endpoint(iface, usage, page, collection) { io.hid && io.hid.setEndpoint(iface, usage, page, collection); },
      getHidEndpoints: () => (io.endpoints || []).map((e) => ({ interface: e.interface, usage: e.usage, usage_page: e.usage_page, collection: e.collection })),
      getHidInfo: () => ({ featureLength: 65, readLength: 65, writeLength: 65 }),
      pause: (ms) => (self.host.pause || sleepSync)(Number(ms) || 0),
      log: (d) => self.log(d),
      // naming / geometry
      setName(n) { self.name = String(n); self.changed = true; },
      setSize(s) { if (Array.isArray(s)) { self.size = [Number(s[0]) || 1, Number(s[1]) || 1]; self.changed = true; } },
      setControllableLeds(names, positions) {
        self.ledNames = (names || []).map(String);
        self.ledPositions = (positions || []).map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);
        self.changed = true;
      },
      setImageFromUrl(u) { self.imageUrl = String(u); },
      setImageFromBase64() {},
      setImageFromResource(r) { self.imageUrl = String(r); },
      repollName() {}, repollLeds() {}, repollSize() {},
      color(x, y) { return self.host.sample(self.key, x, y, brightness()); },
      getBrightness: () => Math.round(brightness() * 100),
      getMotherboardName: () => self.host.motherboardName || 'Unknown',
      getImageBuffer: () => [],
      ConvertColorToImageBuffer: () => [],
      createColorArray(hex, count, arrayOrder, colorOrder) {
        const c = hexToRgb(hex);
        return formatColors(new Array(Math.max(0, count | 0)).fill(c), arrayOrder, colorOrder);
      },
      // alerts & messages
      notify(title, description, priority) {
        const id = `alert${self.alerts.size + 1}_${Date.now()}`;
        self.alerts.set(id, { title: String(title), description: String(description), priority });
        self.changed = true;
        return id;
      },
      denotify(id) { self.alerts.delete(id); self.changed = true; },
      addMessage(id, msg, tip) { self.messages.set(id, { message: String(msg), tooltip: String(tip || '') }); self.changed = true; },
      removeMessage(id) { self.messages.delete(id); self.changed = true; },
      // features
      addFeature(name) { self._addFeature(String(name)); },
      // properties
      addProperty(p) {
        if (!p || !p.property) return;
        self.params = self.params.filter((q) => q.property !== p.property);
        self.params.push(p);
        self._setParamGlobal(p, self.host.paramValue(self.key, p.property));
        self.changed = true;
      },
      removeProperty(name) { self.params = self.params.filter((q) => q.property !== name); self.changed = true; },
      getProperty(name) {
        const p = self.params.find((q) => q.property === name);
        return p ? { ...p, value: self.ctx[name] } : null;
      },
      // fans & sensors (Cuttlefish does not do cooling control)
      fanControlDisabled: () => true,
      createFanControl() {}, removeFanControl() {},
      getNormalizedFanlevel: () => 50, getFanlevel: () => 50, setRPM() {},
      createTemperatureSensor() {}, removeTemperatureSensor() {}, SetTemperature() {},
      // subdevices
      createSubdevice(id) { self.subdevices.set(id, { id, name: id, size: [1, 1], ledNames: [], ledPositions: [], image: '' }); self.changed = true; },
      removeSubdevice(id) { self.subdevices.delete(id); self.changed = true; },
      setSubdeviceName(id, n) { const s = self.subdevices.get(id); if (s) { s.name = String(n); self.changed = true; } },
      setSubdeviceImage(id, img) { const s = self.subdevices.get(id); if (s) s.image = String(img); },
      setSubdeviceSize(id, w, h) { const s = self.subdevices.get(id); if (s) { s.size = [Number(w) || 1, Number(h) || 1]; self.changed = true; } },
      setSubdeviceLeds(id, names, positions) {
        const s = self.subdevices.get(id);
        if (s) {
          s.ledNames = (names || []).map(String);
          s.ledPositions = (positions || []).map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);
          self.changed = true;
        }
      },
      setSubdeviceLedMap() {},
      subdeviceColor(id, x, y) { return self.host.sample(`${self.key}#sub:${id}`, x, y, brightness()); },
      getCurrentSubdevices: () => [...self.subdevices.keys()],
      GetComponentData: () => null,
      AvailableComponents: () => [],
      // component channels
      SetLedLimit(n) { self.ledLimit = n; },
      getLedCount: () => [...self.channels.keys()].reduce((a, id) => a + self._channelCount(id), 0),
      addChannel(id, limit, dflt) {
        self.channels.set(String(id), { id: String(id), limit: Number(limit) || 0, dflt: Number(dflt) || 0 });
        self.changed = true;
      },
      removeChannel(id) { self.channels.delete(String(id)); self.changed = true; },
      getChannelNames: () => [...self.channels.keys()],
      channel(id) { return self.channels.has(String(id)) ? self._channelApi(String(id)) : null; },
      getChannelPulseColor: () => '#ffffff',
    };
    this.device = device;

    const bus = io.bus ? io.bus.fixed() : stubProxy();
    const ctx = {
      device,
      bus,
      console: { log: (d) => self.log(d), warn: (d) => self.log(d), error: (d) => self.log(d) },
      service: stubProxy(),
      hexToRgb,
      __cfImport: () => ({}),
      Math, JSON, Date, Array, Object, String, Number, Boolean, Error, Map, Set,
      Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
      parseInt, parseFloat, isNaN, isFinite, BigInt,
    };
    this.ctx = vm.createContext(ctx);
    for (const p of this.module.meta.params) this._setParamGlobal(p, host_param(this, p));
    this.params = (this.module.meta.params || []).slice();
    this.module.script.runInContext(this.ctx, { timeout: 2000 });
    this.exports = this.ctx.__cfExports || {};
    // Re-read parameters inside the live context (some plugins build them dynamically).
    try {
      const live = this._guard(this.exports.ControllableParameters, [], 1000);
      if (Array.isArray(live)) {
        for (const p of live) {
          if (!p || !p.property) continue;
          if (!this.params.find((q) => q.property === p.property)) this.params.push(p);
          if (!(p.property in this.ctx)) this._setParamGlobal(p, this.host.paramValue(this.key, p.property));
        }
      }
    } catch { /* optional */ }
    // Pre-populate LEDs from exports (plugins may call setControllableLeds later).
    try {
      const names = call(this.exports.LedNames);
      const pos = call(this.exports.LedPositions);
      if (Array.isArray(pos)) device.setControllableLeds(names || pos.map((_, i) => `Led ${i + 1}`), pos);
    } catch (e) {
      this.log(`LedPositions failed: ${e.message}`);
    }
    try { this.supportsSubdevices = !!call(this.exports.SupportsSubdevices); } catch { /* optional */ }
    try {
      const dm = call(this.exports.DeviceMessage);
      if (Array.isArray(dm)) this.messages.set('device', { message: String(dm[0]), tooltip: String(dm[1] || '') });
    } catch { /* optional */ }

    function host_param(inst, p) {
      return inst.host.paramValue(inst.key, p.property);
    }
  }

  // Call a plugin function with a watchdog so a plugin stuck in a loop cannot hang the host.
  _guard(fn, args, timeout) {
    if (typeof fn !== 'function') return undefined;
    this.ctx.__cfTarget = fn;
    this.ctx.__cfArgs = args || [];
    return GUARD.runInContext(this.ctx, { timeout: timeout || this.host.callTimeout || 3000 });
  }

  _addFeature(name) {
    const self = this;
    if (name === 'battery') {
      this.ctx.battery = {
        setBatteryLevel(l) { self.battery = { ...(self.battery || {}), level: l }; self.changed = true; },
        setBatteryState(s) { self.battery = { ...(self.battery || {}), state: s }; self.changed = true; },
      };
    } else if (name === 'keyboard' || name === 'mouse') {
      this.ctx[name] = { sendEvent() {}, sendHid() {} };
    } else if (name === 'base64') {
      this.ctx.base64 = {
        Encode: (arr) => Buffer.from(arr).toString('base64'),
        Decode: (s) => [...Buffer.from(String(s), 'base64')],
      };
    } else {
      this.ctx[name] = stubProxy();
    }
  }

  _channelCount(id) {
    const ch = this.channels.get(id);
    if (!ch) return 0;
    const v = this.host.channelCount(this.key, id);
    // No count configured: use the plugin default, or light the whole header up to
    // its limit (extra LED data is ignored by the controller) so it works out of the box.
    let n = v === undefined || v === null ? ch.dflt : v;
    if ((v === undefined || v === null) && !n) n = Math.min(ch.limit || 40, 120);
    return Math.max(0, Math.min(ch.limit || 1000, n | 0));
  }

  _channelApi(id) {
    const self = this;
    const itemKey = `${this.key}#ch:${id}`;
    const colors = () => {
      const n = self._channelCount(id);
      const out = new Array(n);
      const b = self.host.brightness(self.key);
      for (let i = 0; i < n; i++) out[i] = self.host.sample(itemKey, i, 0, b);
      return out;
    };
    return {
      SetLedLimit(n) { const c = self.channels.get(id); if (c) { c.limit = Number(n) || 0; self.changed = true; } },
      LedCount: () => self._channelCount(id),
      ledCount: () => self._channelCount(id),
      getColors: (arrayOrder, colorOrder) => formatColors(colors(), arrayOrder, colorOrder),
      shouldPulseColors: () => self._channelCount(id) === 0,
      getPulse(count, arrayOrder, colorOrder) {
        const t = (Date.now() % 2000) / 2000;
        const v = Math.round((0.5 - 0.5 * Math.cos(t * Math.PI * 2)) * 255);
        return formatColors(new Array(Math.max(0, count | 0)).fill([v, v, v]), arrayOrder, colorOrder);
      },
      getComponentNames: () => [],
      getComponentColors: (cid, arrayOrder) => formatColors(colors(), arrayOrder),
      OverrideColors: () => false,
    };
  }

  _setParamGlobal(p, value) {
    this.ctx[p.property] = coerceParam(p, value);
  }

  setParam(name, value) {
    const p = this.params.find((q) => q.property === name);
    if (!p) return;
    this._setParamGlobal(p, value);
    this._pendingCallbacks = this._pendingCallbacks || new Set();
    this._pendingCallbacks.add(name);
  }

  // Layout items exposed to the rest of the app.
  items() {
    const items = [];
    if (!this.supportsSubdevices && this.ledPositions.length) {
      items.push({ key: this.key, name: this.name, size: this.size, ledNames: this.ledNames, ledPositions: this.ledPositions,
        defaultPosition: this.module.meta.defaultPosition, defaultScale: this.module.meta.defaultScale });
    }
    for (const s of this.subdevices.values()) {
      items.push({ key: `${this.key}#sub:${s.id}`, name: s.name, size: s.size, ledNames: s.ledNames, ledPositions: s.ledPositions, parent: this.key });
    }
    for (const ch of this.channels.values()) {
      const n = this._channelCount(ch.id);
      if (n > 0) {
        items.push({
          key: `${this.key}#ch:${ch.id}`, name: `${this.name} — ${ch.id}`, size: [n, 1],
          ledNames: Array.from({ length: n }, (_, i) => `LED ${i + 1}`),
          ledPositions: Array.from({ length: n }, (_, i) => [i, 0]), parent: this.key, channel: ch.id, limit: ch.limit,
        });
      }
    }
    return items;
  }

  initialize() {
    // Initialization talks to the real device (firmware handshake, LED detection).
    // If it is slow or the device answers oddly, do NOT kill the device: render anyway
    // (Render usually still lights LEDs) and retry Initialize in the background. A
    // permanent failure only happens if the plugin throws a real error, not a timeout.
    this.initAttempts = (this.initAttempts || 0) + 1;
    try {
      this._guard(this.exports.Initialize, [], this.host.initTimeout || 20000);
      this.initialized = true;
      this.initWarning = null;
      return true;
    } catch (e) {
      this.initialized = true; // let Render run; many plugins still drive LEDs
      if (/timed out/.test(e.message)) {
        this.initWarning = `Initialize is slow to finish (attempt ${this.initAttempts}); lighting anyway`;
        this.log(this.initWarning);
        this._retryInit = this.initAttempts < 5;
      } else {
        this.initWarning = `Initialize error: ${e.message}`;
        this.log(this.initWarning);
        this._retryInit = this.initAttempts < 3;
      }
      return false;
    }
  }

  render() {
    if (this.failed) return;
    if (!this.initialized) return;
    // Retry a slow/odd initialization occasionally, without blocking rendering.
    if (this._retryInit && (this._frames || 0) % 300 === 150) {
      this._retryInit = false;
      this.initialize();
    }
    if (this._pendingCallbacks && this._pendingCallbacks.size) {
      for (const name of this._pendingCallbacks) {
        try { this._guard(this.ctx[`on${name}Changed`]); } catch (e) { this.log(`on${name}Changed: ${e.message}`); }
      }
      this._pendingCallbacks.clear();
    }
    try {
      this._guard(this.exports.Render);
      this.errorCount = 0;
      this._everRendered = true;
    } catch (e) {
      this.errorCount = (this.errorCount || 0) + 1;
      if (this.errorCount < 5 || this.errorCount % 100 === 0) this.log(`Render error: ${e.message}`);
      // Only give up if it has never once succeeded and keeps throwing hard.
      if (this.errorCount > 1200 && !this._everRendered) this.failed = `Render failing: ${e.message}`;
    }
    this._frames = (this._frames || 0) + 1;
  }

  shutdown(suspending) {
    if (!this.initialized) return;
    try { this._guard(this.exports.Shutdown, [!!suspending], 5000); } catch (e) { this.log(`Shutdown error: ${e.message}`); }
    this.initialized = false;
  }

  describe() {
    return {
      key: this.key,
      name: this.name,
      plugin: path.basename(this.module.file),
      publisher: this.module.meta.publisher,
      backend: this.io.kind,
      vendorId: this.io.vendorId,
      productId: this.io.productId,
      params: this.params,
      alerts: [...this.alerts.values()],
      messages: [...this.messages.values()],
      battery: this.battery,
      channels: [...this.channels.values()].map((c) => ({ id: c.id, limit: c.limit, count: this._channelCount(c.id) })),
      failed: this.failed,
      warning: this.initWarning || null,
      image: this.imageUrl,
      items: this.items(),
      logs: this.logs.slice(-30),
    };
  }
}

// Discover plugin files in a list of directories (recursively).
function findPluginFiles(dirs) {
  const files = [];
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 6 && !/^(node_modules|tests?|types|\.git)$/i.test(e.name)) walk(p, depth + 1);
      } else if (/\.js$/i.test(e.name) && !/\.(test|spec|d)\.js$/i.test(e.name)) {
        files.push(p);
      }
    }
  };
  for (const d of dirs) if (d) walk(d, 0);
  return files;
}

// Load plugins. Later directories override earlier ones for the same VID/PID set
// (mirrors SignalRGB: user plugins override built-in ones).
function loadPlugins(dirs, log) {
  const byIds = new Map();
  for (const f of findPluginFiles(dirs)) {
    try {
      const src = fs.readFileSync(f, 'utf8');
      if (!/\b(VendorId|Scan)\s*\(/.test(src)) continue;
      const m = new PluginModule(f, src);
      const sig = `${m.meta.type}|${m.meta.vendorIds.join(',')}|${m.meta.productIds.join(',')}|${m.meta.type === 'SMBUS' ? m.meta.name : ''}`;
      byIds.set(sig, m);
    } catch (e) {
      log && log(`Plugin ${path.basename(f)} failed to load: ${e.message}`);
    }
  }
  return [...byIds.values()];
}

module.exports = { PluginModule, PluginInstance, transformSource, coerceParam, formatColors, findPluginFiles, loadPlugins, sleepSync };
