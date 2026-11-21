'use strict';
// End-to-end test of phone camera mapping, without hardware or a phone:
//  - starts Cuttlefish with simulated devices (CF_VIRTUAL=1)
//  - opens the real phone mapper page in Chromium with a synthetic camera that
//    renders the simulated LEDs exactly as the app lights them
//  - checks the layout the app solved against the known LED geometry.
// Usage: xvfb-run node scripts/e2e-mapping.js [outDir]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron, chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'cf-e2e-'));

// Physical LED positions as the synthetic camera sees them (640x360 frame),
// in the same global order the app assigns: dimm0(12) dimm1(12) strip(30) ring(16).
function scene() {
  const pts = [];
  for (let i = 0; i < 12; i++) pts.push([300, 230 - i * 10]); // LED0 at bottom
  for (let i = 0; i < 12; i++) pts.push([330, 230 - i * 10]);
  for (let i = 0; i < 30; i++) pts.push([120 + i * 13, 300]);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pts.push([500 + Math.round(4 + 4 * Math.cos(a)) * 9 - 36, 120 + Math.round(4 + 4 * Math.sin(a)) * 9 - 36]);
  }
  return pts;
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ud-'));
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [ROOT, '--no-sandbox'],
    env: { ...process.env, CF_VIRTUAL: '1', CF_USERDATA: userData },
  });
  let win = null;
  for (let i = 0; i < 60 && !win; i++) {
    win = app.windows().find((w) => w.url().includes('renderer/index.html'));
    if (!win) await new Promise((r) => setTimeout(r, 250));
  }
  if (!win) throw new Error('main window not found');
  await win.waitForTimeout(4000);
  const st0 = await win.evaluate(() => window.cf.state());
  console.log('devices:', st0.devices.map((d) => d.name).join(', '));
  const info = await win.evaluate(() => window.cf.startMapping());
  if (info.error) throw new Error(info.error);
  const url = info.url.replace(/https:\/\/[^:/]+/, 'https://127.0.0.1');
  console.log('mapper url', url);

  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 860 } });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log('[phone]', m.text()));
  await page.addInitScript((pts) => {
    const toGray = (n) => n ^ (n >>> 1);
    const lit = (p, id) => {
      if (!p) return false;
      if (p.kind === 'full') return true;
      if (p.kind === 'bit') return (((toGray(id) >>> p.bit) & 1) === 1) !== !!p.inv;
      return false;
    };
    let pattern = { kind: 'off' };
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d');
    function draw() {
      g.fillStyle = '#0a0a0a';
      g.fillRect(0, 0, 640, 360);
      // a faint case outline so the image is not pure black
      g.strokeStyle = '#202020';
      g.strokeRect(80, 40, 500, 300);
      pts.forEach(([x, y], id) => {
        if (!lit(pattern, id)) return;
        const r = g.createRadialGradient(x, y, 0, x, y, 7);
        r.addColorStop(0, 'rgba(255,255,255,1)');
        r.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = r;
        g.fillRect(x - 7, y - 7, 14, 14);
      });
      requestAnimationFrame(draw);
    }
    draw();
    navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(30);
    const RealWS = window.WebSocket;
    window.WebSocket = function (u, p) {
      const ws = new RealWS(u, p);
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'step') pattern = m.pattern;
        if (m.type === 'decode') pattern = { kind: 'off' };
      });
      return ws;
    };
  }, scene());
  await page.goto(url);
  await page.click('#btnCamera');
  await page.waitForSelector('#stage:not([hidden])');
  await page.waitForFunction(() => /Connected/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  await page.click('#btnMap');
  await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
  console.log('phone result:', (await page.textContent('#result')).replace(/\s+/g, ' '));
  await page.screenshot({ path: path.join(out, 'phone.png') });

  await win.waitForTimeout(800);
  const st = await win.evaluate(() => window.cf.state());
  const items = st.devices.flatMap((d) => d.items);
  const pl = st.settings.placements;
  // Compare pairwise distances: canvas vs camera (should differ by one scale factor).
  const cam = scene();
  const canvasPts = [];
  for (const it of items) {
    const p = pl[it.key];
    if (!p) throw new Error(`no placement for ${it.key}`);
    it.ledPositions.forEach((_, i) => canvasPts.push(p.leds && p.leds[i] ? p.leds[i] : null));
  }
  const found = canvasPts.filter(Boolean).length;
  let ratios = [];
  for (let a = 0; a < cam.length; a += 3) {
    for (let b = a + 7; b < cam.length; b += 11) {
      if (!canvasPts[a] || !canvasPts[b]) continue;
      const dc = Math.hypot(canvasPts[a][0] - canvasPts[b][0], canvasPts[a][1] - canvasPts[b][1]);
      const dk = Math.hypot(cam[a][0] - cam[b][0], cam[a][1] - cam[b][1]);
      if (dk > 20) ratios.push(dc / dk);
    }
  }
  ratios = ratios.sort((x, y) => x - y);
  const med = ratios[Math.floor(ratios.length / 2)];
  const worst = Math.max(...ratios.map((r) => Math.abs(r / med - 1)));
  console.log(`LEDs located: ${found}/${cam.length}; scale ${med.toFixed(3)}; worst relative distance error ${(worst * 100).toFixed(1)}%`);
  for (const it of items) {
    const p = pl[it.key];
    console.log(`  ${it.name}: x=${p.x.toFixed(1)} y=${p.y.toFixed(1)} scale=${p.scale.toFixed(2)} rot=${p.rotation.toFixed(1)} flip=${p.flip}`);
  }
  await win.click('.nav[data-page=layout]');
  await win.waitForTimeout(1500);
  await win.screenshot({ path: path.join(out, 'layout.png') });
  await browser.close();
  await app.close();
  const ok = found === cam.length && worst < 0.05;
  console.log(ok ? 'E2E MAPPING PASS' : 'E2E MAPPING FAIL', 'screenshots in', out);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('E2E error', e);
  process.exit(1);
});
