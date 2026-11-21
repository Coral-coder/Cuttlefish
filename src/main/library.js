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

const PLUGIN_ARCHIVES = [
  'https://gitlab.com/api/v4/projects/signalrgb%2Fsignal-plugins/repository/archive.tar.gz?sha=master',
  'https://gitlab.com/signalrgb/signal-plugins/-/archive/master/signal-plugins-master.tar.gz',
];
const PLUGIN_ARCHIVE = PLUGIN_ARCHIVES[0];
const UA = 'Cuttlefish/1.0 (+https://github.com/Coral-coder/Cuttlefish)';
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

// Some hosts reject one network stack or another (GitLab answers Chromium's
// default request with 406), so try Node's fetch first, then Electron's net
// stack (which honours system proxy settings).
function fetchers() {
  const list = [(u, o) => fetch(u, o)];
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') list.push((u, o) => net.fetch(u, o));
  } catch { /* plain Node */ }
  return list;
}

async function httpFetch(url, opts) {
  let last = null;
  for (const f of fetchers()) {
    try {
      const res = await f(url, opts);
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status} from ${url}`);
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error(`Download failed: ${url}`);
}

async function downloadAny(urls, onProgress) {
  let last = null;
  for (const u of urls) {
    try { return await download(u, onProgress); } catch (e) { last = e; }
  }
  throw last;
}

async function download(url, onProgress) {
  const res = await httpFetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
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

const REPO_API = 'https://gitlab.com/api/v4/projects/signalrgb%2Fsignal-plugins/repository';
const RAW_BASE = 'https://gitlab.com/signalrgb/signal-plugins/-/raw/master/';

function pluginPathFilter(rel) {
  if (/\.(test|spec)\.js$/i.test(rel) || /(^|\/)tests?\//i.test(rel)) return null;
  return /\.(js|json)$/i.test(rel) ? rel : null;
}

// Fallback when archive downloads are refused: list the tree, fetch files one by one.
async function fetchPluginFilesIndividually(dest, p) {
  const files = [];
  let url = `${REPO_API}/tree?path=Plugins&recursive=true&per_page=100&pagination=keyset&order_by=path&sort=asc`;
  while (url) {
    const res = await httpFetch(url, { headers: { 'User-Agent': UA } });
    for (const e of await res.json()) {
      if (e.type === 'blob' && e.path.startsWith('Plugins/')) {
        const rel = pluginPathFilter(e.path.slice('Plugins/'.length));
        if (rel) files.push({ path: e.path, rel });
      }
    }
    const link = res.headers.get('link') || '';
    const m = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = m ? m[1] : null;
  }
  let done = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function getOne(f) {
    const urls = [RAW_BASE + f.path.split('/').map(encodeURIComponent).join('/'),
      `${REPO_API}/files/${encodeURIComponent(f.path)}/raw?ref=master`];
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const u of urls) {
        try {
          const res = await httpFetch(u, { headers: { 'User-Agent': UA } });
          const buf = Buffer.from(await res.arrayBuffer());
          const target = path.join(dest, f.rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, buf);
          return true;
        } catch { /* try next */ }
      }
      await sleep(1000 * (attempt + 1)); // rate limited / transient
    }
    return false;
  }
  const queue = files.slice();
  let ok = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const f = queue.shift();
      if (await getOne(f)) ok++;
      done++;
      p({ task: 'plugins', state: 'downloading', progress: done / files.length });
    }
  }));
  if (!ok) throw new Error('Could not download any plugin files');
  return ok;
}

async function installOfficialPlugins(userDir, progress) {
  const p = progress || (() => {});
  p({ task: 'plugins', state: 'downloading' });
  const dest = officialPluginDir(userDir);
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  let n = 0;
  let method = 'archive';
  try {
    const buf = await downloadAny(PLUGIN_ARCHIVES, (f) => p({ task: 'plugins', state: 'downloading', progress: f }));
    p({ task: 'plugins', state: 'extracting' });
    n = tar.extract(buf, tmp, (name) => {
      const m = /^[^/]+\/Plugins\/(.+)$/.exec(name);
      return m ? pluginPathFilter(m[1]) : null;
    });
  } catch (e) {
    method = 'files';
    p({ task: 'plugins', state: 'downloading', progress: 0, note: `archive refused (${e.message}); fetching files individually` });
    n = await fetchPluginFilesIndividually(tmp, p);
  }
  fs.writeFileSync(path.join(tmp, '.cuttlefish.json'), JSON.stringify({ installed: true, files: n, date: new Date().toISOString(), source: PLUGIN_ARCHIVE, method }));
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
  const rel = await (await httpFetch(PAWNIO_MODULES_API, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } })).json();
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
      { windowsHide: true, timeout: 10 * 60 * 1000 }, async (err) => {
        if (!err && pawnioDllPath()) return finish('installed (winget)');
        // Fallback: official installer from the PawnIO.Setup GitHub releases.
        try {
          p({ task: 'pawnio', state: 'downloading PawnIO installer' });
          const buf = await download('https://github.com/namazso/PawnIO.Setup/releases/latest/download/PawnIO_setup.exe');
          const exe = path.join(userDir, 'PawnIO_setup.exe');
          fs.writeFileSync(exe, buf);
          p({ task: 'pawnio', state: 'installing driver' });
          execFile(exe, ['-install', '-silent'], { windowsHide: true, timeout: 5 * 60 * 1000 }, (e2) =>
            finish(pawnioDllPath() ? 'installed (setup)' : `install failed: ${(e2 || err || {}).message || 'unknown'}`));
        } catch (e) {
          finish(`install failed: ${e.message}`);
        }
      });
  });
}

module.exports = { officialPluginDir, officialInfo, installOfficialPlugins, pawnioStatus, installPawnIO, unzip };
