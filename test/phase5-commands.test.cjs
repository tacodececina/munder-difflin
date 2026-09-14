'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { MovementCommands, MOVEMENT_PRIORITY } = loadTs(
  'src/renderer/src/scene/office/movementCommands.ts'
);

test('lower priority movement cannot erase the active command or its callbacks', () => {
  const commands = new MovementCommands();
  const outcomes = [];
  assert.equal(commands.request('work', () => outcomes.push('work-arrived'), r => outcomes.push(`work-${r}`)), true);
  assert.equal(commands.request('wander', () => outcomes.push('wander-arrived'), r => outcomes.push(`wander-${r}`)), false);
  assert.deepEqual(outcomes, ['wander-cancelled']);
  assert.equal(commands.activeOwner, 'work');
  commands.arrive('work');
  assert.deepEqual(outcomes, ['wander-cancelled', 'work-arrived']);
  assert.equal(commands.activeOwner, null);
});

test('higher priority replacement cancels once and reentrant replacement wins', () => {
  const commands = new MovementCommands();
  const outcomes = [];
  commands.request('wander', undefined, reason => {
    outcomes.push(`wander-${reason}`);
    commands.request('blocked', () => outcomes.push('blocked-arrived'));
  });
  assert.equal(commands.request('work', () => outcomes.push('wrong-work'),
    reason => outcomes.push(`work-${reason}`)), false);
  assert.deepEqual(outcomes, ['wander-cancelled', 'work-cancelled']);
  assert.equal(commands.activeOwner, 'blocked');
  commands.arrive('blocked');
  assert.deepEqual(outcomes, ['wander-cancelled', 'work-cancelled', 'blocked-arrived']);
});

test('an operational floor remains after arrival until status clears it', () => {
  const commands = new MovementCommands();
  const outcomes = [];
  commands.setFloor('blocked');
  assert.equal(commands.request('blocked', () => outcomes.push('blocked-arrived')), true);
  commands.arrive('blocked');
  assert.equal(commands.request('work', undefined, reason => outcomes.push(`work-${reason}`)), false);
  commands.setFloor(null);
  assert.equal(commands.request('work', () => outcomes.push('work-arrived')), true);
  commands.arrive('work');
  assert.deepEqual(outcomes, ['blocked-arrived', 'work-cancelled', 'work-arrived']);
});

test('terminal outcomes release ownership and stale owners cannot complete replacements', () => {
  const commands = new MovementCommands();
  const outcomes = [];
  commands.request('card', () => outcomes.push('wrong-card'), reason => outcomes.push(`card-${reason}`));
  commands.request('work', () => outcomes.push('work-arrived'), reason => outcomes.push(`work-${reason}`));
  commands.arrive('card');
  assert.equal(commands.activeOwner, 'work');
  commands.fail('unreachable', 'work');
  assert.deepEqual(outcomes, ['card-cancelled', 'work-unreachable']);
  assert.equal(commands.activeOwner, null);
});

test('priority order is explicit and stable', () => {
  assert.deepEqual(MOVEMENT_PRIORITY, {
    wander: 100, errand: 200, cafe: 300, station: 400,
    card: 500, work: 600, blocked: 700,
  });
});

test('dispose permanently rejects commands including from its cancellation callback', () => {
  const commands = new MovementCommands();
  const outcomes = [];
  commands.request('work', undefined, reason => {
    outcomes.push(`work-${reason}`);
    assert.equal(commands.request('blocked', () => outcomes.push('wrong-blocked'),
      next => outcomes.push(`blocked-${next}`)), false);
  });
  commands.dispose();
  assert.equal(commands.canRequest('blocked'), false);
  assert.equal(commands.request('wander', undefined, reason => outcomes.push(`wander-${reason}`)), false);
  assert.equal(commands.activeOwner, null);
  assert.deepEqual(outcomes, ['work-cancelled', 'blocked-cancelled', 'wander-cancelled']);
});

test('dispose from a replaced callback prevents the replacing command from installing', () => {
  const commands = new MovementCommands();
  const outcomes = [];
  commands.request('wander', undefined, reason => {
    outcomes.push(`wander-${reason}`);
    commands.dispose();
  });
  assert.equal(commands.request('work', () => outcomes.push('wrong-work'),
    reason => outcomes.push(`work-${reason}`)), false);
  assert.equal(commands.activeOwner, null);
  assert.equal(commands.canRequest('blocked'), false);
  assert.deepEqual(outcomes, ['wander-cancelled', 'work-cancelled']);
});
