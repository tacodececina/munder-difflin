'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { MovementDirector, createFloorMovement } = loadTs('src/renderer/src/scene/office/movementDirector.ts');
const p = (x, y) => ({ x, y });
const grid = (width, height, blocked = new Set()) => ({
  width, height,
  isWalkable: (x, y) => x >= 0 && y >= 0 && x < width && y < height && !blocked.has(`${x},${y}`),
});

test('the disabled factory does not resolve a map or allocate a director', () => {
  let resolutions = 0;
  assert.equal(createFloorMovement(false, () => { resolutions++; return grid(1, 1); }), null);
  assert.equal(resolutions, 0);
  assert.ok(createFloorMovement(true, () => { resolutions++; return grid(1, 1); }) instanceof MovementDirector);
  assert.equal(resolutions, 1);
});

function advance(d, ids, limit = 40) {
  for (let tick = 0; tick < limit; tick++) {
    let moved = false;
    for (const id of ids) {
      const next = d.nextStep(id);
      if (next) { d.arriveStep(id, next); moved = true; }
    }
    if (ids.every(id => d.status(id) !== 'moving')) return;
    if (!moved) throw new Error(`routing stalled: ${ids.map(id => `${id}:${d.status(id)}`).join(',')}`);
  }
  throw new Error('routing exceeded bounded fixture steps');
}

test('an occupied destination remains pending and proceeds when its body leaves', () => {
  const d = new MovementDirector(grid(4, 2), { cooperative: true });
  d.register('waiting', p(0, 0));
  d.register('leaving', p(3, 0));
  assert.equal(d.request('waiting', p(3, 0)), true);
  assert.equal(d.status('waiting'), 'moving');
  assert.equal(d.nextStep('waiting'), null);
  assert.equal(d.request('leaving', p(3, 1)), true);
  advance(d, ['leaving']);
  advance(d, ['waiting']);
  assert.deepEqual(d.position('waiting'), p(3, 0));
});

test('stable priority resolves a crossing independently of polling order', () => {
  for (const order of [['low', 'high'], ['high', 'low']]) {
    const d = new MovementDirector(grid(3, 3), { cooperative: true });
    d.register('low', p(0, 1));
    d.register('high', p(1, 0));
    d.request('low', p(2, 1), { priority: 0 });
    d.request('high', p(1, 2), { priority: 10 });
    const first = new Map(order.map(id => [id, d.nextStep(id)]));
    assert.deepEqual(first.get('high'), p(1, 1));
    assert.notDeepEqual(first.get('low'), p(1, 1));
  }
});

test('polling an in-flight step returns the stable reserved object', () => {
  const d = new MovementDirector(grid(3, 1), { cooperative: true });
  d.register('a', p(0, 0));
  d.request('a', p(2, 0));
  const step = d.nextStep('a');
  assert.strictEqual(d.nextStep('a'), step);
  assert.strictEqual(d.nextStep('a'), step);
});

test('repeating a destination updates priority without resetting request age', () => {
  const d = new MovementDirector(grid(3, 3), { cooperative: true });
  d.register('promoted', p(0, 1));
  d.register('other', p(1, 0));
  d.request('promoted', p(2, 1), { priority: 0 });
  d.request('other', p(1, 2), { priority: 5 });
  d.request('promoted', p(2, 1), { priority: 10 });
  assert.deepEqual(d.nextStep('promoted'), p(1, 1));
  assert.notDeepEqual(d.nextStep('other'), p(1, 1));
});

test('replacing a claim with an occupied pending destination releases the old destination', () => {
  const d = new MovementDirector(grid(5, 2), { cooperative: true });
  d.register('a', p(0, 0));
  d.register('occupant', p(4, 0));
  d.register('b', p(0, 1));
  assert.equal(d.request('a', p(3, 0)), true);
  assert.equal(d.request('a', p(4, 0)), true);
  assert.equal(d.request('b', p(3, 0)), true, 'obsolete destination claim was released');
  assert.ok(d.nextStep('b'), 'the released destination can make progress immediately');
});

