'use strict';
// Downloads that Cuttlefish fetches on the user's request instead of bundling:
//  - the public SignalRGB device plugin repository (JavaScript plugins)
//  - PawnIO SMBus modules (signed driver modules used for RGB memory)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const tar = require('./tar');
const { pawnioDllPath } = require('../devicehost/smbus');

const PLUGIN_ARCHIVE = 'https://gitlab.com/api/v4/projects/signalrgb%2Fsignal-plugins/repository/archive.tar.gz?sha=master';
const PAWNIO_MODULES_API = 'https://api.github.com/repos/namazso/PawnIO.Modules/releases/latest';
const MODULE_FILES = ['SmbusI801.bin', 'SmbusPIIX4.bin'];

function officialPluginDir(userDir) {
  return path.join(userDir, 'plugins-official');
}

function officialInfo(userDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(officialPluginDir(userDir), '.cuttlefish.json'), 'utf8'));
  } catch {
    return { installed: false };
  }
}

// Prefer Electron's network stack (honours system proxy settings) when available.
function httpFetch(url, opts) {
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net.fetch(url, opts);
  } catch { /* plain Node */ }
  return fetch(url, opts);
}

async function download(url, onProgress) {
  const res = await httpFetch(url, { headers: { 'User-Agent': 'Cuttlefish-RGB' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}) ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  for await (const c of res.body) {
    chunks.push(Buffer.from(c));
    got += c.length;
    if (onProgress) onProgress(total ? got / total : 0);
  }
  return Buffer.concat(chunks);
}

async function installOfficialPlugins(userDir, progress) {
  const p = progress || (() => {});
  p({ task: 'plugins', state: 'downloading' });
  const buf = await download(PLUGIN_ARCHIVE, (f) => p({ task: 'plugins', state: 'downloading', progress: f }));
  const dest = officialPluginDir(userDir);
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  p({ task: 'plugins', state: 'extracting' });
  const n = tar.extract(buf, tmp, (name) => {
    const m = /^[^/]+\/Plugins\/(.+)$/.exec(name);
    if (!m) return null;
    if (/\.(test|spec)\.js$/i.test(m[1]) || /(^|\/)tests?\//i.test(m[1])) return null;
    return /\.(js|json|png|jpg)$/i.test(m[1]) ? m[1] : null;
  });
  fs.writeFileSync(path.join(tmp, '.cuttlefish.json'), JSON.stringify({ installed: true, files: n, date: new Date().toISOString(), source: PLUGIN_ARCHIVE }));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  p({ task: 'plugins', state: 'done', files: n });
  return n;
}

// ---------------------------------------------------------------- unzip
function unzip(buf, onFile) {
  // Find end of central directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const xlen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    off += 46 + nlen + xlen + clen;
    const lnlen = buf.readUInt16LE(local + 26);
    const lxlen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lxlen;
    const data = buf.subarray(start, start + csize);
    if (name.endsWith('/')) continue;
    const content = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (content) onFile(name, content);
  }
}

function moduleDir(userDir) {
  return path.join(userDir, 'pawnio');
}

function pawnioStatus(userDir) {
  const dirs = [moduleDir(userDir), process.resourcesPath ? path.join(process.resourcesPath, 'pawnio') : null].filter(Boolean);
  const modules = MODULE_FILES.filter((f) => dirs.some((d) => fs.existsSync(path.join(d, f))));
  return { platform: process.platform, driver: process.platform === 'win32' ? !!pawnioDllPath() : false, modules };
}

async function installModules(userDir, progress) {
  const rel = await (await httpFetch(PAWNIO_MODULES_API, { headers: { 'User-Agent': 'Cuttlefish-RGB', Accept: 'application/vnd.github+json' } })).json();
  const dir = moduleDir(userDir);
  fs.mkdirSync(dir, { recursive: true });
  let found = 0;
  for (const a of rel.assets || []) {
    if (!/\.(zip|bin)$/i.test(a.name)) continue;
    progress({ task: 'pawnio', state: `downloading ${a.name}` });
    const buf = await download(a.browser_download_url);
    if (/\.bin$/i.test(a.name)) {
      if (MODULE_FILES.includes(a.name)) { fs.writeFileSync(path.join(dir, a.name), buf); found++; }
    } else {
      unzip(buf, (name, content) => {
        const base = path.basename(name);
        if (MODULE_FILES.includes(base)) { fs.writeFileSync(path.join(dir, base), content); found++; }
      });
    }
  }
  return found;
}

function installPawnIO(userDir, progress) {
  const p = progress || (() => {});
  return new Promise((resolve) => {
    const finish = async (driverResult) => {
      let modules = 0;
      try { modules = await installModules(userDir, p); } catch (e) { p({ task: 'pawnio', state: `module download failed: ${e.message}` }); }
      const st = pawnioStatus(userDir);
      p({ task: 'pawnio', state: 'done', status: st });
      resolve({ ...st, driverResult, modulesDownloaded: modules });
    };
    if (process.platform !== 'win32') return finish('unsupported');
    if (pawnioDllPath()) return finish('already-installed');
    p({ task: 'pawnio', state: 'installing driver (winget)' });
    execFile('winget', ['install', '--id', 'namazso.PawnIO', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'],
      { windowsHide: true, timeout: 10 * 60 * 1000 }, (err) => finish(err ? `winget failed: ${err.message}` : 'installed'));
  });
}

module.exports = { officialPluginDir, officialInfo, installOfficialPlugins, pawnioStatus, installPawnIO, unzip };
