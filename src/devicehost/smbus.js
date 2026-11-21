'use strict';
// SMBus access on Windows through the signed PawnIO driver (https://pawnio.eu)
// and its SmbusI801 / SmbusPIIX4 modules. Transactions are serialised with the
// system-wide "Global\Access_SMBUS.HTP.Method" mutex that HWiNFO, OpenRGB and
// other monitoring tools also honour, so we never collide with them on the bus.

const fs = require('fs');
const path = require('path');

const READ = 1;
const WRITE = 0;
const SIZE = { QUICK: 0, BYTE: 1, BYTE_DATA: 2, WORD_DATA: 3, BLOCK_DATA: 5, I2C_BLOCK_DATA: 8 };
const SLEEP_MODE = { ALWAYS_BUSY: 0, SHORT_BUSY: 1, ALWAYS_SLEEP: 2 };

// Addresses we refuse to write to from plugins: SPD EEPROM / SPD5 hub, SPD page
// select and DIMM thermal sensors. Writing there can brick memory modules.
function isProtectedWrite(addr) {
  return (addr >= 0x50 && addr <= 0x57) || addr === 0x36 || addr === 0x37 || (addr >= 0x18 && addr <= 0x1f);
}

class BusBase {
  constructor(name, info) {
    this.name = name;
    this.info = info || {};
    this.stats = { tx: 0, errors: 0, us: 0 };
    this.log = () => {};
  }
  // Implemented by subclasses: xfer(addr, rw, command, size, data:Buffer(34)) -> { status, data }
  readByteData(addr, reg) {
    const r = this.xfer(addr, READ, reg, SIZE.BYTE_DATA);
    return r.status < 0 ? -1 : r.data[0];
  }
  readWordData(addr, reg) {
    const r = this.xfer(addr, READ, reg, SIZE.WORD_DATA);
    return r.status < 0 ? -1 : r.data[0] | (r.data[1] << 8);
  }
  readByte(addr) {
    const r = this.xfer(addr, READ, 0, SIZE.BYTE);
    return r.status < 0 ? -1 : r.data[0];
  }
  writeQuick(addr) {
    return this.xfer(addr, WRITE, 0, SIZE.QUICK).status < 0 ? -1 : 0;
  }
  writeByteData(addr, reg, val, allowProtected) {
    if (!allowProtected && isProtectedWrite(addr)) return -1;
    const d = Buffer.alloc(34);
    d[0] = val & 0xff;
    return this.xfer(addr, WRITE, reg, SIZE.BYTE_DATA, d).status < 0 ? -1 : 0;
  }
  writeWordData(addr, reg, word) {
    if (isProtectedWrite(addr)) return -1;
    const d = Buffer.alloc(34);
    d[0] = word & 0xff;
    d[1] = (word >> 8) & 0xff;
    return this.xfer(addr, WRITE, reg, SIZE.WORD_DATA, d).status < 0 ? -1 : 0;
  }
  writeBlockData(addr, reg, bytes) {
    if (isProtectedWrite(addr)) return -1;
    const d = Buffer.alloc(34);
    const n = Math.min(32, bytes.length);
    d[0] = n;
    for (let i = 0; i < n; i++) d[1 + i] = bytes[i] & 0xff;
    return this.xfer(addr, WRITE, reg, SIZE.BLOCK_DATA, d).status < 0 ? -1 : 0;
  }
  writeI2cBlock(addr, reg, bytes) {
    if (isProtectedWrite(addr)) return -1;
    const d = Buffer.alloc(34);
    const n = Math.min(32, bytes.length);
    d[0] = n;
    for (let i = 0; i < n; i++) d[1 + i] = bytes[i] & 0xff;
    return this.xfer(addr, WRITE, reg, SIZE.I2C_BLOCK_DATA, d).status < 0 ? -1 : 0;
  }
  readBlockData(addr, reg) {
    const r = this.xfer(addr, READ, reg, SIZE.BLOCK_DATA);
    if (r.status < 0) return [-1, []];
    const n = Math.min(32, r.data[0]);
    return [n, [...r.data.subarray(1, 1 + n)]];
  }
  setSleepMode() {}
  isSystemBus() { return !!this.info.system; }

