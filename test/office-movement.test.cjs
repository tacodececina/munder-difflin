'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const modulePath = 'src/renderer/src/scene/office/movementDirector.ts';
function director(map, now = () => 0) {
  assert.ok(fs.existsSync(path.resolve(__dirname, '..', modulePath)), 'shared movement authority exists');
  return new (loadTs(modulePath).MovementDirector)(map, { now, maxWaitMs: 100 });
}
const point = (x, y) => ({ x, y });
const grid = (width = 5, height = 3) => ({ width, height, isWalkable: (x, y) => x >= 0 && y >= 0 && x < width && y < height });

test('a directed route commits one adjacent step at a time and reports arrival', () => {
  const d = director(grid());
  assert.deepEqual(d.register('a', point(0, 1)), point(0, 1));
  assert.equal(d.request('a', point(4, 1)), true);
  for (let x = 1; x <= 4; x++) {
    const step = d.nextStep('a');
    assert.deepEqual(step, point(x, 1));
    d.arriveStep('a', step);
  }
  assert.equal(d.status('a'), 'arrived');
  assert.equal(d.nextStep('a'), null);
});

test('simultaneous agents reserve distinct spawn, destination and in-flight tiles', () => {
  const d = director(grid());
  assert.deepEqual(d.register('a', point(0, 1)), point(0, 1));
  assert.notDeepEqual(d.register('b', point(0, 1)), point(0, 1));
  assert.equal(d.request('a', point(4, 1)), true);
  assert.equal(d.request('b', point(4, 1)), false, 'destination is exclusive');
  assert.equal(d.request('b', point(3, 1)), true);
  const a = d.nextStep('a');
  const b = d.nextStep('b');
  assert.notDeepEqual(a, b, 'next tile is exclusive');
  assert.notDeepEqual(b, point(0, 1), 'occupied origin stays reserved until arrival');
});

test('cancel and replacement retain the in-flight edge until it is committed', () => {
  const d = director(grid());
  d.register('a', point(0, 1));
  d.register('b', point(2, 1));
  d.request('a', point(4, 1));
  const step = d.nextStep('a');
  assert.deepEqual(step, point(0, 0)); // detours around b
  assert.equal(typeof d.cancel, 'function', 'cancellation is available');
  d.cancel('a');
  assert.equal(d.status('a'), 'cancelled');
  assert.deepEqual(d.nextStep('a'), step, 'complete the reserved physical step');
  assert.equal(d.request('b', step), false);
  assert.equal(d.request('a', point(0, 1)), true);
  d.arriveStep('a', step);
  assert.deepEqual(d.nextStep('a'), point(0, 1));
  d.arriveStep('a', point(0, 1));
  assert.equal(d.status('a'), 'arrived');
  d.release('a');
  assert.equal(d.request('b', point(0, 1)), true);
});

test('unreachable replacement drops the previous route and bounded congestion releases destination', () => {
  let time = 0;
  const d = director(grid(5, 1), () => time);
  d.register('a', point(0, 0));
  d.request('a', point(4, 0));
  assert.equal(d.request('a', point(50, 0)), false);
  assert.equal(d.status('a'), 'unreachable');
  assert.equal(d.nextStep('a'), null);
  d.register('b', point(1, 0));
  assert.equal(d.request('a', point(4, 0)), true);
  assert.equal(d.nextStep('a'), null);
  time = 101;
  assert.equal(d.nextStep('a'), null);
  assert.equal(d.status('a'), 'unreachable');
  assert.equal(d.request('b', point(4, 0)), true, 'timed-out destination was released');
});

