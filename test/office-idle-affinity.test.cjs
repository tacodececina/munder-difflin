'use strict';

// Idle-time company seeking (src/renderer/src/scene/office/idleAffinity.ts).
//
// Phase 2 made directional affinity visible in who sits with whom at the café.
// This is the same rule one step earlier — who an agent drifts toward while it
// has no task at all. The rule is pure so it can be pinned without a GPU; what
// these tests guard is the behaviour that would silently rot: that the read
// stays DIRECTIONAL (a one-sided warmth still pulls), that open friction is
// avoided rather than merely down-weighted, that indifference produces no pull
// whatsoever (an office with no history wanders exactly as it always did), and
// that warmth both raises the odds of seeking company and the strength of the
// drift.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  pickIdleCompanion, companionWeight, companionPull,
  IDLE_SEEK_BASE_ODDS
} = loadTs('src/renderer/src/scene/office/idleAffinity.ts');

/** A deterministic `rand` that replays the given sequence, then returns 0. */
function seq(...values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0);
}

const rel = (warmth, tension = 0, familiarity = 0.3) => ({ warmth, tension, familiarity });

test('a warm colleague is picked up as a drift target', () => {
  const choice = pickIdleCompanion(
    [{ id: 'jim', rel: rel(0.7, 0.05, 0.6) }],
    seq(0, 0)   // pass the odds roll, then the weighted pick
  );
  assert.equal(choice?.id, 'jim');
  assert.ok(choice.pull > 0.5, `a warm read should pull hard, got ${choice.pull}`);
});

test('warmth this agent feels is enough — the other side need not return it', () => {
  // The candidate list carries ONLY the wanderer's own reading, which is the
  // whole point of the directional book: pam keeps drifting toward jim even if
  // jim's edge back to her has gone cold. Nothing here can even see that edge.
  const choice = pickIdleCompanion([{ id: 'jim', rel: rel(0.55) }], seq(0, 0));
  assert.equal(choice?.id, 'jim');
});

test('strangers and indifference exert no pull at all', () => {
  // No relationship row → no reason to cross the room. A roll of 0 would pass
  // any odds check, so a null here proves the candidate never entered the pool.
  assert.equal(pickIdleCompanion([{ id: 'creed' }], seq(0, 0)), null);
  assert.equal(pickIdleCompanion([{ id: 'toby', rel: rel(0.05) }], seq(0, 0)), null);
  assert.equal(pickIdleCompanion([{ id: 'toby', rel: rel(-0.4) }], seq(0, 0)), null);
});

test('open friction is avoided outright, not merely down-weighted', () => {
  const angry = { id: 'toby', rel: rel(0.0, 0.8, 0.9) };
  assert.equal(pickIdleCompanion([angry], seq(0, 0)), null);
  // …but warmth alongside the friction (old colleagues who bicker) still counts.
  const bickering = { id: 'dwight', rel: rel(0.6, 0.8, 0.9) };
  assert.equal(pickIdleCompanion([bickering], seq(0, 0))?.id, 'dwight');
});

test('deep affinity raises the odds of seeking company at all', () => {
  const mild = [{ id: 'kevin', rel: rel(0.2) }];
  const deep = [{ id: 'pam', rel: rel(1) }];
  // A roll just above the base odds: too shy for a mild bond, enough for a deep one.
  const roll = IDLE_SEEK_BASE_ODDS + 0.2;
  assert.equal(pickIdleCompanion(mild, seq(roll, 0)), null);
  assert.equal(pickIdleCompanion(deep, seq(roll, 0))?.id, 'pam');
});

test('the weighted pick favours the warmer of two colleagues', () => {
  const candidates = [
    { id: 'cool', rel: rel(0.2, 0, 0) },
    { id: 'warm', rel: rel(0.9, 0, 0.8) }
  ];
  const wCool = companionWeight(candidates[0].rel);
  const wWarm = companionWeight(candidates[1].rel);
  assert.ok(wWarm > wCool * 1.5, `warmth should dominate: ${wCool} vs ${wWarm}`);
  // Land the roll inside the second (warm) slice of the weighted wheel.
  const total = wCool + wWarm;
  const choice = pickIdleCompanion(candidates, seq(0, (wCool + 0.01) / total));
  assert.equal(choice?.id, 'warm');
});

test('the pull strength is bounded and rises with warmth', () => {
  assert.ok(companionPull(rel(0.15)) < companionPull(rel(0.9)));
  assert.ok(companionPull(rel(1)) <= 1);
  assert.ok(companionPull(rel(0.15)) > 0);
});

test('an empty floor yields nobody to drift toward', () => {
  assert.equal(pickIdleCompanion([], seq(0, 0)), null);
});