test('a head-on swap uses a deterministic side tile and both actors progress', () => {
  const d = new MovementDirector(grid(3, 2), { cooperative: true });
  d.register('winner', p(0, 0));
  d.register('yielding', p(1, 0));
  assert.equal(d.request('winner', p(1, 0), { priority: 5 }), true);
  assert.equal(d.request('yielding', p(0, 0)), true);
  assert.deepEqual(d.nextStep('winner'), null, 'occupied endpoint stays exclusive');
  assert.deepEqual(d.nextStep('yielding'), p(1, 1), 'lower priority yields off the contested edge');
  advance(d, ['yielding', 'winner']);
  assert.deepEqual(d.position('winner'), p(1, 0));
  assert.deepEqual(d.position('yielding'), p(0, 0));
});

test('a one-tile bottleneck queues actors and releases reservations on removal', () => {
  const blocked = new Set(['1,0', '1,2']);
  const d = new MovementDirector(grid(4, 3, blocked), { cooperative: true });
  d.register('first', p(0, 1));
  d.register('second', p(0, 0));
  d.request('first', p(3, 1), { priority: 2 });
  d.request('second', p(2, 0));
  advance(d, ['first', 'second']);
  assert.equal(d.status('first'), 'arrived');
  assert.equal(d.status('second'), 'arrived');
  d.release('first');
  d.release('second');
  assert.deepEqual(d.register('replacement', p(1, 1)), p(1, 1));
});

test('blocked polling does not run BFS per frame', () => {
  let now = 0, reads = 0;
  const base = grid(4, 1);
  const map = { ...base, isWalkable(x, y) { reads++; return base.isWalkable(x, y); } };
  const d = new MovementDirector(map, { now: () => now, maxWaitMs: 500, cooperative: true });
  d.register('a', p(0, 0));
  d.register('blocker', p(1, 0));
  d.request('a', p(3, 0));
  d.nextStep('a');
  const plannedReads = reads;
  for (let i = 0; i < 100; i++) d.nextStep('a');
  assert.equal(reads, plannedReads);
  now = 150;
  d.nextStep('a');
  assert.ok(reads > plannedReads, 'one bounded retry occurs after the interval');
});

test('11 cooperative agents progress on the real office map without sharing tiles', () => {
  const { buildOfficeMap } = require('../tools/gen-tech-office.cjs');
  const { buildWalkable, parseSpawnPoints } = loadTs('src/renderer/src/scene/office/tiledCollision.ts');
  const map = buildOfficeMap(), walk = buildWalkable(map), spawns = parseSpawnPoints(map);
  let now = 0;
  const d = new MovementDirector(walk, { cooperative: true, now: () => now, maxWaitMs: 20_000 });
  const desks = [...spawns].filter(([key]) => /^(desk-|pc-)/.test(key)).slice(0, 11);
  const entrance = spawns.get('entrance');
  const ids = desks.map((_, index) => `cooperative-${index}`);
  const positions = new Map(ids.map(id => [id, d.register(id, entrance)]));
  ids.forEach((id, index) => assert.equal(d.request(id, desks[index][1], { priority: index % 3 }), true));
  for (let tick = 0; tick < 600 && ids.some(id => d.status(id) === 'moving'); tick++) {
    const moving = [];
    for (const id of ids) {
      const next = d.nextStep(id);
      if (!next) continue;
      for (const [other, current] of positions) if (other !== id) assert.notDeepEqual(next, current);
      for (const [, reserved] of moving) assert.notDeepEqual(next, reserved);
      moving.push([id, next]);
    }
    for (const [id, next] of moving) { d.arriveStep(id, next); positions.set(id, next); }
    now += 150;
  }
  ids.forEach((id, index) => {
    assert.equal(d.status(id), 'arrived', id);
    assert.deepEqual(d.position(id), desks[index][1]);
  });
});

