'use strict';
// Minimal tar(.gz) extractor: regular files + directories, ustar/pax/GNU long names.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function cstr(buf, off, len) {
  const end = buf.indexOf(0, off);
  return buf.toString('utf8', off, end >= 0 && end < off + len ? end : off + len);
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.toString('utf8', i, sp), 10);
    if (!len) break;
    const rec = buf.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// filter(name) -> destination relative path or null to skip
function extract(tgzBuffer, destDir, filter) {
  const buf = zlib.gunzipSync(tgzBuffer);
  const root = path.resolve(destDir);
  let off = 0;
  let longName = null;
  let pax = {};
  let count = 0;
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    let name = cstr(hdr, 0, 100);
    const size = parseInt(cstr(hdr, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(hdr[156] || 48);
    const prefix = cstr(hdr, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (pax.path) { name = pax.path; }
    pax = {};
    if (type !== '0' && type !== '\0' && type !== '5') continue;
    const rel = filter ? filter(name) : name;
    if (!rel) continue;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) continue; // path traversal guard
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    count++;
  }
  return count;
}

module.exports = { extract };
