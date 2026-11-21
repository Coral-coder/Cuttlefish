'use strict';
// Native driver for Kingston FURY Beast / Renegade RGB memory (DDR4 + DDR5).
//
// Register facts (public knowledge from OpenRGB / SignalRGB plugin sources):
//   RGB controller at 0x58+slot (DDR4) or 0x60+slot (DDR5)
//   0x08 = 0x53 begin transaction, 0x08 = 0x44 end/apply
//   0x09 mode (0x10 = direct), 0x0B index, 0x0C direction, 0x20 brightness (0-100)
//   0x50 + 3*i .. 0x52 + 3*i = R,G,B of LED i (LED 0 is the bottom LED)
//   reading word from regs 1..4 inside a transaction returns "FURY" in the high bytes
//   reg 0x06 high byte = model code
//
// Why other software is slow: existing drivers sleep 10 ms after every register
// group (OpenRGB) or pause 3 ms + 10 ms per frame and drive each stick as its own
// device (SignalRGB plugin). With 4 sticks x 36 colour registers that caps the
// frame rate at a handful of FPS. This driver:
//   1. batches all sticks into one begin/apply window (one settle delay, not N),
//   2. writes only registers whose value changed (delta cache),
//   3. orders writes by visual error so the most-changed LEDs land first and an
//      optional per-frame write budget keeps latency bounded,
//   4. can switch PawnIO to busy-wait completion (no ~1 ms Windows sleep per
//      SMBus transaction) in Turbo mode,
//   5. auto-tunes settle delays with read-back verification and backs off on errors.

const { sleepSync } = require('./plugin-runtime');

const REG = { APPLY: 0x08, MODE: 0x09, INDEX: 0x0b, DIRECTION: 0x0c, BRIGHTNESS: 0x20, MODEL: 0x06, BASE: 0x50 };
const BEGIN = 0x53;
const END = 0x44;
const MODE_DIRECT = 0x10;
const MODELS = {
  0x10: 'FURY Beast DDR5 RGB',
  0x11: 'FURY Renegade DDR5 RGB',
  0x12: 'FURY Beast DDR5 RGB White',
  0x15: 'FURY Beast DDR5 RGB',
  0x21: 'FURY Beast DDR4 RGB White',
  0x23: 'FURY Beast DDR4 RGB',
};

const PROFILES = {
  safe: { beginDelay: 10, endDelay: 10, writeGap: 0, retries: 5, retryDelay: 10, budget: 0, busyWait: false },
  balanced: { beginDelay: 3, endDelay: 3, writeGap: 0, retries: 4, retryDelay: 3, budget: 0, busyWait: false },
  turbo: { beginDelay: 1, endDelay: 1, writeGap: 0, retries: 3, retryDelay: 2, budget: 24, busyWait: true },
};

function hi(word) {
  return word < 0 ? -1 : (word >> 8) & 0xff;
}

class FuryController {
  constructor(bus, sticks, options) {
    this.bus = bus;
    this.sticks = sticks; // [{ slot, addr, ddr, model, name }]
    this.ledsPerStick = sticks[0] && sticks[0].ddr === 4 ? 10 : 12;
    this.cache = sticks.map(() => new Int16Array(this.ledsPerStick * 3).fill(-1));
    this.ready = false;
    this.stats = { frames: 0, writes: 0, failures: 0, lastFrameMs: 0, fps: 0, skipped: 0 };
    this._fpsWindow = [];
    this.setProfile((options && options.profile) || 'balanced', options && options.custom);
  }

  setProfile(name, custom) {
    this.profileName = PROFILES[name] ? name : 'balanced';
    this.profile = { ...PROFILES[this.profileName], ...(custom || {}) };
    if (this.bus.setSleepMode) this.bus.setSleepMode(this.profile.busyWait ? 0 : 2);
  }

  // ---------------------------------------------------------------- detection
  // Probe the RGB controller addresses directly (DDR4 0x58-0x5f, DDR5 0x60-0x67)
  // and confirm via the "FURY" signature. We do NOT require the SPD at 0x50+slot
  // to answer first: on DDR5 the SPD5 hub is often contended or write-protected,
  // which previously made detection bail even when the RGB controller was present.
  static detect(bus, log) {
    log = log || (() => {});
    const found = [];
    const ranges = [{ ddr: 5, base: 0x60 }, { ddr: 4, base: 0x58 }];
    for (const { ddr, base } of ranges) {
      for (let slot = 0; slot < 8; slot++) {
        const addr = base + slot;
        // A present controller ACKs a quick write; retry once (bus can be flaky).
        if (bus.writeQuick(addr) !== 0 && bus.writeQuick(addr) !== 0) continue;
        const res = FuryController.checkSignature(bus, addr);
        if (res.ok) {
          found.push({ slot, addr, ddr, model: res.model, name: MODELS[res.model] || `FURY DDR${ddr} RGB` });
          log(`Kingston FURY found: slot ${slot} @0x${addr.toString(16)} DDR${ddr} model 0x${res.model.toString(16)}`);
        } else if (res.reason) {
          log(`FURY probe @0x${addr.toString(16)}: ${res.reason}`);
        }
      }
      if (found.length) break; // one generation per system
    }
    return found.length ? found : null;
  }