for (const count of [11, 19]) test(`${count} simultaneous office arrivals preserve tile and edge exclusion and make progress`, () => {
  const { buildOfficeMap } = require('../tools/gen-tech-office.cjs');
  const { buildWalkable, parseSpawnPoints } = loadTs('src/renderer/src/scene/office/tiledCollision.ts');
  const map = buildOfficeMap(), walk = buildWalkable(map), spawns = parseSpawnPoints(map);
  let time = 0;
  const d = new (loadTs(modulePath).MovementDirector)(walk, { now: () => time });
  const desks = [...spawns].filter(([key]) => /^(desk-|pc-)/.test(key)).slice(0, count);
  // The base map has 15 seats. Four extra actors are explicit floor fixtures,
  // with free destinations on this same map rather than invented production seats.
  for (let y = 8; desks.length < count && y < walk.height; y++) {
    for (let x = 8; desks.length < count && x < walk.width; x++) {
      if (walk.isWalkable(x, y) && ![...spawns.values()].some(p => p.x === x && p.y === y)) {
        desks.push([`fixture-floor-${desks.length}`, point(x, y)]);
      }
    }
  }
  assert.equal(desks.length, count);
  const ids = desks.map((_, i) => `fixture-${i}`);
  const spawn = spawns.get('entrance');
  const positions = new Map(ids.map(id => [id, d.register(id, spawn)]));
  assert.equal(new Set([...positions.values()].map(p => `${p.x},${p.y}`)).size, count);
  ids.forEach((id, i) => assert.equal(d.request(id, desks[i][1]), true));
  for (let tick = 0; tick < 500; tick++) {
    const pending = new Map();
    for (const id of ids) {
      const next = d.nextStep(id);
      if (!next) continue;
      for (const [other, current] of positions) {
        if (other !== id) assert.notDeepEqual(next, current, 'no body enters an occupied origin');
      }
      for (const reserved of pending.values()) assert.notDeepEqual(next, reserved, 'no shared next tile');
      pending.set(id, next);
    }
    for (const [id, next] of pending) { d.arriveStep(id, next); positions.set(id, next); }
    time += 100;
    if (ids.every(id => d.status(id) !== 'moving')) break;
  }
  ids.forEach((id, i) => {
    assert.equal(d.status(id), 'arrived', id);
    assert.deepEqual(d.position(id), desks[i][1]);
    d.release(id);
  });
  assert.deepEqual(d.register('fresh', spawn), spawn, 'removal releases all transient claims');
});

test('congested routes are retried at most every 150 ms without per-frame BFS', () => {
  let now = 0, reads = 0;
  const base = grid(5, 1);
  const map = { ...base, isWalkable(x, y) { reads++; return base.isWalkable(x, y); } };
  const d = new (loadTs(modulePath).MovementDirector)(map, { now: () => now });
  d.register('a', point(0, 0));
  d.register('b', point(1, 0));
  d.request('a', point(4, 0));
  d.nextStep('a');
  const afterFirst = reads;
  for (let i = 0; i < 100; i++) d.nextStep('a');
  assert.equal(reads, afterFirst);
  d.release('b');
  now = 150;
  assert.deepEqual(d.nextStep('a'), point(1, 0));
});

test('an unchanged destination preserves progress and congestion timeout', () => {
  let time = 0;
  const d = director(grid(5, 1), () => time);
  d.register('a', point(0, 0));
  d.register('b', point(1, 0));
  d.request('a', point(4, 0));
  d.nextStep('a');
  time = 101;
  d.request('a', point(4, 0));
  d.nextStep('a');
  assert.equal(d.status('a'), 'unreachable', 'refresh does not reset the watchdog');
});

test('head-on swaps cannot reserve occupied endpoints or traverse a reversed edge', () => {
  const d = director(grid(3, 1));
  d.register('a', point(0, 0));
  d.register('b', point(2, 0));
  assert.equal(d.request('a', point(2, 0)), false);
  assert.equal(d.request('b', point(0, 0)), false);
  assert.equal(d.request('a', point(1, 0)), true);
  const step = d.nextStep('a');
  assert.equal(d.request('b', point(1, 0)), false);
  d.cancel('a');
  assert.equal(d.request('b', point(0, 0)), false);
  d.arriveStep('a', step);
  assert.equal(d.request('b', point(0, 0)), true);
  assert.equal(d.nextStep('b'), null, 'stationary actor blocks the single-cell corridor');
});

test('a full map cannot register another body and invalid actor operations remain harmless', () => {
  const d = director(grid(1, 1));
  assert.deepEqual(d.register('a', point(0, 0)), point(0, 0));
  assert.equal(d.register('b', point(0, 0)), null);
  assert.equal(d.request('missing', point(0, 0)), false);
  assert.equal(d.nextStep('missing'), null);
  assert.equal(d.position('missing'), undefined);
  d.arriveStep('missing', point(0, 0));
  d.cancel('missing');
  d.release('missing');
  assert.equal(d.status('missing'), 'cancelled');
});

test('disposing the scene releases every claim and permanently rejects new movement', () => {
  const d = director(grid());
  d.register('a', point(0, 1));
  d.request('a', point(4, 1));
  assert.deepEqual(d.nextStep('a'), point(1, 1));
  assert.equal(typeof d.dispose, 'function', 'scene disposal is available');
  d.dispose();
  assert.equal(d.nextStep('a'), null);
  assert.equal(d.request('a', point(3, 1)), false);
  assert.equal(d.position('a'), undefined);
  assert.equal(d.register('late', point(0, 1)), null);
  d.dispose();
  const { TileReservations } = loadTs('src/renderer/src/scene/office/tileReservations.ts');
  const reservations = new TileReservations();
  reservations.register('a', point(0, 1));
  reservations.destination('a', point(4, 1));
  reservations.step('a', point(1, 1));
  reservations.clear();
  for (const x of [0, 1, 4]) assert.equal(reservations.available('new', point(x, 1)), true);
});
