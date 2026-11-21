'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { extract } = require('../src/main/tar');

function entry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h[156] = 48;
  h.write('ustar\0', 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

test('extracts filtered files and blocks path traversal', () => {
  const tgz = zlib.gzipSync(Buffer.concat([
    entry('repo-master/Plugins/A/a.js', Buffer.from('a')),
    entry('repo-master/README.md', Buffer.from('r')),
    entry('repo-master/Plugins/../../evil.js', Buffer.from('x')),
    Buffer.alloc(1024),
  ]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const n = extract(tgz, dir, (name) => { const m = /^[^/]+\/Plugins\/(.+)$/.exec(name); return m ? m[1] : null; });
  assert.strictEqual(n, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'A', 'a.js'), 'utf8'), 'a');
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.js')));
});