  // SignalRGB FreeAddressBus facade passed to plugin Scan(bus).
  free(logFn) {
    const b = this;
    const api = {
      IsSystemBus: () => b.isSystemBus(),
      IsIntelBus: () => b.info.vendor === 0x8086,
      IsAMDBus: () => b.info.vendor === 0x1022,
      IsNvidiaBus: () => false,
      IsNuvotonBus: () => false,
      Name: () => b.name,
      Vendor: () => b.info.vendor || 0,
      SubVendor: () => b.info.subVendor || 0,
      Product: () => b.info.device || 0,
      SubDevice: () => b.info.subDevice || 0,
      Port: () => b.info.port || 0,
      TransactionLock() {}, TransactionUnlock() {}, HasTransactionLock: () => true,
      log: (d) => logFn && logFn(typeof d === 'string' ? d : JSON.stringify(d)),
      pause: (ms) => require('./plugin-runtime').sleepSync(ms),
      FetchRamInfo: () => '',
      ReadByte: (a, r) => b.readByteData(a, r),
      ReadByteWithoutRegister: (a) => b.readByte(a),
      ReadWord: (a, r) => b.readWordData(a, r),
      ReadBlockBytes: (a, r, size) => {
        const out = [];
        for (let i = 0; i < size; i++) {
          const v = b.readByteData(a, r + i);
          if (v < 0) return [-1, out];
          out.push(v);
        }
        return [0, out];
      },
      ReadBlockWithoutRegister: (a, size) => {
        const out = [];
        for (let i = 0; i < size; i++) out.push(b.readByte(a));
        return [0, out];
      },
      WriteBlock: (a, r, size, data) => b.writeI2cBlock(a, r, data.slice(0, size)),
      WriteBlockWithoutRegister: (a, size, data) => (data.length ? b.writeI2cBlock(a, data[0], data.slice(1, size)) : -1),
      WriteWord: (a, r, w) => b.writeWordData(a, r, w),
      WriteByte: (a, r, v) => b.writeByteData(a, r, v),
      WriteQuick: (a) => b.writeQuick(a),
    };
    return api;
  }

  // SignalRGB FixedAddressBus facade for a plugin instance bound to `addr`.
  fixedFor(addr, logFn) {
    const f = this.free(logFn);
    return {
      ...f,
      GetAddress: () => addr,
      ReadByte: (r) => f.ReadByte(addr, r),
      ReadByteWithoutRegister: () => f.ReadByteWithoutRegister(addr),
      ReadWord: (r) => f.ReadWord(addr, r),
      ReadBlockBytes: (r, size) => f.ReadBlockBytes(addr, r, size),
      ReadBlockWithoutRegister: (size) => f.ReadBlockWithoutRegister(addr, size),
      WriteBlock: (r, size, data) => f.WriteBlock(addr, r, size, data),
      WriteBlockWithoutRegister: (size, data) => f.WriteBlockWithoutRegister(addr, size, data),
      WriteWord: (r, w) => f.WriteWord(addr, r, w),
      WriteByte: (r, v) => f.WriteByte(addr, r, v),
      WriteQuick: (a) => f.WriteQuick(a === undefined ? addr : a),
    };
  }
}

// ---------------------------------------------------------------- PawnIO ---
let koffi = null;
let lib = null;
let k32 = null;

