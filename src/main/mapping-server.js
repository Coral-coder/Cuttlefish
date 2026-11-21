'use strict';
// HTTPS + WebSocket server that hosts the phone camera mapper web app.
// Phones require a secure context for camera access, so we serve TLS with a
// self-signed certificate generated on first use (the phone shows a one-time
// warning which the user accepts).

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { bitsFor } = require('../shared/layout');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push({ name, address: a.address });
    }
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  out.sort((a, b) => rank(a.address) - rank(b.address));
  return out;
}

async function loadCert(dir, ips) {
  const file = path.join(dir, 'mapping-cert.json');
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (ips.every((ip) => c.ips.includes(ip)) && Date.parse(c.expires) > Date.now() + 86400000) return c;
  } catch { /* regenerate */ }
  const selfsigned = require('selfsigned');
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 5);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Cuttlefish Mapper' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))] },
    ],
  });
  const c = { key: pems.private, cert: pems.cert, ips, expires: notAfter.toISOString() };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c));
  return c;
}

class MappingServer extends EventEmitter {
  // getLayout() -> { total, offsets, items }
  constructor({ dataDir, port = 7531, getLayout, settleMs = 250 }) {
    super();
    this.dataDir = dataDir;
    this.port = port;
    this.getLayout = getLayout;
    this.settleMs = settleMs;
    this.server = null;
    this.session = null;
    this.clients = new Set();
    this.token = Math.random().toString(36).slice(2, 10);
  }

  async start() {
    if (this.server) return this.info();
    const ips = lanAddresses().map((a) => a.address);
    const cert = await loadCert(this.dataDir, ips);
    this.server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => this._http(req, res));
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.wss.on('connection', (ws, req) => this._ws(ws, req));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', resolve);
    });
    return this.info();
  }

  info() {
    const addrs = lanAddresses();
    const urls = addrs.map((a) => `https://${a.address}:${this.port}/?t=${this.token}`);
    return { running: !!this.server, port: this.port, urls, url: urls[0] || `https://localhost:${this.port}/?t=${this.token}`, clients: this.clients.size, session: this.session ? this.session.status : null };
  }

  stop() {
    this._end(null);
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
    this.server = null;
  }

  _http(req, res) {
    const u = new URL(req.url, 'https://x');
    let p = u.pathname === '/' ? '/mapper.html' : u.pathname;
    p = path.normalize(p).replace(/^([/\\])+/, '');
    const file = path.join(WEB_DIR, p);
    if (!file.startsWith(WEB_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  }

  _send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* closed */ }
  }

  _broadcast(msg) {
    for (const ws of this.clients) this._send(ws, msg);
  }

  _ws(ws, req) {
    const u = new URL(req.url, 'https://x');
    if (u.searchParams.get('t') !== this.token) {
      this._send(ws, { type: 'error', msg: 'This link has expired. Re-scan the QR code shown in Cuttlefish.' });
      ws.close();
      return;
    }
    this.clients.add(ws);
    this.emit('status', this.info());
    const layout = this.getLayout();
    this._send(ws, { type: 'info', total: layout.total, items: layout.items.length, bits: bitsFor(Math.max(2, layout.total)) });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      this._onMessage(ws, m);
    });
    ws.on('close', () => {
      this.clients.delete(ws);
      if (this.session && this.session.ws === ws) this._end(null);
      this.emit('status', this.info());
    });
  }

  _onMessage(ws, m) {
    switch (m.type) {
      case 'start':
        this._begin(ws, m);
        break;
      case 'captured':
        if (this.session && this.session.ws === ws && m.step === this.session.step) this._next();
        break;
      case 'result':
        if (this.session && this.session.ws === ws) {
          const report = this.emitResult(m);
          this._send(ws, { type: 'done', report });
          this._end(report);
        }
        break;
      case 'cancel':
        this._end(null);
        break;
      case 'preview':
        // Light everything (or nothing) so the user can frame the shot.
        this.emit('pattern', m.on ? { kind: 'full', level: Math.round((Math.max(5, Math.min(100, Number(m.level) || 40)) / 100) * 255) } : { kind: 'off' });
        break;
      case 'preview-end':
        if (!this.session) this.emit('pattern', null);
        break;
      default:
        break;
    }
  }

  emitResult(m) {
    const res = { report: null };
    this.emit('result', { camera: m.camera, points: m.points || [], photo: m.photo || null }, res);
    return res.report;
  }

  _begin(ws, m) {
    const layout = this.getLayout();
    if (!layout.total) {
      this._send(ws, { type: 'error', msg: 'No devices with LEDs are connected yet.' });
      return;
    }
    const bits = bitsFor(Math.max(2, layout.total));
    // Lower brightness = less bloom and fewer wall reflections; precise mode lights only
    // every Kth LED at a time so reflections of neighbouring LEDs can't mix into codes.
    const level = Math.round((Math.max(5, Math.min(100, Number(m.level) || 40)) / 100) * 255);
    const mode = m.mode === 'fast' ? 'fast' : 'precise';
    const groups = mode === 'precise' ? Math.min(4, Math.max(1, layout.total)) : 1;
    const steps = [{ kind: 'off' }];
    for (let phase = 0; phase < groups; phase++) {
      const sparse = groups > 1 ? { mod: groups, phase } : {};
      steps.push({ kind: 'full', level, ...sparse });
      for (let b = 0; b < bits; b++) {
        steps.push({ kind: 'bit', bit: b, inv: false, level, ...sparse });
        steps.push({ kind: 'bit', bit: b, inv: true, level, ...sparse });
      }
    }
    this.session = { ws, steps, step: -1, total: layout.total, bits, status: 'running', settle: Number(m.settleMs) || this.settleMs };
    this.emit('session', { active: true, layout });
    this._broadcast({ type: 'session', total: layout.total, bits, steps: steps.length, mode });
    this._next();
  }

  _next() {
    const s = this.session;
    if (!s) return;
    s.step++;
    if (s.step >= s.steps.length) {
      this.emit('pattern', { kind: 'off' });
      this._send(s.ws, { type: 'decode', total: s.total, bits: s.bits });
      s.status = 'decoding';
      return;
    }
    const pattern = s.steps[s.step];
    this.emit('pattern', pattern);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      this._send(s.ws, { type: 'step', step: s.step, of: s.steps.length, pattern });
    }, s.settle);
  }

  _end(report) {
    if (this.session) clearTimeout(this.session.timer);
    const had = !!this.session;
    this.session = null;
    if (had) {
      this.emit('pattern', null);
      this.emit('session', { active: false, report });
    }
  }
}

module.exports = { MappingServer, lanAddresses };