test('the unmodified real office map covers crossing, swap, occupancy, bottleneck, removal and mid-step cancellation', () => {
  const { buildOfficeMap } = require('../tools/gen-tech-office.cjs');
  const { buildWalkable } = loadTs('src/renderer/src/scene/office/tiledCollision.ts');
  const real = buildWalkable(buildOfficeMap());
  const directions = [p(0, -1), p(0, 1), p(-1, 0), p(1, 0)];
  const key = tile => `${tile.x},${tile.y}`;
  const adjacent = tile => directions.map(d => p(tile.x + d.x, tile.y + d.y))
    .filter(next => real.isWalkable(next.x, next.y));
  const tiles = [];
  for (let y = 0; y < real.height; y++) for (let x = 0; x < real.width; x++) {
    if (real.isWalkable(x, y)) tiles.push(p(x, y));
  }
  const cross = tiles.find(tile => adjacent(tile).length === 4);
  assert.ok(cross, 'the real collision map has a four-way crossing');
  const [up, down, left, right] = directions.map(d => p(cross.x + d.x, cross.y + d.y));

  {
    const d = new MovementDirector(real, { cooperative: true });
    d.register('low', left); d.register('high', up);
    d.request('low', right); d.request('high', down, { priority: 2 });
    assert.deepEqual(d.nextStep('high'), cross);
    assert.notDeepEqual(d.nextStep('low'), cross);
  }
  {
    const d = new MovementDirector(real, { cooperative: true });
    d.register('winner', left); d.register('yield', cross);
    d.request('winner', cross, { priority: 2 }); d.request('yield', left);
    assert.equal(d.nextStep('winner'), null);
    assert.deepEqual(d.nextStep('yield'), up);
    advance(d, ['yield', 'winner']);
  }
  {
    const d = new MovementDirector(real, { cooperative: true });
    d.register('waiting', left); d.register('leaving', cross);
    assert.equal(d.request('waiting', cross), true);
    assert.equal(d.nextStep('waiting'), null);
    d.request('leaving', right); advance(d, ['leaving']); advance(d, ['waiting']);
  }

  // Find a point whose removal disconnects two of its real-map neighbours.
  let bottleneck = null, sides = null;
  for (const candidate of tiles) {
    const neighbours = adjacent(candidate);
    if (neighbours.length < 2) continue;
    const assigned = new Set([key(candidate)]), components = [];
    for (const neighbour of neighbours) {
      if (assigned.has(key(neighbour))) continue;
      const seen = new Set([key(candidate), key(neighbour)]), queue = [neighbour], component = [];
      while (queue.length) {
        const current = queue.shift(); component.push(current); assigned.add(key(current));
        for (const next of adjacent(current)) {
          if (!seen.has(key(next))) { seen.add(key(next)); queue.push(next); }
        }
      }
      components.push(component);
    }
    if (components.length > 1 && components.every(component => component.length >= 3)) {
      bottleneck = candidate; sides = components.sort((a, b) => b.length - a.length); break;
    }
  }
  assert.ok(bottleneck && sides, 'the real collision map has a graph bottleneck');
  {
    const d = new MovementDirector(real, { cooperative: true });
    d.register('first-through', sides[0][0]); d.register('queued-through', sides[0][1]);
    const farSide = sides[1][sides[1].length - 1];
    assert.equal(d.request('first-through', farSide, { priority: 2 }), true);
    assert.deepEqual(d.nextStep('first-through'), bottleneck, 'route uses the actual articulation tile');
    assert.equal(d.request('queued-through', bottleneck), true, 'cooperative request waits for the articulation tile');
    assert.equal(d.nextStep('queued-through'), null, 'the in-flight articulation tile remains exclusive');
    advance(d, ['first-through'], 100); d.release('first-through');
    assert.equal(d.request('queued-through', farSide), true);
    advance(d, ['queued-through'], 100);
  }
  {
    const d = new MovementDirector(real, { cooperative: true });
    d.register('moving', left); d.register('removed', cross);
    d.release('removed'); d.request('moving', cross); advance(d, ['moving']);
    assert.deepEqual(d.position('moving'), cross);
  }
  {
    const d = new MovementDirector(real, { cooperative: true });
    d.register('cancelled', left); d.request('cancelled', right);
    const reserved = d.nextStep('cancelled'); d.cancel('cancelled');
    assert.strictEqual(d.nextStep('cancelled'), reserved);
    d.arriveStep('cancelled', reserved);
    assert.equal(d.status('cancelled'), 'cancelled');
  }
});
