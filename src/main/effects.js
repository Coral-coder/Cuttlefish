'use strict';
// Effect library: SignalRGB-style LightScripts (HTML pages with <meta> controls
// drawing to a 320x200 canvas). Effects render in an offscreen Chromium window;
// every painted frame is handed to the device hosts for LED sampling.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function parseAttrs(tag) {
  const attrs = {};
  const re = /([A-Za-z_:][-\w:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  const body = tag.replace(/^<\s*meta/i, '').replace(/\/?>$/, '');
  while ((m = re.exec(body))) {
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[m[1].toLowerCase()] = decodeEntities(v);
  }
  return attrs;
}

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const CONTROL_TYPES = new Set(['number', 'hue', 'boolean', 'color', 'textfield', 'list', 'combobox']);

function parseEffect(html, file) {
  const head = (/<head[\s\S]*?<\/head>/i.exec(html) || [html.slice(0, 20000)])[0];
  const meta = { title: '', description: '', publisher: '', properties: [], meters: [], requirements: [] };
  const t = /<title>([\s\S]*?)<\/title>/i.exec(head);
  if (t) meta.title = decodeEntities(t[1].trim());
  const tags = head.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const a = parseAttrs(tag);
    if (a.meter) {
      meta.meters.push({
        name: a.meter, type: a.type || 'linear', x: +a.x || 0, y: +a.y || 0, width: +a.width || 0, height: +a.height || 0,
        h: a.h || '0-360', s: a.s || '0-100', l: a.l || '0-100', string: a.string, confidence: +a.confidence || 70,
      });
      continue;
    }
    if (a.property && a.type && CONTROL_TYPES.has(a.type.toLowerCase())) {
      const type = a.type.toLowerCase() === 'list' ? 'combobox' : a.type.toLowerCase();
      const p = { property: a.property, label: a.label || a.property, type, default: a.default ?? '', tooltip: a.tooltip || '' };
      if (a.min !== undefined) p.min = a.min;
      if (a.max !== undefined) p.max = a.max;
      if (a.step !== undefined) p.step = a.step;
      if (a.values !== undefined) p.values = a.values.split(',').map((v) => v.trim());
      meta.properties.push(p);
      continue;
    }
    if (a.title && !meta.title) meta.title = a.title;
    if (a.description) meta.description = a.description;
    if (a.publisher) meta.publisher = a.publisher;
    if (a.requirements) meta.requirements = a.requirements.split(',').map((s) => s.trim().toLowerCase());
  }
  if (!meta.title) meta.title = path.basename(file || 'Effect', path.extname(file || ''));
  meta.usesAudio = /engine\.audio/.test(html) || meta.requirements.includes('audio');
  meta.usesScreen = /engine\.zone/.test(html) || meta.meters.length > 0 || meta.requirements.includes('screen');
  return meta;
}

function coerceEffectValue(p, v) {
  if (v === undefined || v === null || v === '') v = p.default;
  switch (p.type) {
    case 'number':
    case 'hue': {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    case 'boolean':
      return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
    default:
      return String(v);
  }
}

function scanEffects(dirs) {
  const out = [];
  const seen = new Set();
  const walk = (d, source, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, source, depth + 1);
      } else if (/\.html?$/i.test(e.name)) {
        try {
          const html = fs.readFileSync(p, 'utf8');
          if (!/<canvas/i.test(html) && !/<meta[^>]+property=/i.test(html)) continue;
          const meta = parseEffect(html, p);
          const id = `${source}:${meta.title}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push({ id, file: p, source, ...meta });
        } catch { /* unreadable */ }
      }
    }
  };
  for (const { dir, source } of dirs) walk(dir, source, 0);
  out.sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

class EffectRunner extends EventEmitter {
  constructor({ BrowserWindow, preload, width = 320, height = 200, fps = 60 }) {
    super();
    this.BrowserWindow = BrowserWindow;
    this.preload = preload;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.win = null;
    this.effect = null;
    this.values = {};
    this.frames = 0;
  }

  load(effect, values) {
    this.effect = effect;
    this.values = {};
    for (const p of effect.properties) this.values[p.property] = coerceEffectValue(p, values ? values[p.property] : undefined);
    if (!this.win || this.win.isDestroyed()) this._create();
    this.win.loadFile(effect.file).catch((e) => this.emit('error', e));
  }

  _create() {
    this.win = new this.BrowserWindow({
      show: false,
      width: this.width,
      height: this.height,
      useContentSize: true,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      webPreferences: {
        offscreen: true,
        preload: this.preload,
        contextIsolation: false,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        zoomFactor: 1,
      },
    });
    this.win.webContents.setFrameRate(this.fps);
    this.win.webContents.setAudioMuted(true);
    this.win.webContents.on('paint', (event, dirty, image) => {
      let img = image;
      const sz = img.getSize();
      if (sz.width !== this.width || sz.height !== this.height) img = img.resize({ width: this.width, height: this.height, quality: 'good' });
      this.frames++;
      this.emit('frame', img.toBitmap(), this.width, this.height);
    });
    this.win.webContents.on('render-process-gone', () => {
      this.emit('crash');
      setTimeout(() => this.effect && this.load(this.effect, this.values), 1000);
    });
    this.win.webContents.on('console-message', (...args) => {
      const msg = typeof args[0] === 'object' && args[0] && args[0].message ? args[0].message : args[2];
      this.emit('console', msg);
    });
  }

  setValue(prop, value) {
    if (!this.effect) return;
    const p = this.effect.properties.find((q) => q.property === prop);
    if (!p) return;
    const v = coerceEffectValue(p, value);
    this.values[prop] = v;
    if (this.win && !this.win.isDestroyed()) {
      const js = `(function(){ try { window[${JSON.stringify(prop)}] = ${JSON.stringify(v)};
        var cb = window[${JSON.stringify(`on${prop}Changed`)}]; if (typeof cb === 'function') cb(); } catch (e) { console.error(e); } })();`;
      this.win.webContents.executeJavaScript(js).catch(() => {});
    }
  }

  send(channel, data) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, data);
  }

  setFps(fps) {
    this.fps = fps;
    if (this.win && !this.win.isDestroyed()) this.win.webContents.setFrameRate(fps);
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { parseEffect, parseAttrs, scanEffects, EffectRunner, coerceEffectValue };
