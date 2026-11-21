'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { parseEffect, scanEffects, coerceEffectValue } = require('../src/main/effects');

test('parses SignalRGB meta tags', () => {
  const html = `<head><title>My Effect</title>
  <meta description="Nice"/><meta publisher="Someone"/>
  <meta property="speed" label="Speed" type="number" min="1" max="10" default="5">
  <meta property="c" label="Colour" type="color" default="#009bde" min="0" max="360"/>
  <meta property="mode" label="Mode" type="list" values="A, B,C" default="B"/>
  <meta property="on" label="On" type="boolean" default="0"/>
  <meta meter="health" type="linear" x=".05" y=".9" width=".189" h="70-140" s="40-100" l="40-100">
  </head><body><canvas id="exCanvas"></canvas><script>engine.audio.freq</script></body>`;
  const m = parseEffect(html, 'x.html');
  assert.strictEqual(m.title, 'My Effect');
  assert.strictEqual(m.description, 'Nice');
  assert.strictEqual(m.properties.length, 4);
  assert.deepStrictEqual(m.properties[2].values, ['A', 'B', 'C']);
  assert.strictEqual(m.properties[2].type, 'combobox');
  assert.strictEqual(m.meters[0].name, 'health');
  assert.ok(m.usesAudio && m.usesScreen);
  assert.strictEqual(coerceEffectValue(m.properties[0], undefined), 5);
  assert.strictEqual(coerceEffectValue(m.properties[3], 'true'), 1);
});

test('built-in effects all parse', () => {
  const list = scanEffects([{ dir: path.join(__dirname, '..', 'effects'), source: 'builtin' }]);
  assert.ok(list.length >= 10);
  for (const e of list) assert.ok(e.properties.length >= 1, e.title);
});
