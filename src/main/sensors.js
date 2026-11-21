'use strict';
// Hardware monitoring: CPU/GPU/memory usage and temperatures, for the Kraken LCD
// and other PC-monitoring displays. Values are gathered from several sources and
// each is best-effort — a reading that cannot be obtained is reported as null so
// the UI can hide it rather than show a wrong number.
const os = require('os');
const { execFile } = require('child_process');

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out)));
  });
}

// CPU load from /proc-style cpu times (cross-platform via os.cpus()).
let lastCpu = null;
function cpuUsage() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  if (!lastCpu) { lastCpu = { idle, total }; return null; }
  const di = idle - lastCpu.idle;
  const dt = total - lastCpu.total;
  lastCpu = { idle, total };
  if (dt <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - di / dt))));
}

// NVIDIA GPU via nvidia-smi.
async function nvidia() {
  const out = await run('nvidia-smi', ['--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,clocks.gr', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const line = out.trim().split(/\r?\n/)[0];
  if (!line) return null;
  const [temp, util, memUsed, memTotal, clock] = line.split(',').map((x) => parseFloat(x));
  if (!Number.isFinite(temp)) return null;
  return { vendor: 'NVIDIA', temp, usage: Number.isFinite(util) ? util : null, memUsed, memTotal, clock: Number.isFinite(clock) ? clock : null };
}

// Temperatures via LibreHardwareMonitor / OpenHardwareMonitor WMI namespace (if the
// user runs either — SignalRGB users often do). Falls back to ACPI thermal zone.
async function wmiTemps() {
  if (process.platform !== 'win32') return {};
  const ps = [
    '$ErrorActionPreference="SilentlyContinue";',
    '$r=@{};',
    "foreach($ns in @('root/LibreHardwareMonitor','root/OpenHardwareMonitor')){",
    "  $s=Get-CimInstance -Namespace $ns -ClassName Sensor -Filter \"SensorType='Temperature'\" 2>$null;",
    '  if($s){ foreach($x in $s){ $r[$x.Name]=[math]::Round($x.Value) } ; break }',
    '}',
    'if($r.Count -eq 0){',
    '  $t=Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature 2>$null;',
    '  if($t){ $r["ACPI"]=[math]::Round(($t.CurrentTemperature/10)-273.15) }',
    '}',
    '$r.GetEnumerator()|ForEach-Object{ "$($_.Key)=$($_.Value)" }',
  ].join(' ');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 9000);
  if (!out) return {};
  const temps = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+)=(-?\d+)$/.exec(line.trim());
    if (m) temps[m[1]] = Number(m[2]);
  }
  return temps;
}

function pickCpuTemp(temps) {
  const keys = Object.keys(temps);
  const cpuKey = keys.find((k) => /cpu (package|ccd|die|tctl|total)/i.test(k)) || keys.find((k) => /\bcpu\b/i.test(k)) || keys.find((k) => /package/i.test(k)) || (temps.ACPI !== undefined ? 'ACPI' : null);
  return cpuKey ? temps[cpuKey] : null;
}

class Sensors {
  constructor() {
    this.data = { cpu: { usage: null, temp: null }, gpu: null, mem: { usedPct: null, usedGB: null, totalGB: null }, ts: 0 };
    this.timer = null;
    this.subscribers = 0;
  }

  async sample() {
    const usage = cpuUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const [gpu, temps] = await Promise.all([nvidia().catch(() => null), wmiTemps().catch(() => ({}))]);
    this.data = {
      cpu: { usage, temp: pickCpuTemp(temps) },
      gpu,
      mem: {
        usedPct: Math.round((100 * (totalMem - freeMem)) / totalMem),
        usedGB: Math.round(((totalMem - freeMem) / 1073741824) * 10) / 10,
        totalGB: Math.round((totalMem / 1073741824) * 10) / 10,
      },
      temps,
      ts: Date.now(),
    };
    return this.data;
  }

  start(intervalMs = 2000) {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  latest() {
    return this.data;
  }
}

module.exports = { Sensors, cpuUsage, pickCpuTemp };
