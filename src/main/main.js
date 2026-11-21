'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell, utilityProcess, powerMonitor, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Settings } = require('./settings');
const { scanEffects, EffectRunner } = require('./effects');
const { DeviceManager } = require('./devices');
const { MappingServer } = require('./mapping-server');
const { solve } = require('../shared/solver');
const { CANVAS_W, CANVAS_H } = require('../shared/layout');
const updater = require('./updater');
const library = require('./library');

const ROOT = path.join(__dirname, '..', '..');
const BUILTIN_EFFECTS = app.isPackaged ? path.join(process.resourcesPath, 'effects') : path.join(ROOT, 'effects');
const ICON = path.join(ROOT, 'build', 'icon.png');

if (process.env.CF_USERDATA) app.setPath('userData', process.env.CF_USERDATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let settings;
let mainWin = null;
let captureWin = null;
let tray = null;
let effects = [];
let runner = null;
let devices = null;
let mapper = null;
let quitting = false;
let previewCounter = 0;
let lastDevicesSent = 0;
const userDir = () => app.getPath('userData');

// ------------------------------------------------------------------ folders
function signalRgbPluginDirs() {
  if (process.platform !== 'win32' || !settings.get('useSignalRgbFolders')) return [];
  const docs = app.getPath('documents');
  const home = os.homedir();
  const dirs = [];
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  try {
    const vortx = path.join(local, 'VortxEngine');
    const apps = fs.readdirSync(vortx).filter((d) => /^app-/.test(d)).sort();
    if (apps.length) dirs.push(path.join(vortx, apps[apps.length - 1], 'Signal-x64', 'Plugins'));
  } catch { /* SignalRGB not installed */ }
  dirs.push(path.join(docs, 'WhirlwindFX', 'Plugins'));
  dirs.push(path.join(home, 'OneDrive', 'Documents', 'WhirlwindFX', 'Plugins'));
  return dirs.filter((d) => fs.existsSync(d));
}

function signalRgbEffectDirs() {
  if (process.platform !== 'win32' || !settings.get('useSignalRgbFolders')) return [];
  const docs = app.getPath('documents');
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  // Search every place SignalRGB keeps content, deeply: effects downloaded from its
  // library live somewhere under these roots.
  const roots = [path.join(docs, 'WhirlwindFX'), path.join(home, 'OneDrive', 'Documents', 'WhirlwindFX'),
    path.join(local, 'WhirlwindFX'), path.join(roaming, 'WhirlwindFX'), path.join(local, 'VortxEngine'),
    path.join(roaming, 'VortxEngine'), path.join(local, 'SignalRgb'), path.join(roaming, 'SignalRgb')];
  return roots.filter((d) => fs.existsSync(d));
}

function pluginDirs() {
  const dirs = [];
  const official = library.officialPluginDir(userDir());
  if (fs.existsSync(official)) dirs.push(official);
  dirs.push(...signalRgbPluginDirs());
  dirs.push(path.join(userDir(), 'plugins'));
  dirs.push(...(settings.get('pluginDirs') || []));
  return [...new Set(dirs)];
}

function effectDirs() {
  const dirs = [{ dir: BUILTIN_EFFECTS, source: 'builtin' }];
  for (const d of signalRgbEffectDirs()) dirs.push({ dir: d, source: 'signalrgb', depth: 8 });
  dirs.push({ dir: path.join(userDir(), 'effects'), source: 'user' });
  for (const d of settings.get('effectDirs') || []) dirs.push({ dir: d, source: 'user' });
  return dirs;
}

function reloadEffects() {
  fs.mkdirSync(path.join(userDir(), 'effects'), { recursive: true });
  effects = scanEffects(effectDirs());
  return effects;
}

// ------------------------------------------------------------------ effects
function currentEffect() {
  const id = settings.get('effect');
  return effects.find((e) => e.id === id) || effects.find((e) => e.title === 'Rainbow Wave') || effects[0];
}

function applyEffect(effect) {
  if (!effect) return;
  settings.set('effect', effect.id);
  const values = (settings.get('effectProps') || {})[effect.id] || {};
  runner.load(effect, values);
  updateCapture();
  sendState();
}

function updateCapture() {
  const eff = runner && runner.effect;
  const cfg = {
    audio: !!(settings.get('audio') && eff && eff.usesAudio),
    screen: !!(settings.get('screen') && eff && eff.usesScreen),
    meters: (eff && eff.meters) || [],
  };
  if (!captureWin || captureWin.isDestroyed()) return;
  captureWin.webContents.send('capture:config', cfg);
}

function createCaptureWindow() {
  captureWin = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    webPreferences: { preload: path.join(ROOT, 'src', 'capture', 'capture-preload.js'), backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  captureWin.loadFile(path.join(ROOT, 'src', 'capture', 'capture.html'));
  captureWin.webContents.on('did-finish-load', updateCapture);
}

// ------------------------------------------------------------------ devices
function hostConfig() {
  return {
    pluginDirs: pluginDirs(),
    placements: settings.get('placements'),
    params: settings.get('params'),
    enabled: settings.get('enabled'),
    brightness: settings.get('paused') ? 0 : settings.get('brightness'),
    deviceBrightness: settings.get('deviceBrightness'),
    channelCounts: settings.get('channelCounts'),
    fps: settings.get('fps'),
    openrgb: settings.get('openrgb'),
    fury: settings.get('fury'),
    smbusPlugins: settings.get('smbusPlugins'),
    pawnioDir: path.join(userDir(), 'pawnio'),
    motherboard: settings.get('motherboard') || '',
  };
}

function startDevices() {
  const roles = ['usb'];
  if (process.platform === 'win32' && settings.get('smbusEnabled') !== false) roles.push('smbus');
  devices = new DeviceManager({ utilityProcess, roles });
  devices.on('devices', () => {
    const now = Date.now();
    if (now - lastDevicesSent > 250) {
      lastDevicesSent = now;
      send('devices', devices.devices());
    } else {
      clearTimeout(devices._t);
      devices._t = setTimeout(() => send('devices', devices.devices()), 260);
    }
  });
  devices.on('log', (l) => send('log', l));
  devices.on('autotune', (m) => send('autotune', m));
  devices.start(hostConfig());
}

function pushConfig(keys) {
  const cfg = hostConfig();
  const partial = {};
  for (const k of keys) partial[k] = cfg[k];
  devices.updateConfig(partial);
}

function detectMotherboard() {
  if (process.platform !== 'win32') return;
  execFile('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_BaseBoard | Select-Object -First 1).Product'], { windowsHide: true, timeout: 15000 }, (err, out) => {
    if (err) return;
    const name = String(out || '').trim();
    if (name) {
      settings.set('motherboard', name);
      devices && devices.updateConfig({ motherboard: name });
    }
  });
}

// Keep the public device plugin library installed and fresh without user action.
function refreshPluginLibrary() {
  const info = library.officialInfo(userDir());
  const stale = !info.installed || !info.date || Date.now() - Date.parse(info.date) > 7 * 86400000;
  if (!stale) return;
  library.installOfficialPlugins(userDir(), (p) => send('library', p))
    .then(() => { pushConfig(['pluginDirs']); sendState(); })
    .catch((e) => {
      send('log', { t: Date.now(), role: 'library', msg: `Plugin library download failed: ${e.message}` });
      send('library', { task: 'plugins', state: 'error', error: e.message });
      setTimeout(refreshPluginLibrary, 10 * 60 * 1000);
    });
}

// RAM / SMBus access: install the PawnIO driver + modules automatically, then
// restart the SMBus host so memory is picked up without restarting the app.
async function ensurePawnIO() {
  if (process.platform !== 'win32' || settings.get('smbusEnabled') === false) return;
  const st = library.pawnioStatus(userDir());
  if (st.driver && st.modules.length) return;
  if (settings.get('pawnioAutoAttempted') && !st.driver) return; // tried before; Settings has a manual button
  settings.set('pawnioAutoAttempted', true);
  const r = await library.installPawnIO(userDir(), (p) => send('library', p));
  send('log', { t: Date.now(), role: 'pawnio', msg: `PawnIO: driver=${r.driver} (${r.driverResult}), modules=${r.modules.join(',')}` });
  if (r.driver) devices.restartRole('smbus');
  sendState();
}

// Other RGB software holds devices open and fights over them.
const CONFLICTING = ['SignalRgb.exe', 'SignalRgbLauncher.exe', 'SignalRgbService.exe', 'iCUE.exe', 'Corsair.Service.exe', 'LightingService.exe',
  'ArmouryCrate.exe', 'ArmouryCrate.Service.exe', 'AuraService.exe', 'OpenRGB.exe', 'NZXT CAM.exe', 'CAM.exe', 'GloriousCore.exe',
  'Glorious Core.exe', 'MysticLight.exe', 'RGBFusion.exe', 'NGenuity2.exe', 'LGHUB.exe', 'lghub_agent.exe', 'RazerCentralService.exe',
  'Razer Synapse 3.exe', 'SteelSeriesGG.exe', 'EVGA Unleash RGB.exe', 'EVGA_Unleash.exe'];
let conflicts = [];
function checkConflicts() {
  if (process.platform !== 'win32') return;
  execFile('tasklist.exe', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    if (err) return;
    const running = new Set(String(out).split(/\r?\n/).map((l) => (l.split('","')[0] || '').replace(/^"/, '').toLowerCase()));
    const found = CONFLICTING.filter((n) => running.has(n.toLowerCase()));
    if (JSON.stringify(found) !== JSON.stringify(conflicts)) {
      conflicts = found;
      send('conflicts', conflicts);
    }
  });
}

// ------------------------------------------------------------------ mapping
function startMapper() {
  if (mapper) return mapper.start();
  const cfg = settings.get('mapping');
  mapper = new MappingServer({
    dataDir: userDir(),
    port: cfg.port,
    settleMs: cfg.settleMs,
    getLayout: () => devices.layoutForMapping(),
  });
  let layout = null;
  mapper.on('session', (s) => {
    if (s.active) layout = s.layout;
    send('mapping', { session: s, info: mapper.info() });
  });
  mapper.on('status', (info) => send('mapping', { info }));
  mapper.on('pattern', (pattern) => {
    if (!pattern) {
      devices.setMapping(false);
      return;
    }
    const l = layout || devices.layoutForMapping();
    devices.setMapping(true, pattern, l.offsets);
  });
  mapper.on('result', ({ points }, out) => {
    const l = layout || devices.layoutForMapping();
    const res = solve({ items: l.items, offsets: l.offsets, points, existing: settings.get('placements') });
    const placements = { ...settings.get('placements'), ...res.placements };
    settings.set('placements', placements);
    pushConfig(['placements']);
    const names = Object.fromEntries(l.items.map((i) => [i.key, i.name]));
    out.report = { items: res.report.map((r) => ({ ...r, name: names[r.key] || r.key })), error: res.error };
    send('mapping', { result: out.report });
    sendState();
  });
  return mapper.start();
}

// ------------------------------------------------------------------ windows
function send(ch, data) {
  if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) mainWin.webContents.send(ch, data);
}

function stateSnapshot() {
  const eff = runner && runner.effect;
  return {
    version: app.getVersion(),
    platform: process.platform,
    canvas: { width: CANVAS_W, height: CANVAS_H },
    effects: effects.map(({ id, title, description, publisher, source, usesAudio, usesScreen }) => ({ id, title, description, publisher, source, usesAudio, usesScreen })),
    effect: eff ? { id: eff.id, title: eff.title, description: eff.description, properties: eff.properties, values: runner.values, usesAudio: eff.usesAudio, usesScreen: eff.usesScreen } : null,
    devices: devices ? devices.devices() : [],
    settings: {
      brightness: settings.get('brightness'),
      paused: !!settings.get('paused'),
      deviceBrightness: settings.get('deviceBrightness'),
      enabled: settings.get('enabled'),
      placements: settings.get('placements'),
      params: settings.get('params'),
      channelCounts: settings.get('channelCounts'),
      favorites: settings.get('favorites'),
      fps: settings.get('fps'),
      openrgb: settings.get('openrgb'),
      fury: settings.get('fury'),
      smbusPlugins: settings.get('smbusPlugins'),
      smbusEnabled: settings.get('smbusEnabled'),
      useSignalRgbFolders: settings.get('useSignalRgbFolders'),
      audio: settings.get('audio'),
      screen: settings.get('screen'),
      autostart: settings.get('autostart'),
      autoUpdate: settings.get('autoUpdate'),
      effectDirs: settings.get('effectDirs'),
      pluginDirs: settings.get('pluginDirs'),
      mapping: settings.get('mapping'),
    },
    pluginDirs: pluginDirs(),
    officialPlugins: library.officialInfo(userDir()),
    pawnio: library.pawnioStatus(userDir()),
    update: updater.status(),
    conflicts,
  };
}

function sendState() {
  send('state', stateSnapshot());
}

function createMainWindow(show) {
  mainWin = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0f14',
    title: 'Cuttlefish',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  mainWin.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  mainWin.once('ready-to-show', () => { if (show) mainWin.show(); });
  mainWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('show', sendState);
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) createMainWindow(true);
  else {
    mainWin.show();
    mainWin.focus();
  }
}

function createTray() {
  let img = nativeImage.createFromPath(ICON);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Cuttlefish');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Cuttlefish', click: showMain },
    { type: 'separator' },
    { label: settings.get('paused') ? 'Resume lighting' : 'Turn lighting off', click: () => { setPaused(!settings.get('paused')); tray.setContextMenu(menu()); } },
    { label: 'Brightness', submenu: [100, 75, 50, 25].map((v) => ({ label: `${v}%`, click: () => setBrightness(v / 100) })) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', showMain);
}

function setBrightness(v) {
  settings.set('brightness', Math.max(0, Math.min(1, Number(v))));
  pushConfig(['brightness']);
  sendState();
}

function setPaused(p) {
  settings.set('paused', !!p);
  pushConfig(['brightness']);
  sendState();
}

// ------------------------------------------------------------------ autostart
function applyAutostart() {
  const on = !!settings.get('autostart');
  if (process.platform === 'win32' && app.isPackaged) {
    // The app runs elevated (SMBus access), and Windows will not auto-start elevated
    // login items, so use a scheduled task with highest privileges instead.
    const exe = process.execPath;
    const args = on
      ? ['/Create', '/F', '/TN', 'Cuttlefish', '/TR', `"${exe}" --hidden`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/DELAY', '0000:10']
      : ['/Delete', '/F', '/TN', 'Cuttlefish'];
    execFile('schtasks.exe', args, { windowsHide: true }, () => {});
  } else if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  }
}

// ------------------------------------------------------------------ IPC
const SETTABLE = new Set(['fps', 'openrgb', 'fury', 'smbusPlugins', 'smbusEnabled', 'useSignalRgbFolders', 'audio', 'screen', 'autostart', 'autoUpdate', 'mapping']);

function registerIpc() {
  ipcMain.on('effect:init', (e) => {
    e.returnValue = runner && runner.effect ? { values: runner.values, meters: runner.effect.meters } : { values: {}, meters: [] };
  });
  ipcMain.on('capture:audio', (_e, a) => runner && runner.send('engine:audio', a));
  ipcMain.on('capture:screen', (_e, s) => runner && runner.send('engine:screen', s));
  ipcMain.on('capture:log', (_e, m) => send('log', { t: Date.now(), role: 'capture', msg: m }));

  ipcMain.handle('state', () => stateSnapshot());
  ipcMain.handle('effect:set', (_e, id) => {
    const eff = effects.find((x) => x.id === id);
    if (eff) applyEffect(eff);
    return !!eff;
  });
  ipcMain.handle('effect:value', (_e, prop, value) => {
    if (!runner.effect) return;
    runner.setValue(prop, value);
    const all = settings.get('effectProps') || {};
    all[runner.effect.id] = { ...(all[runner.effect.id] || {}), [prop]: runner.values[prop] };
    settings.set('effectProps', all);
  });
  ipcMain.handle('effect:reset', () => {
    if (!runner.effect) return;
    const all = settings.get('effectProps') || {};
    delete all[runner.effect.id];
    settings.set('effectProps', all);
    applyEffect(runner.effect);
  });
  ipcMain.handle('effect:favorite', (_e, id) => {
    const f = new Set(settings.get('favorites') || []);
    if (f.has(id)) f.delete(id); else f.add(id);
    settings.set('favorites', [...f]);
    sendState();
  });
  ipcMain.handle('effects:reload', () => { reloadEffects(); sendState(); });
  ipcMain.handle('effects:import', async () => {
    const r = await dialog.showOpenDialog(mainWin, { title: 'Import effects', filters: [{ name: 'LightScript', extensions: ['html', 'htm'] }], properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return 0;
    const dir = path.join(userDir(), 'effects');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of r.filePaths) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    reloadEffects();
    sendState();
    return r.filePaths.length;
  });
  ipcMain.handle('folder:add', async (_e, kind) => {
    const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'] });
    if (r.canceled) return;
    const key = kind === 'plugins' ? 'pluginDirs' : 'effectDirs';
    settings.set(key, [...new Set([...(settings.get(key) || []), r.filePaths[0]])]);
    if (kind === 'plugins') pushConfig(['pluginDirs']); else reloadEffects();
    sendState();
  });
  ipcMain.handle('folder:remove', (_e, kind, dir) => {
    const key = kind === 'plugins' ? 'pluginDirs' : 'effectDirs';
    settings.set(key, (settings.get(key) || []).filter((d) => d !== dir));
    if (kind === 'plugins') pushConfig(['pluginDirs']); else reloadEffects();
    sendState();
  });
  ipcMain.handle('folder:open', (_e, which) => {
    const dirs = { userdata: userDir(), effects: path.join(userDir(), 'effects'), plugins: path.join(userDir(), 'plugins') };
    const d = dirs[which];
    if (d) { fs.mkdirSync(d, { recursive: true }); shell.openPath(d); }
  });
  ipcMain.handle('brightness', (_e, v) => setBrightness(v));
  ipcMain.handle('paused', (_e, p) => setPaused(p));
  ipcMain.handle('device:brightness', (_e, key, v) => {
    settings.set('deviceBrightness', { ...settings.get('deviceBrightness'), [key]: Number(v) });
    pushConfig(['deviceBrightness']);
  });
  ipcMain.handle('device:enabled', (_e, key, on) => {
    settings.set('enabled', { ...settings.get('enabled'), [key]: !!on });
    pushConfig(['enabled']);
    sendState();
  });
  ipcMain.handle('device:param', (_e, key, name, value) => {
    const all = settings.get('params') || {};
    all[key] = { ...(all[key] || {}), [name]: value };
    settings.set('params', all);
    devices.setParam(key, name, value);
  });
  ipcMain.handle('device:channel', (_e, key, ch, n) => {
    const all = settings.get('channelCounts') || {};
    all[key] = { ...(all[key] || {}), [ch]: Math.max(0, Number(n) | 0) };
    settings.set('channelCounts', all);
    pushConfig(['channelCounts']);
  });
  ipcMain.handle('device:identify', (_e, key) => devices.identify(key));
  ipcMain.handle('devices:rescan', () => devices.rescan());
  ipcMain.handle('layout:set', (_e, key, placement) => {
    const all = settings.get('placements') || {};
    if (placement) all[key] = placement; else delete all[key];
    settings.set('placements', all);
    pushConfig(['placements']);
  });
  ipcMain.handle('layout:replace', (_e, placements) => {
    settings.set('placements', placements || {});
    pushConfig(['placements']);
    sendState();
  });
  ipcMain.handle('settings:set', (_e, key, value) => {
    if (!SETTABLE.has(key)) return;
    settings.set(key, value);
    if (key === 'fps') { pushConfig(['fps']); runner.setFps(Math.min(60, Number(value) || 60)); }
    if (key === 'openrgb') pushConfig(['openrgb']);
    if (key === 'fury') pushConfig(['fury']);
    if (key === 'smbusPlugins') { pushConfig(['smbusPlugins']); devices.rescan(); }
    if (key === 'useSignalRgbFolders') { pushConfig(['pluginDirs']); reloadEffects(); }
    if (key === 'audio' || key === 'screen') updateCapture();
    if (key === 'autostart') applyAutostart();
    sendState();
  });
  ipcMain.handle('mapping:start', async () => {
    try {
      const info = await startMapper();
      const QR = require('qrcode');
      const qr = await QR.toDataURL(info.url, { margin: 1, width: 320, color: { dark: '#0b0f14', light: '#ffffff' } });
      return { ...info, qr };
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle('library:install-plugins', async () => {
    try {
      const n = await library.installOfficialPlugins(userDir(), (p) => send('library', p));
      pushConfig(['pluginDirs']);
      sendState();
      return { count: n };
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle('library:install-pawnio', async () => {
    const r = await library.installPawnIO(userDir(), (p) => send('library', p));
    if (r.driver) devices.restartRole('smbus');
    sendState();
    return r;
  });
  ipcMain.handle('fury:autotune', () => devices.autotune());
  ipcMain.handle('diagnostics', () => ({ ...devices.diagnostics(), state: { pluginDirs: pluginDirs(), version: app.getVersion(), os: `${os.type()} ${os.release()}`, motherboard: settings.get('motherboard') } }));
  ipcMain.handle('diagnostics:save', async () => {
    const r = await dialog.showSaveDialog(mainWin, { defaultPath: `cuttlefish-hardware-report-${Date.now()}.json` });
    if (r.canceled) return;
    const data = { ...devices.diagnostics(), devices: devices.devices(), pluginDirs: pluginDirs(), version: app.getVersion(), os: `${os.type()} ${os.release()}`, motherboard: settings.get('motherboard') };
    fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
    shell.showItemInFolder(r.filePath);
  });
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('conflicts:close', async () => {
    for (const name of conflicts) {
      await new Promise((r) => execFile('taskkill.exe', ['/IM', name, '/F', '/T'], { windowsHide: true }, () => r()));
    }
    // Some of them run as services; stop the common ones too.
    for (const svc of ['SignalRgbService', 'CorsairService', 'LightingService', 'AuraWallpaperService']) {
      await new Promise((r) => execFile('sc.exe', ['stop', svc], { windowsHide: true }, () => r()));
    }
    setTimeout(() => { checkConflicts(); devices.rescan(); }, 2000);
  });
  ipcMain.handle('open:external', (_e, url) => {
    if (/^https:\/\/(github\.com|pawnio\.eu|docs\.signalrgb\.com|gitlab\.com|openrgb\.org)\//.test(url)) shell.openExternal(url);
  });
}

// ------------------------------------------------------------------ lifecycle
app.on('second-instance', showMain);

app.whenReady().then(async () => {
  settings = new Settings(userDir());
  registerIpc();

  // System audio / screen capture for audio-reactive and screen-ambience effects.
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => cb({ video: sources[0], audio: process.platform === 'win32' ? 'loopback' : undefined }))
      .catch(() => cb({}));
  });
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' || permission === 'display-capture'));

  reloadEffects();
  startDevices();
  detectMotherboard();
  refreshPluginLibrary();
  ensurePawnIO().catch(() => {});
  checkConflicts();
  setInterval(checkConflicts, 30000);

  runner = new EffectRunner({ BrowserWindow, preload: path.join(__dirname, 'effect-preload.js'), width: CANVAS_W, height: CANVAS_H, fps: Math.min(60, settings.get('fps') || 60) });
  runner.on('frame', (buf, w, h) => {
    devices.frame(buf, w, h);
    if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && previewCounter++ % 2 === 0) mainWin.webContents.send('frame', { data: buf, w, h });
  });
  let lastFrames = 0;
  setInterval(() => {
    const f = runner.frames;
    send('stats', { canvasFps: f - lastFrames });
    lastFrames = f;
  }, 1000);
  runner.on('console', (m) => m && send('log', { t: Date.now(), role: 'effect', msg: String(m) }));
  createCaptureWindow();
  applyEffect(currentEffect());

  const hidden = process.argv.includes('--hidden') || settings.get('startMinimized');
  createMainWindow(!hidden);
  createTray();

  if (settings.get('firstRun')) {
    settings.set('firstRun', false);
    applyAutostart();
  }

  updater.init({ app, settings, onStatus: (s) => send('update', s), beforeInstall: async () => { quitting = true; await devices.stop(false); } });

  powerMonitor.on('suspend', () => devices && devices.broadcast({ type: 'mapping', active: true, pattern: { kind: 'off' }, offsets: {} }));
  powerMonitor.on('resume', () => setTimeout(() => devices && devices.setMapping(false), 2000));
});

app.on('before-quit', async (e) => {
  if (devices && !devices.stopping) {
    e.preventDefault();
    quitting = true;
    settings.flush();
    if (mapper) mapper.stop();
    await devices.stop(false);
    app.quit();
  }
});

app.on('window-all-closed', () => { /* keep running in the tray */ });
