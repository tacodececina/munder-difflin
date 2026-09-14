'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const floor = fs.readFileSync(path.join(__dirname, '../src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');

test('inspection hit bounds are refreshed on interaction, never in the render loop', () => {
  const tick = floor.slice(floor.indexOf('const onTick ='), floor.indexOf('app.ticker.add(onTick)'));
  assert.doesNotMatch(tick, /interactions\.update/);
  assert.match(floor, /refreshInteractionBounds\(\)/);
});

test('a routed message creates an envelope, not evidence of a meeting', () => {
  const handler = floor.slice(floor.indexOf('const offMessage ='), floor.indexOf('// Demo path:'));
  assert.doesNotMatch(handler, /startRendezvous\(/);
});

test('task cards never fabricate IDs or todo status and use the freshness boundary', () => {
  assert.doesNotMatch(floor, /`idx-\$\{i\}`|t\?\.status \?\? 'todo'/);
  assert.match(floor, /visibleTaskLedger\(reading/);
});

test('breaker pips cannot be seeded from a directory default with an invented timestamp', () => {
  assert.doesNotMatch(floor, /level: a\.breaker, ts: now/);
});

test('a configuration push invalidates the initial asynchronous config read', () => {
  const push = floor.slice(floor.indexOf('window.cth.onConfigChanged((c) =>'), floor.indexOf('const personaFor'));
  assert.match(push, /lifecycle\.invalidate\('config'\)/);
});

test('the app cannot re-enable floor flags from a stale initial config response', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/src/App.tsx'), 'utf8');
  assert.match(app, /configReadGeneration\.current !== generation/);
  const push = app.slice(app.indexOf('useEffect(() => window.cth.onConfigChanged((c) =>'));
  assert.match(push, /configReadGeneration\.current\+\+/);
});
