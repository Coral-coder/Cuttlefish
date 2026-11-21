'use strict';
// Import from an existing SignalRGB installation on this PC: plugins, effects,
// device layout, settings, and the Firebase client config (so the user can sign
// into their own SignalRGB account from Cuttlefish). Everything read here is the
// user's own local installation — no network access to SignalRGB's servers.

const fs = require('fs');
const os = require('os');
const path = require('path');

function existing(paths) {
  return [...new Set(paths)].filter((p) => {
    try { return p && fs.existsSync(p); } catch { return false; }
  });
}

function env(name, fallback) {
  return process.env[name] || fallback;
}

// Candidate roots for the SignalRGB application itself (its resources/plugins).
function installRoots() {
  const home = os.homedir();
  const local = env('LOCALAPPDATA', path.join(home, 'AppData', 'Local'));
  const roots = [];
  // Squirrel/Electron layout: %LOCALAPPDATA%\VortxEngine\app-<ver>\Signal-x64
  for (const base of [path.join(local, 'VortxEngine'), path.join(local, 'SignalRgb'), path.join(local, 'Programs', 'SignalRGB')]) {
    try {
      const apps = fs.readdirSync(base).filter((d) => /^app-/.test(d)).sort();
      if (apps.length) roots.push(path.join(base, apps[apps.length - 1]));
      else roots.push(base);
    } catch { /* not here */ }
  }
  // Program Files installs
  for (const pf of [env('ProgramFiles', 'C:\\Program Files'), env('ProgramFiles(x86)', 'C:\\Program Files (x86)')]) {
    roots.push(path.join(pf, 'SignalRGB'), path.join(pf, 'WhirlwindFX', 'SignalRGB'));
  }
  return existing(roots);
}

// Candidate roots for SignalRGB user data (settings, cache, downloaded effects).
function dataRoots() {
  const home = os.homedir();
  const local = env('LOCALAPPDATA', path.join(home, 'AppData', 'Local'));
  const roaming = env('APPDATA', path.join(home, 'AppData', 'Roaming'));
  const docs = [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')];
  const roots = [];
  for (const d of docs) roots.push(path.join(d, 'WhirlwindFX'));
  for (const b of [local, roaming]) roots.push(path.join(b, 'WhirlwindFX'), path.join(b, 'SignalRgb'), path.join(b, 'VortxEngine'));
  return existing(roots);
}

function walkFind(dir, test, { maxDepth = 4, maxHits = 50, skip = /^(node_modules|GPUCache|Cache|Code Cache|logs?)$/i } = {}) {
  const hits = [];
  const go = (d, depth) => {
    if (hits.length >= maxHits || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= maxHits) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!skip.test(e.name)) go(p, depth + 1);
      } else if (test(e.name, p)) {
        hits.push(p);
      }
    }
  };
  go(dir, 0);
  return hits;
}

// Pull a Firebase web config out of local app files. The config (apiKey,
// authDomain, projectId, databaseURL, ...) is shipped in the clear in every
// Firebase client; we only read it from the user's own installed files.
const FB_KEYS = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];

function parseFirebaseConfig(text) {
  const out = {};
  for (const k of FB_KEYS) {
    // apiKey: "AIza...",  or  "apiKey":"AIza...",  or  apiKey='AIza...'
    const re = new RegExp(`["']?${k}["']?\\s*[:=]\\s*["']([^"']+)["']`);
    const m = re.exec(text);
    if (m) out[k] = m[1];
  }
  // A Firebase apiKey looks like AIzaSy...; require at least that + a project to trust it.
  if (out.apiKey && /^AIza[0-9A-Za-z_\-]{10,}$/.test(out.apiKey) && (out.projectId || out.authDomain || out.databaseURL)) {
    if (!out.projectId && out.authDomain) out.projectId = out.authDomain.replace(/\.firebaseapp\.com$/, '');
    if (!out.databaseURL && out.projectId) out.databaseURL = `https://${out.projectId}-default-rtdb.firebaseio.com`;
    return out;
  }
  return null;
}

function findFirebaseConfig(roots) {
  for (const root of roots) {
    const files = walkFind(root, (name) => /\.(js|json|txt|cfg|conf|qml|rcc|dat)$/i.test(name) || /config/i.test(name), { maxDepth: 5, maxHits: 400 });
    // Prefer small-ish text files; scan larger ones too but cap read size.
    for (const f of files) {
      let text;
      try {
        const st = fs.statSync(f);
        if (st.size > 8 * 1024 * 1024) continue;
        text = fs.readFileSync(f, 'latin1');
      } catch { continue; }
      if (!/apiKey/.test(text)) continue;
      // scan each apiKey neighbourhood (binaries may hold several config blobs)
      let idx = 0;
      while ((idx = text.indexOf('apiKey', idx)) !== -1) {
        const cfg = parseFirebaseConfig(text.slice(Math.max(0, idx - 400), idx + 800));
        if (cfg) return { config: cfg, source: f };
        idx += 6;
      }
    }
  }
  return null;
}

function readJsonMaybe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Locate SignalRGB settings/layout files (format varies by version; we keep the
// raw object and map what we recognise).
function findSettings(dataRootsList) {
  const out = [];
  for (const root of dataRootsList) {
    for (const f of walkFind(root, (name) => /(settings|config|layout|devices|profile).*\.json$/i.test(name), { maxDepth: 4, maxHits: 40 })) {
      const json = readJsonMaybe(f);
      if (json) out.push({ file: f, data: json });
    }
  }
  return out;
}

function pluginDirs(installRootsList, dataRootsList) {
  const dirs = [];
  for (const r of installRootsList) {
    for (const sub of ['Signal-x64/Plugins', 'resources/Plugins', 'Plugins']) dirs.push(path.join(r, sub));
  }
  for (const r of dataRootsList) dirs.push(path.join(r, 'Plugins'));
  return existing(dirs);
}

function effectDirs(installRootsList, dataRootsList) {
  const dirs = [];
  for (const r of installRootsList) {
    for (const sub of ['Signal-x64/Effects', 'resources/Effects', 'Effects']) dirs.push(path.join(r, sub));
  }
  for (const r of dataRootsList) dirs.push(path.join(r, 'Effects'), r);
  return existing(dirs);
}

// Survey the machine for an existing SignalRGB installation.
function detect() {
  const installs = installRoots();
  const datas = dataRoots();
  const found = installs.length > 0 || datas.length > 0;
  const fb = found ? findFirebaseConfig([...installs, ...datas]) : null;
  return {
    found,
    platform: process.platform,
    installRoots: installs,
    dataRoots: datas,
    pluginDirs: pluginDirs(installs, datas),
    effectDirs: effectDirs(installs, datas),
    settingsFiles: findSettings(datas).map((s) => s.file),
    firebase: fb ? { config: fb.config, source: fb.source, haveApiKey: !!fb.config.apiKey } : null,
  };
}

// Map any recognisable SignalRGB settings into Cuttlefish settings. Returns a
// partial { brightness, placements, params } — best effort, never throws.
function importSettings(settingsFiles) {
  const result = { brightness: null, notes: [] };
  for (const { data } of settingsFiles.map((f) => ({ data: readJsonMaybe(f) })).filter((x) => x.data)) {
    const b = data.brightness ?? data.globalBrightness ?? (data.settings && data.settings.brightness);
    if (typeof b === 'number') result.brightness = b > 1 ? b / 100 : b;
  }
  return result;
}

module.exports = { detect, parseFirebaseConfig, findFirebaseConfig, pluginDirs, effectDirs, dataRoots, installRoots, importSettings, walkFind };
