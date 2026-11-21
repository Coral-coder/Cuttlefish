'use strict';
// Reads the OS "turn off display after" timeout so Cuttlefish can blacken the
// lights in step with the monitor sleeping. No native driver needed.
const { execSync } = require('child_process');

function parsePowercfgSeconds(out, acLine) {
  // Lines look like: "Current AC Power Setting Index: 0x0000000e" (seconds in hex).
  const re = new RegExp(`${acLine}[^\\n]*?0x([0-9a-fA-F]+)`);
  const m = re.exec(out);
  if (!m) return null;
  return parseInt(m[1], 16);
}

// Returns the monitor-off timeout in seconds (0 = never / unknown).
function monitorTimeoutSeconds() {
  if (process.platform !== 'win32') return 0;
  try {
    const out = execSync('powercfg /q SCHEME_CURRENT SUB_VIDEO VIDEOIDLE', { windowsHide: true, timeout: 8000 }).toString();
    const onBattery = isOnBattery();
    const sec = parsePowercfgSeconds(out, onBattery ? 'Current DC Power Setting Index:' : 'Current AC Power Setting Index:');
    return Number.isFinite(sec) ? sec : 0;
  } catch {
    return 0;
  }
}

function isOnBattery() {
  try {
    const out = execSync('wmic path Win32_Battery get BatteryStatus', { windowsHide: true, timeout: 5000 }).toString();
    // BatteryStatus 1 = discharging (on battery); 2 = on AC.
    return /\b1\b/.test(out) && !/\b2\b/.test(out);
  } catch {
    return false;
  }
}

module.exports = { monitorTimeoutSeconds, parsePowercfgSeconds };
