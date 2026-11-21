'use strict';
// HID access for plugins, built on node-hid's synchronous API so that the
// blocking semantics SignalRGB plugins expect (device.read with timeout,
// device.pause, ...) behave the same way.

let HID = null;
try {
  HID = require('node-hid');
} catch (e) {
  HID = null;
}

function parseCollection(p) {
  const m = /&col([0-9a-f]{2})/i.exec(p || '');
  return m ? parseInt(m[1], 16) : 0;
}

function endpointOf(info) {
  return {
    interface: info.interface === undefined ? -1 : info.interface,
    usage: info.usage || 0,
    usage_page: info.usagePage || 0,
    collection: parseCollection(info.path),
    path: info.path,
  };
}

// Enumerate HID devices grouped per physical device (vid/pid/serial/instance).
function enumerate() {
  if (!HID) return [];
  let list = [];
  try {
    list = HID.devices();
  } catch {
    return [];
  }
  const groups = new Map();
  for (const d of list) {
    // Windows paths look like \\?\HID#VID_1B1C&PID_1B2D&MI_00&Col01#7&2a3b&0&0000#{guid}
    // The instance token (7&2a3b&0) differs per physical device but is shared by its collections.
    let inst = '';
    const m = /#([0-9a-f]+&[0-9a-f]+&[0-9a-f]+)&[0-9a-f]+#/i.exec(d.path || '');
    if (m) inst = m[1];
    const key = `${d.vendorId}:${d.productId}:${d.serialNumber || ''}:${process.platform === 'win32' ? '' : inst}`;
    if (!groups.has(key)) {
      groups.set(key, {
        vendorId: d.vendorId,
        productId: d.productId,
        serial: d.serialNumber || '',
        product: d.product || '',
        manufacturer: d.manufacturer || '',
        endpoints: [],
      });
    }
    groups.get(key).endpoints.push(endpointOf(d));
  }
  return [...groups.values()];
}

class HidIO {
  constructor(endpoints) {
    this.endpoints = endpoints;
    this.handles = new Map();
    this.current = endpoints[0] || null;
    this.errors = 0;
  }

  _handle(ep) {
    ep = ep || this.current;
    if (!ep || !HID) return null;
    let h = this.handles.get(ep.path);
    if (!h) {
      try {
        h = new HID.HID(ep.path);
        this.handles.set(ep.path, h);
      } catch (e) {
        this.errors++;
        return null;
      }
    }
    return h;
  }

  open() {
    for (const ep of this.endpoints) this._handle(ep);
    return this.handles.size > 0;
  }

  setEndpoint(iface, usage, page, collection) {
    const match = (ep, useCollection) =>
      ep.interface === iface && ep.usage === usage && ep.usage_page === page &&
      (!useCollection || collection === undefined || ep.collection === collection);
    const ep = this.endpoints.find((e) => match(e, true)) || this.endpoints.find((e) => match(e, false));
    if (ep) this.current = ep;
  }

  static pad(data, len) {
    const out = new Array(Math.max(len || 0, data.length)).fill(0);
    for (let i = 0; i < data.length; i++) out[i] = data[i] & 0xff;
    return out;
  }

  write(data, len) {
    const h = this._handle();
    if (!h) return -1;
    try {
      return h.write(HidIO.pad(data, len));
    } catch (e) {
      this.errors++;
      return -1;
    }
  }

  sendFeature(data, len) {
    const h = this._handle();
    if (!h) return -1;
    try {
      return h.sendFeatureReport(HidIO.pad(data, len));
    } catch (e) {
      this.errors++;
      return -1;
    }
  }

  read(data, len, timeout) {
    const h = this._handle();
    if (!h) return [];
    try {
      const r = h.readTimeout(timeout === undefined ? 1000 : timeout);
      return r ? [...r] : [];
    } catch (e) {
      this.errors++;
      return [];
    }
  }

  getFeature(data, len) {
    const h = this._handle();
    if (!h) return [];
    try {
      return [...h.getFeatureReport(data[0] || 0, len)];
    } catch (e) {
      this.errors++;
      return [];
    }
  }

  clearReadBuffer() {
    const h = this._handle();
    if (!h) return;
    try {
      for (let i = 0; i < 256; i++) {
        const r = h.readTimeout(0);
        if (!r || r.length === 0) break;
      }
    } catch {
      /* ignore */
    }
  }

  close() {
    for (const h of this.handles.values()) {
      try { h.close(); } catch { /* ignore */ }
    }
    this.handles.clear();
  }
}

module.exports = { enumerate, HidIO, available: () => !!HID, parseCollection };
