'use strict';
const path = require('path');
const { EventEmitter } = require('events');

const HOST_SCRIPT = path.join(__dirname, '..', 'devicehost', 'host.js');

class DeviceManager extends EventEmitter {
  constructor({ utilityProcess, roles }) {
    super();
    this.utilityProcess = utilityProcess;
    this.roles = roles || ['usb', 'smbus'];
    this.hosts = {};
    this.lists = {};
    this.meta = {};
    this.logs = [];
    this.config = {};
    this.mapping = null;
    this.stopping = false;
  }

  start(config) {
    this.config = config;
    for (const role of this.roles) this._spawn(role);
  }

  _spawn(role) {
    const child = this.utilityProcess.fork(HOST_SCRIPT, [`--role=${role}`], {
      serviceName: `Cuttlefish ${role} host`,
      stdio: 'pipe',
    });
    this.hosts[role] = child;
    const forward = (s) => s && s.on('data', (d) => this._log(role, d.toString().trim()));
    forward(child.stdout);
    forward(child.stderr);
    child.on('message', (m) => this._onMessage(role, m));
    child.on('exit', (code) => {
      this._log(role, `host exited (${code})`);
      delete this.hosts[role];
      this.lists[role] = [];
      this.emit('devices', this.devices());
      if (!this.stopping) setTimeout(() => this._spawn(role), 3000);
    });
    child.postMessage({ type: 'config', config: this.config });
    if (this.mapping) child.postMessage({ type: 'mapping', ...this.mapping });
  }

  _log(role, msg) {
    if (!msg) return;
    const line = { t: Date.now(), role, msg };
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    this.emit('log', line);
  }

  _onMessage(role, m) {
    switch (m.type) {
      case 'log':
        this._log(role, m.msg);
        break;
      case 'devices':
        this.lists[role] = m.devices;
        this.meta[role] = { hidList: m.hidList, smbus: m.smbus, openrgb: m.openrgb };
        this.emit('devices', this.devices());
        break;
      case 'autotune':
        this.emit('autotune', m);
        break;
      default:
        break;
    }
  }

  devices() {
    return Object.values(this.lists).flat();
  }

  items() {
    const out = [];
    for (const d of this.devices()) for (const it of d.items || []) out.push({ ...it, owner: d.key });
    return out;
  }

  diagnostics() {
    return {
      hid: (this.meta.usb && this.meta.usb.hidList) || [],
      smbus: (this.meta.smbus && this.meta.smbus.smbus) || null,
      openrgb: (this.meta.usb && this.meta.usb.openrgb) || null,
      logs: this.logs.slice(-200),
    };
  }

  broadcast(msg) {
    for (const h of Object.values(this.hosts)) {
      try { h.postMessage(msg); } catch { /* host restarting */ }
    }
  }

  frame(buf, w, h) {
    // Each host gets its own copy (structured clone).
    for (const host of Object.values(this.hosts)) {
      try { host.postMessage({ type: 'frame', data: buf, w, h }); } catch { /* ignore */ }
    }
  }

  updateConfig(partial) {
    Object.assign(this.config, partial);
    this.broadcast({ type: 'config', config: partial });
  }

  setParam(key, name, value) {
    this.broadcast({ type: 'param', key, name, value });
  }

  // Global LED indexing used by the camera mapper.
  layoutForMapping() {
    const items = this.items().filter((it) => this.config.enabled[it.owner] !== false && this.config.enabled[it.key] !== false);
    const offsets = {};
    let total = 0;
    for (const it of items) {
      offsets[it.key] = total;
      total += it.ledPositions.length;
    }
    return { items, offsets, total };
  }

  setMapping(active, pattern, offsets) {
    this.mapping = active ? { active: true, pattern, offsets } : null;
    this.broadcast({ type: 'mapping', active, pattern, offsets });
  }

  identify(key) {
    this.broadcast({ type: 'identify', key });
  }

  rescan() {
    this.broadcast({ type: 'rescan' });
  }

  restartRole(role) {
    const h = this.hosts[role];
    if (h) {
      try { h.kill(); } catch { /* respawned by exit handler */ }
    } else if (!this.stopping) {
      this._spawn(role);
    }
  }

  autotune() {
    if (this.hosts.smbus) this.hosts.smbus.postMessage({ type: 'fury-autotune' });
  }

  async stop(suspending) {
    this.stopping = true;
    const waits = Object.values(this.hosts).map((h) => new Promise((resolve) => {
      const t = setTimeout(() => { try { h.kill(); } catch { /* */ } resolve(); }, 3000);
      h.once('exit', () => { clearTimeout(t); resolve(); });
      try { h.postMessage({ type: 'shutdown', suspending }); } catch { resolve(); }
    }));
    await Promise.all(waits);
  }
}

module.exports = { DeviceManager };