function pawnioDllPath() {
  const candidates = [
    process.env.PAWNIO_DLL,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PawnIO', 'PawnIOLib.dll'),
    'C:\\Program Files\\PawnIO\\PawnIOLib.dll',
  ].filter(Boolean);
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

function loadPawnIO() {
  if (lib) return lib;
  if (process.platform !== 'win32') throw new Error('PawnIO is Windows-only');
  const dll = pawnioDllPath();
  if (!dll) throw new Error('PawnIO driver is not installed (https://pawnio.eu)');
  koffi = require('koffi');
  const l = koffi.load(dll);
  lib = {
    open: l.func('long __stdcall pawnio_open(_Out_ void **handle)'),
    load: l.func('long __stdcall pawnio_load(void *handle, const uint8_t *blob, size_t size)'),
    execute: l.func('long __stdcall pawnio_execute(void *handle, const char *name, void *inp, size_t in_size, void *out, size_t out_size, _Out_ size_t *ret)'),
    close: l.func('long __stdcall pawnio_close(void *handle)'),
  };
  const kernel = koffi.load('kernel32.dll');
  k32 = {
    CreateMutexA: kernel.func('void * __stdcall CreateMutexA(void *attrs, int initialOwner, const char *name)'),
    WaitForSingleObject: kernel.func('uint32_t __stdcall WaitForSingleObject(void *h, uint32_t ms)'),
    ReleaseMutex: kernel.func('int __stdcall ReleaseMutex(void *h)'),
  };
  return lib;
}

class PawnIOBus extends BusBase {
  constructor(handle, name, info) {
    super(name, info);
    this.handle = handle;
    this.mutex = k32.CreateMutexA(null, 0, 'Global\\Access_SMBUS.HTP.Method');
  }

  exec(fn, input, outCount) {
    const inp = Buffer.alloc(Math.max(1, input.length) * 8);
    input.forEach((v, i) => inp.writeBigUInt64LE(BigInt(v), i * 8));
    const outBuf = Buffer.alloc(Math.max(1, outCount) * 8);
    const ret = [0];
    const hr = lib.execute(this.handle, fn, inp, input.length, outBuf, outCount, ret);
    const out = [];
    for (let i = 0; i < outCount; i++) out.push(outBuf.readBigUInt64LE(i * 8));
    return { hr, out };
  }

  setSleepMode(mode) {
    try { this.exec('ioctl_set_sleep_mode', [mode], 0); } catch { /* older module */ }
  }

  xfer(addr, rw, command, size, data) {
    const t0 = process.hrtime.bigint();
    const inBytes = Buffer.alloc(72);
    inBytes.writeBigUInt64LE(BigInt(addr), 0);
    inBytes.writeBigUInt64LE(BigInt(rw), 8);
    inBytes.writeBigUInt64LE(BigInt(command), 16);
    inBytes.writeBigUInt64LE(BigInt(size), 24);
    if (data) data.copy(inBytes, 32, 0, Math.min(34, data.length));
    const outBytes = Buffer.alloc(40);
    const ret = [0];
    if (this.mutex) k32.WaitForSingleObject(this.mutex, 0xffffffff);
    let hr;
    try {
      hr = lib.execute(this.handle, 'ioctl_smbus_xfer', inBytes, 9, outBytes, 5, ret);
    } finally {
      if (this.mutex) k32.ReleaseMutex(this.mutex);
    }
    this.stats.tx++;
    this.stats.us += Number(process.hrtime.bigint() - t0) / 1000;
    if (hr !== 0) this.stats.errors++;
    return { status: hr === 0 ? 0 : -1, data: outBytes };
  }
}

function moduleDirs(extra) {
  return [
    extra,
    process.resourcesPath && path.join(process.resourcesPath, 'pawnio'),
    path.join(__dirname, '..', '..', 'resources', 'pawnio'),
  ].filter(Boolean);
}

function findModule(file, extra) {
  for (const d of moduleDirs(extra)) {
    const p = path.join(d, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function openModule(file, extra) {
  const p = findModule(file, extra);
  if (!p) return null;
  const blob = fs.readFileSync(p);
  const h = [null];
  if (lib.open(h) !== 0 || !h[0]) return null;
  if (lib.load(h[0], blob, blob.length) !== 0) {
    lib.close(h[0]);
    return null;
  }
  return h[0];
}

function identity(bus) {
  try {
    const { hr, out } = bus.exec('ioctl_identity', [0], 3);
    if (hr !== 0) return {};
    const v = out[2];
    return {
      vendor: Number(v & 0xffffn),
      device: Number((v >> 16n) & 0xffffn),
      subVendor: Number((v >> 32n) & 0xffffn),
      subDevice: Number((v >> 48n) & 0xffffn),
    };
  } catch {
    return {};
  }
}

// Open every SMBus the PawnIO modules can reach. Returns BusBase[].
function openBuses({ moduleDir, sleepMode, log } = {}) {
  const buses = [];
  try {
    loadPawnIO();
  } catch (e) {
    log && log(`SMBus unavailable: ${e.message}`);
    return { buses, error: e.message };
  }
  const tryOpen = (file, name, port) => {
    const h = openModule(file, moduleDir);
    if (!h) return;
    const bus = new PawnIOBus(h, name, { system: true, port });
    if (port !== undefined) {
      const r = bus.exec('ioctl_piix4_port_sel', [port], 1);
      if (r.hr !== 0) {
        lib.close(h);
        return;
      }
    }
    Object.assign(bus.info, identity(bus));
    if (!bus.info.vendor) bus.info.vendor = file.includes('PIIX4') ? 0x1022 : 0x8086;
    bus.setSleepMode(sleepMode === undefined ? SLEEP_MODE.ALWAYS_SLEEP : sleepMode);
    buses.push(bus);
    log && log(`SMBus opened: ${name} (vendor 0x${bus.info.vendor.toString(16)})`);
  };
  tryOpen('SmbusI801.bin', 'i801');
  tryOpen('SmbusPIIX4.bin', 'piix4_0', 0);
  tryOpen('SmbusPIIX4.bin', 'piix4_1', 1);
  if (!buses.length) return { buses, error: 'No SMBus controller found (PawnIO modules missing or unsupported chipset)' };
  return { buses };
}

// In-memory bus used by tests and the simulator.
class MockBus extends BusBase {
  constructor(devices) {
    super('mock', { system: true, vendor: 0x8086 });
    this.devices = devices || {}; // addr -> { regs: Map/obj, onWrite(reg,val) }
    this.writes = [];
  }
  xfer(addr, rw, command, size, data) {
    this.stats.tx++;
    const dev = this.devices[addr];
    const out = Buffer.alloc(40);
    if (!dev) return { status: -1, data: out };
    if (rw === WRITE) {
      if (size === SIZE.BYTE_DATA) {
        this.writes.push([addr, command, data[0]]);
        dev.regs[command] = data[0];
        dev.onWrite && dev.onWrite(command, data[0]);
      } else if (size === SIZE.I2C_BLOCK_DATA || size === SIZE.BLOCK_DATA) {
        for (let i = 0; i < data[0]; i++) dev.regs[command + i] = data[1 + i];
      }
      return { status: 0, data: out };
    }
    if (size === SIZE.WORD_DATA && dev.readWord) {
      const w = dev.readWord(command);
      out[0] = w & 0xff;
      out[1] = (w >> 8) & 0xff;
    } else {
      out[0] = dev.regs[command] || 0;
      out[1] = dev.regs[command + 1] || 0;
    }
    return { status: 0, data: out };
  }
}

module.exports = { openBuses, BusBase, MockBus, SIZE, READ, WRITE, SLEEP_MODE, isProtectedWrite, pawnioDllPath };
