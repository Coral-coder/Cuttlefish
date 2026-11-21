'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SignalRGBAccount } = require('../src/main/signalrgb-account');

// Mock Firebase identitytoolkit + securetoken + services + catalog by pointing
// the module's hosts at a local server via a fetch shim.
function mockServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => handler(req, res));
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('sign in, read entitlements, sync only entitled effects', async () => {
  const bodies = [];
  const srv = await mockServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const u = req.url;
      res.setHeader('content-type', 'application/json');
      if (u.includes('signInWithPassword')) {
        bodies.push(JSON.parse(data));
        res.end(JSON.stringify({ idToken: 'ID1', refreshToken: 'R1', localId: 'uid123', email: 'me@example.com', expiresIn: '3600' }));
      } else if (u.includes('/users/uid123.json')) {
        assert.ok(u.includes('auth=ID1'));
        res.end(JSON.stringify({ purchased_fx: ['owned1'], subscriptions: null }));
      } else if (u.endsWith('catalog_en.json')) {
        res.end(JSON.stringify([
          { id: 'free1', name: 'Free One', price: 0, requires_pro: false },
          { id: 'owned1', name: 'Owned One', price: 500, requires_pro: true },
          { id: 'pro1', name: 'Pro Only', price: 0, requires_pro: true },
        ]));
      } else if (u.includes('/effects/remote/')) {
        const id = u.split('/').pop();
        if (id === 'pro1') { res.statusCode = 403; res.end('{}'); return; }
        res.end('<html><head><meta property="x" type="number" default="1"></head><body><canvas id="exCanvas"></canvas></body></html>');
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  // redirect module hosts
  const acct = new SignalRGBAccount({
    config: { apiKey: 'AIzaKEY', databaseURL: `${base}`, projectId: 'whirlwindengine' },
    effectsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')),
    cacheFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'c-')), 'auth.json'),
  });
  // point the hard-coded hosts at the mock by monkeypatching global fetch
  const realFetch = global.fetch;
  global.fetch = (url, opts) => realFetch(String(url)
    .replace('https://identitytoolkit.googleapis.com/v1', base)
    .replace('https://securetoken.googleapis.com/v1/token', `${base}/token`)
    .replace('https://catalog.signalrgb.com', base)
    .replace('https://services.signalrgb.com', base), opts);
  try {
    const who = await acct.signIn('me@example.com', 'pw');
    assert.strictEqual(who.email, 'me@example.com');
    assert.strictEqual(bodies[0].returnSecureToken, true);
    const lib = await acct.library();
    const free = lib.find((x) => x.id === 'free1');
    const owned = lib.find((x) => x.id === 'owned1');
    const pro = lib.find((x) => x.id === 'pro1');
    assert.ok(free.entitled && free.free);
    assert.ok(owned.entitled && !owned.free, 'owned via purchased_fx');
    assert.ok(!pro.entitled, 'pro-only not entitled for non-pro account');
    const r = await acct.sync();
    assert.strictEqual(r.installed, 2); // free1 + owned1
    assert.ok(fs.existsSync(path.join(acct.effectsDir, 'SignalRGB', 'Free One.html')));
  } finally {
    global.fetch = realFetch;
    srv.close();
  }
});

test('not configured refuses sign in', async () => {
  const acct = new SignalRGBAccount({ config: {}, effectsDir: os.tmpdir(), cacheFile: path.join(os.tmpdir(), 'x.json') });
  assert.strictEqual(acct.configured(), false);
  await assert.rejects(() => acct.signIn('a', 'b'), /Import from SignalRGB/);
});
