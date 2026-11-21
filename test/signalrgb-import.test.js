'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const imp = require('../src/main/signalrgb-import');

test('parseFirebaseConfig handles JS object and separate assignments', () => {
  const js = `const firebaseConfig = { apiKey: "AIzaSyB1234567890abcdefg", authDomain: "whirlwindengine.firebaseapp.com", projectId: "whirlwindengine", databaseURL: "https://whirlwindengine.firebaseio.com" };`;
  const c = imp.parseFirebaseConfig(js);
  assert.strictEqual(c.apiKey, 'AIzaSyB1234567890abcdefg');
  assert.strictEqual(c.projectId, 'whirlwindengine');
  assert.strictEqual(c.databaseURL, 'https://whirlwindengine.firebaseio.com');
  // JSON style
  const json = '"apiKey":"AIzaSyXXXXXXXXXXXXXXXXXX","authDomain":"proj.firebaseapp.com"';
  const c2 = imp.parseFirebaseConfig(json);
  assert.strictEqual(c2.projectId, 'proj'); // derived from authDomain
  assert.ok(c2.databaseURL.includes('proj'));
  // junk without a real apiKey must not be trusted
  assert.strictEqual(imp.parseFirebaseConfig('apiKey: "nope"'), null);
});

test('findFirebaseConfig scans a synthetic install and ignores noise', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srgb-'));
  fs.mkdirSync(path.join(root, 'Signal-x64', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Signal-x64', 'resources', 'unrelated.js'), 'console.log("hi")');
  fs.writeFileSync(path.join(root, 'Signal-x64', 'main.bundle.js'),
    'x=1;var cfg={apiKey:"AIzaSyRealKey_abcdefghijklmno",authDomain:"whirlwindengine.firebaseapp.com",projectId:"whirlwindengine",databaseURL:"https://whirlwindengine.firebaseio.com"};y=2;');
  const r = imp.findFirebaseConfig([root]);
  assert.ok(r, 'config found');
  assert.strictEqual(r.config.apiKey, 'AIzaSyRealKey_abcdefghijklmno');
  assert.strictEqual(r.config.projectId, 'whirlwindengine');
});

test('detect never throws and reports structure', () => {
  const d = imp.detect();
  assert.ok('found' in d && 'pluginDirs' in d && 'firebase' in d);
});
