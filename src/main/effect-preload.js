'use strict';
// Preload for effect pages (sandboxed, no Node access for the page). Recreates
// the globals SignalRGB LightScripts expect: one global per <meta property>,
// plus the `engine` object (audio, screen zones and vision meters).
const { ipcRenderer } = require('electron');

const init = ipcRenderer.sendSync('effect:init') || { values: {}, meters: [] };
for (const [k, v] of Object.entries(init.values || {})) window[k] = v;

const audio = { level: -100, density: 0, width: 0, freq: new Array(200).fill(0) };
const zone = { hue: new Array(560).fill(0), saturation: new Array(560).fill(0), lightness: new Array(560).fill(0) };
const vision = {};
for (const m of init.meters || []) vision[m.name] = m.type === 'ocr_numeric' || m.type === 'ocr_textmatch' ? -1 : 0;
const sensors = { cpu: { usage: 0, temp: null }, gpu: null, mem: {} };
window.engine = { audio, zone, vision, sensors, width: 320, height: 200 };

ipcRenderer.on('engine:audio', (_e, a) => {
  audio.level = a.level;
  audio.density = a.density;
  audio.width = a.width;
  audio.freq = a.freq;
});
ipcRenderer.on('engine:sensors', (_e, d) => { Object.assign(sensors, d); });
ipcRenderer.on('engine:screen', (_e, s) => {
  if (s.zone) {
    zone.hue = s.zone.hue;
    zone.saturation = s.zone.saturation;
    zone.lightness = s.zone.lightness;
  }
  if (s.vision) Object.assign(vision, s.vision);
});

// Make the page exactly fill the 320x200 viewport, no scrollbars.
window.addEventListener('DOMContentLoaded', () => {
  const st = document.createElement('style');
  st.textContent = 'html,body{margin:0;padding:0;overflow:hidden;background:#000}';
  document.head && document.head.prepend(st);
});
