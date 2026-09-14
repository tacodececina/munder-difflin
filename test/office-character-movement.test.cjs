'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { Character } = loadTs('src/renderer/src/scene/office/Character.ts');
const { createOrthogonalProjection } = loadTs('src/renderer/src/scene/office/projection.ts');
const { MovementDirector } = loadTs('src/renderer/src/scene/office/movementDirector.ts');
const tile = (x, y = 0) => ({ x, y });
const map = { width: 5, height: 3, isWalkable: (x, y) => x >= 0 && y >= 0 && x < 5 && y < 3,
  projection: createOrthogonalProjection(16) };
function character(id = 'a', start = tile(0)) {
  // Run the production movement methods; only its rasterizer is replaced.
  const c = Object.create(Character.prototype);
  const pixel = map.projection.tileFootToWorld(start.x, start.y);
  Object.assign(c, { agentId: id, mapRenderer: map, px: pixel.x, py: pixel.y, path: [],
    state: 'idle', direction: 'down', deskTile: start, seatDirection: 'down',
    arrivalCallback: null, failureCallback: null, movementDirector: null, movementGeneration: 0,
    sprite: { setAnimation() {}, setSeatedCrop() {}, setPosition() {} } });
  return c;
}
function settle(c, ticks = 50) { for (let i = 0; i < ticks; i++) if (c.getAnimation() === 'walk') c.updateWalk(1); }

test('unreachable new destination cancels the old path and never runs a wrong arrival', () => {
  const c = character();
  const outcomes = [];
  c.walkToAndThen(tile(4), () => outcomes.push('old-arrival'), reason => outcomes.push(reason));
  c.walkToAndThen(tile(99), () => outcomes.push('wrong-arrival'), reason => outcomes.push(reason));
  settle(c);
  assert.deepEqual(outcomes, ['cancelled', 'unreachable']);
  assert.deepEqual(c.getTilePosition(), tile(0));
});

test('the Character authority keeps a cancelled mid-step exclusive through return to desk', () => {
  const c = character(), other = character('b');
  const d = new MovementDirector(map);
  assert.equal(typeof c.setMovementDirector, 'function');
  assert.equal(c.setMovementDirector(d), true);
  assert.equal(other.setMovementDirector(d), true);
  assert.notDeepEqual(c.getTilePosition(), other.getTilePosition());
  const outcomes = [];
  c.walkToAndThen(tile(4), () => outcomes.push('old-arrival'), reason => outcomes.push(reason));
  c.updateWalk(0.1);
  const midway = c.getPixelPosition();
  c.cancelMovement();
  assert.deepEqual(c.getPixelPosition(), midway, 'cancel never teleports');
  assert.equal(d.request('b', tile(1)), false, 'in-flight tile remains reserved');
  c.walkToAndThen(tile(0), () => outcomes.push('returned'));
  settle(c);
  assert.deepEqual(outcomes, ['cancelled', 'returned']);
  assert.deepEqual(c.getTilePosition(), tile(0));
  assert.equal(c.setMovementDirector(null), true);
  assert.equal(d.request('b', tile(0)), true, 'detach releases occupancy');
});

test('idle and ordinary desk commands invalidate station actions without abandoning an edge', () => {
  const c = character(), d = new MovementDirector(map), outcomes = [];
  c.setMovementDirector(d);
  c.walkToAndThen(tile(4), () => outcomes.push('wrong-arrival'), reason => outcomes.push(reason));
  c.updateWalk(0.05);
  c.setIdle();
  assert.deepEqual(outcomes, ['cancelled']);
  settle(c);
  assert.deepEqual(c.getTilePosition(), tile(1));
  c.walkToAndThen(tile(4), () => outcomes.push('wrong-arrival'), reason => outcomes.push(reason));
  c.updateWalk(0.05);
  c.sitAtDesk(true);
  settle(c);
  assert.deepEqual(outcomes, ['cancelled', 'cancelled']);
  assert.deepEqual(c.getTilePosition(), tile(0));
  assert.equal(c.isSitting(), true);
});

test('returning to the desk before leaving its origin still completes the reserved step first', () => {
  const c = character(), d = new MovementDirector(map);
  c.setMovementDirector(d);
  c.walkToAndThen(tile(4), () => assert.fail('cancelled visit arrived'));
  c.updateWalk(0.05);
  c.sitAtDesk(true);
  assert.equal(c.isSitting(), false);
  settle(c);
  assert.deepEqual(c.getTilePosition(), tile(0));
  assert.equal(c.isSitting(), true);
  d.register('b', tile(2));
  assert.equal(d.request('b', tile(1)), true, 'the abandoned edge is released after returning');
});

test('wandering supersedes the previous arrival and removed actors release claims', () => {
  const c = character(), d = new MovementDirector(map), outcomes = [];
  c.setMovementDirector(d);
  c.walkToAndThen(tile(4), () => outcomes.push('wrong-arrival'), reason => outcomes.push(reason));
  c.startWandering();
  assert.deepEqual(outcomes, ['cancelled']);
  settle(c);
  assert.equal(c.idleLoop, true);
  const empty = { destroy() {} };
  Object.assign(c, { thoughtBubble: empty, workGlow: empty, overlay: empty, fx: empty, deskCup: empty });
  c.sprite.destroy = () => {};
  c.destroy();
  assert.deepEqual(d.register('new', tile(0)), tile(0));
});

test('a timeout callback can schedule another journey without a false immediate arrival', () => {
  let now = 0;
  const c = character('a', tile(0, 1)), d = new MovementDirector(map, { now: () => now, maxWaitMs: 100 });
  c.setMovementDirector(d);
  for (let y = 0; y < 3; y++) d.register(`block-${y}`, tile(1, y));
  const outcomes = [];
  c.walkToAndThen(tile(4, 1), () => outcomes.push('wrong-first'), () => {
    c.walkToAndThen(tile(4, 2), () => outcomes.push('wrong-second'));
  });
  c.updateWalk(0.1);
  now = 101;
  c.updateWalk(0.1);
  assert.deepEqual(outcomes, []);
  assert.equal(c.getAnimation(), 'walk', 'replacement is still waiting for a path');
});

test('the legacy idle desk-rest loop survives sitting down when already at home', () => {
  const c = character();
  c.idleLoop = true;
  c.walkToDeskAndSit(false);
  assert.equal(c.isSitting(), true);
  assert.equal(c.idleLoop, true);
});

test('cancellation callbacks may issue a newer command without being overwritten by the older request', () => {
  const c = character(), d = new MovementDirector(map), outcomes = [];
  c.setMovementDirector(d);
  c.walkToAndThen(tile(4), () => outcomes.push('old'), () => {
    c.walkToAndThen(tile(0, 2), () => outcomes.push('latest'));
  });
  c.walkToAndThen(tile(3), () => outcomes.push('superseded'));
  settle(c);
  assert.deepEqual(outcomes, ['latest']);
  assert.deepEqual(c.getTilePosition(), tile(0, 2));
});
