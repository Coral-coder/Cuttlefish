'use strict';
// Silent self-update from GitHub Releases (electron-updater). New versions are
// downloaded in the background and installed automatically, then the app
// relaunches - no user interaction needed.
let autoUpdater = null;
let state = { state: 'idle', version: null, error: null, progress: 0, lastCheck: null };
let ctx = null;

function status() { return { ...state }; }

function set(patch) {
  state = { ...state, ...patch };
  if (ctx && ctx.onStatus) ctx.onStatus(status());
}

function init(c) {
  ctx = c;
  if (!c.app.isPackaged) {
    set({ state: 'dev' });
    return;
  }
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    set({ state: 'error', error: e.message });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', lastCheck: Date.now() }));
  autoUpdater.on('update-not-available', () => set({ state: 'current' }));
  autoUpdater.on('update-available', (i) => set({ state: 'downloading', version: i.version }));
  autoUpdater.on('download-progress', (p) => set({ progress: Math.round(p.percent || 0) }));
  autoUpdater.on('error', (e) => set({ state: 'error', error: String(e && e.message ? e.message : e) }));
  autoUpdater.on('update-downloaded', async (i) => {
    set({ state: 'ready', version: i.version });
    if (ctx.settings.get('autoUpdate') === false) return;
    try { await ctx.beforeInstall(); } catch { /* best effort */ }
    // isSilent = true, isForceRunAfter = true
    autoUpdater.quitAndInstall(true, true);
  });
  setTimeout(check, 15000);
  setInterval(check, 3 * 60 * 60 * 1000);
}

function check() {
  if (!autoUpdater) return status();
  autoUpdater.checkForUpdates().catch((e) => set({ state: 'error', error: e.message }));
  return status();
}

module.exports = { init, check, status };
