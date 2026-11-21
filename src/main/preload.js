'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => {
  const h = (_e, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('cf', {
  state: () => invoke('state'),
  setEffect: (id) => invoke('effect:set', id),
  setEffectValue: (p, v) => invoke('effect:value', p, v),
  resetEffect: () => invoke('effect:reset'),
  toggleFavorite: (id) => invoke('effect:favorite', id),
  reloadEffects: () => invoke('effects:reload'),
  importEffects: () => invoke('effects:import'),
  addFolder: (kind) => invoke('folder:add', kind),
  removeFolder: (kind, dir) => invoke('folder:remove', kind, dir),
  openFolder: (which) => invoke('folder:open', which),
  setBrightness: (v) => invoke('brightness', v),
  setPaused: (p) => invoke('paused', p),
  setDeviceBrightness: (k, v) => invoke('device:brightness', k, v),
  setEnabled: (k, on) => invoke('device:enabled', k, on),
  setParam: (k, n, v) => invoke('device:param', k, n, v),
  setChannelCount: (k, ch, n) => invoke('device:channel', k, ch, n),
  identify: (k) => invoke('device:identify', k),
  rescan: () => invoke('devices:rescan'),
  setPlacement: (k, p) => invoke('layout:set', k, p),
  replacePlacements: (p) => invoke('layout:replace', p),
  getLayoutPhoto: () => invoke('layout:photo'),
  clearLayoutPhoto: () => invoke('layout:clearphoto'),
  setSetting: (k, v) => invoke('settings:set', k, v),
  startMapping: () => invoke('mapping:start'),
  installPlugins: () => invoke('library:install-plugins'),
  installPawnIO: () => invoke('library:install-pawnio'),
  furyAutotune: () => invoke('fury:autotune'),
  diagnostics: () => invoke('diagnostics'),
  saveDiagnostics: () => invoke('diagnostics:save'),
  checkUpdate: () => invoke('update:check'),
  closeConflicts: () => invoke('conflicts:close'),
  srgbDetect: () => invoke('srgb:detect'),
  srgbImport: () => invoke('srgb:import'),
  srgbStatus: () => invoke('srgb:status'),
  srgbSignIn: (e, p) => invoke('srgb:signin', e, p),
  srgbSignOut: () => invoke('srgb:signout'),
  srgbLibrary: () => invoke('srgb:library'),
  srgbSync: () => invoke('srgb:sync'),
  srgbDownload: (item) => invoke('srgb:download', item),
  onSrgbAvailable: on('srgb-available'),
  onConflicts: on('conflicts'),
  onSensors: on('sensors'),
  openExternal: (u) => invoke('open:external', u),
  onFrame: on('frame'),
  onStats: on('stats'),
  onState: on('state'),
  onDevices: on('devices'),
  onLog: on('log'),
  onMapping: on('mapping'),
  onUpdate: on('update'),
  onLibrary: on('library'),
  onAutotune: on('autotune'),
});
