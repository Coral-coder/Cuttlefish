'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  effect: 'builtin:Rainbow Wave',
  effectProps: {}, // effectId -> { prop: value }
  favorites: [],
  brightness: 1,
  deviceBrightness: {},
  enabled: {},
  placements: {},
  params: {},
  channelCounts: {},
  fps: 60,
  effectDirs: [],
  pluginDirs: [],
  useSignalRgbFolders: true,
  officialPluginsInstalled: false,
  openrgb: { enabled: false, host: '127.0.0.1', port: 6742 },
  fury: { enabled: true, profile: 'balanced' },
  smbusPlugins: false,
  smbusEnabled: true,
  mapping: { port: 7531, settleMs: 250 },
  audio: true,
  screen: false,
  autostart: true,
  autoUpdate: true,
  startMinimized: false,
  firstRun: true,
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...saved };
      for (const k of ['openrgb', 'fury', 'mapping']) this.data[k] = { ...DEFAULTS[k], ...(saved[k] || {}) };
    } catch {
      /* first run */
    }
    this.timer = null;
  }
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; this.save(); }
  patch(obj) { Object.assign(this.data, obj); this.save(); }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('settings save failed', e);
    }
  }
}

module.exports = { Settings, DEFAULTS };