  static checkSignature(bus, addr, allowProtected) {
    const delay = 10;
    // 0x58/0x60 ranges are the RGB controller, not SPD, so writing APPLY is allowed.
    if (bus.writeByteData(addr, REG.APPLY, BEGIN, true) !== 0) return { ok: false, reason: 'no ACK to begin-transaction' };
    sleepSync(delay);
    const expect = 'FURY';
    const got = [];
    let ok = true;
    for (let i = 1; i <= 4; i++) {
      let v = -1;
      for (let r = 0; r < 3; r++) {
        const w = bus.readWordData(addr, i);
        sleepSync(delay);
        if (w >= 0 && w < 0xffff) { v = hi(w); break; }
      }
      got.push(v);
      if (v !== expect.charCodeAt(i - 1)) ok = false;
    }
    let model = 0;
    if (ok) {
      model = hi(bus.readWordData(addr, REG.MODEL));
      sleepSync(delay);
    }
    bus.writeByteData(addr, REG.APPLY, END, true);
    sleepSync(delay);
    const sig = got.map((c) => (c > 32 && c < 127 ? String.fromCharCode(c) : '?')).join('');
    return { ok: ok && model >= 0, model, reason: ok ? null : `signature read "${sig}" (want FURY)` };
  }

  // ------------------------------------------------------------------- writes
  _write(addr, reg, val) {
    let rc = this.bus.writeByteData(addr, reg, val);
    let tries = this.profile.retries;
    while (rc !== 0 && tries-- > 0) {
      sleepSync(this.profile.retryDelay);
      rc = this.bus.writeByteData(addr, reg, val);
    }
    this.stats.writes++;
    if (rc !== 0) this.stats.failures++;
    if (this.profile.writeGap) sleepSync(this.profile.writeGap);
    return rc === 0;
  }

  _begin() {
    for (const s of this.sticks) this._write(s.addr, REG.APPLY, BEGIN);
    sleepSync(this.profile.beginDelay);
  }

  _end() {
    for (const s of this.sticks) this._write(s.addr, REG.APPLY, END);
    sleepSync(this.profile.endDelay);
  }

  init() {
    this._begin();
    this.sticks.forEach((s) => {
      this._write(s.addr, REG.INDEX, 0);
      this._write(s.addr, REG.MODE, MODE_DIRECT);
      this._write(s.addr, REG.DIRECTION, 0x01);
      this._write(s.addr, REG.BRIGHTNESS, 100);
    });
    this._end();
    this.cache.forEach((c) => c.fill(-1));
    this.ready = true;
  }

  // colors: Array per stick of Array per LED of [r,g,b] (LED 0 = bottom)
  render(colors) {
    if (!this.ready) this.init();
    const t0 = process.hrtime.bigint();
    const pending = [];
    for (let s = 0; s < this.sticks.length; s++) {
      const cache = this.cache[s];
      const leds = colors[s] || [];
      for (let i = 0; i < this.ledsPerStick; i++) {
        const c = leds[i] || [0, 0, 0];
        for (let ch = 0; ch < 3; ch++) {
          const v = c[ch] & 0xff;
          const k = i * 3 + ch;
          const old = cache[k];
          if (old !== v) pending.push({ s, k, v, err: old < 0 ? 256 : Math.abs(old - v) });
        }
      }
    }
    if (pending.length) {
      pending.sort((a, b) => b.err - a.err);
      const budget = this.profile.budget > 0 ? this.profile.budget : pending.length;
      const todo = pending.slice(0, budget);
      this.stats.skipped += pending.length - todo.length;
      this._begin();
      for (const p of todo) {
        if (this._write(this.sticks[p.s].addr, REG.BASE + p.k, p.v)) this.cache[p.s][p.k] = p.v;
      }
      this._end();
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    this.stats.lastFrameMs = ms;
    this.stats.frames++;
    const now = Date.now();
    this._fpsWindow.push(now);
    while (this._fpsWindow.length && now - this._fpsWindow[0] > 1000) this._fpsWindow.shift();
    this.stats.fps = this._fpsWindow.length;
    return ms;
  }

  fill(rgb) {
    const all = this.sticks.map(() => new Array(this.ledsPerStick).fill(rgb));
    const keep = this.profile.budget;
    this.profile.budget = 0;
    this.render(all);
    this.profile.budget = keep;
  }

  readBack(s, k) {
    return hi(this.bus.readWordData(this.sticks[s].addr, REG.BASE + k));
  }

  // Find the shortest settle delays that still verify on this hardware.
  autotune(log) {
    log = log || (() => {});
    const results = [];
    const original = { ...this.profile };
    let best = null;
    for (const d of [10, 5, 3, 2, 1, 0]) {
      this.profile = { ...original, beginDelay: d, endDelay: d, budget: 0 };
      let bad = 0;
      let total = 0;
      const t0 = Date.now();
      for (let f = 0; f < 12; f++) {
        const frame = this.sticks.map(() => Array.from({ length: this.ledsPerStick }, () => [
          (Math.random() * 256) | 0, (Math.random() * 256) | 0, (Math.random() * 256) | 0]));
        this.render(frame);
        // verify a few registers
        this._begin();
        for (let s = 0; s < this.sticks.length; s++) {
          for (const k of [0, 7, this.ledsPerStick * 3 - 1]) {
            total++;
            const expected = this.cache[s][k];
            if (this.readBack(s, k) !== expected) bad++;
          }
        }
        this._end();
      }
      const fps = (12 * 1000) / Math.max(1, Date.now() - t0);
      results.push({ delay: d, errors: bad, checks: total, fps: Math.round(fps * 10) / 10 });
      log(`autotune delay=${d}ms errors=${bad}/${total} ~${fps.toFixed(1)} fps`);
      if (bad === 0) best = d;
      else break;
    }
    const chosen = best === null ? 10 : Math.min(10, best + (best <= 1 ? 1 : 0)); // keep a margin
    this.profile = { ...original, beginDelay: chosen, endDelay: chosen };
    this.cache.forEach((c) => c.fill(-1));
    return { chosenDelay: chosen, results };
  }
}

module.exports = { FuryController, PROFILES, MODELS, REG };
