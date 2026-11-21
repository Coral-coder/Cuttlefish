'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cf', {
  sendAudio: (a) => ipcRenderer.send('capture:audio', a),
  sendScreen: (s) => ipcRenderer.send('capture:screen', s),
  onConfig: (fn) => ipcRenderer.on('capture:config', (_e, c) => fn(c)),
  log: (m) => ipcRenderer.send('capture:log', String(m)),
});
