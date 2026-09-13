'use strict';

// Pure-logic coverage for the "Dundies" closing-time recap tracker
// (src/renderer/src/store/dundiesStats.ts). No zustand here — same reasoning
// as focus-mode.test.cjs: the store-wiring in store.ts is exercised only by
// hand-inspection, this file locks down the folding/snapshot math itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  createDundiesTrackState, noteDundiesAgent, dundiesStatsSnapshot, formatDundiesDuration,
  DUNDIES_BUSY_STATUSES
} = loadTs('src/renderer/src/store/dundiesStats.ts');

test('a brand-new agent starts at zero active time', () => {
  const st = createDundiesTrackState();
  noteDundiesAgent(st, { id: 'a', name: 'Jim', status: 'idle' }, 1000);
  const snap = dundiesStatsSnapshot(st, 1000);
  assert.deepEqual(snap, [{ id: 'a', name: 'Jim', activeMs: 0 }]);
});

test('time spent in a busy status accrues once the status changes away from it', () => {
  const st = createDundiesTrackState();
  noteDundiesAgent(st, { id: 'a', name: 'Jim', status: 'working' }, 0);
  // Still working 5000ms later — nothing banked yet until the transition.
  noteDundiesAgent(st, { id: 'a', name: 'Jim', status: 'working' }, 5000);
  assert.equal(dundiesStatsSnapshot(st, 5000)[0].activeMs, 5000, 'live busy time must fold into the snapshot even mid-status');
  // Transitions to idle at t=8000 — the 8000ms stretch is now banked.
  noteDundiesAgent(st, { id: 'a', name: 'Jim', status: 'idle' }, 8000);
  assert.equal(dundiesStatsSnapshot(st, 20000)[0].activeMs, 8000, 'idle time after the transition must not keep accruing');
});

test('idle/waiting/blocked time never counts as active', () => {
  const st = createDundiesTrackState();
  noteDundiesAgent(st, { id: 'a', name: 'Pam', status: 'idle' }, 0);
  noteDundiesAgent(st, { id: 'a', name: 'Pam', status: 'waiting' }, 3000);
  noteDundiesAgent(st, { id: 'a', name: 'Pam', status: 'blocked' }, 6000);
  assert.equal(dundiesStatsSnapshot(st, 10000)[0].activeMs, 0);
});

test('multiple busy stretches accumulate across several transitions', () => {
  const st = createDundiesTrackState();
  noteDundiesAgent(st, { id: 'a', name: 'Dwight', status: 'thinking' }, 0);
  noteDundiesAgent(st, { id: 'a', name: 'Dwight', status: 'working' }, 1000); // thinking: +1000, still busy
  noteDundiesAgent(st, { id: 'a', name: 'Dwight', status: 'idle' }, 4000);   // working: +3000
  noteDundiesAgent(st, { id: 'a', name: 'Dwight', status: 'compacting' }, 6000); // idle: +0
  noteDundiesAgent(st, { id: 'a', name: 'Dwight', status: 'idle' }, 6500);   // compacting: +500
  assert.equal(dundiesStatsSnapshot(st, 9000)[0].activeMs, 1000 + 3000 + 500);
});

test('a same-status call is a no-op that neither banks nor resets the clock', () => {
  const st = createDundiesTrackState();
  noteDundiesAgent(st, { id: 'a', name: 'Angela', status: 'working' }, 0);
  noteDundiesAgent(st, { id: 'a', name: 'Angela', status: 'working' }, 500); // re-confirm, same status
  noteDundiesAgent(st, { id: 'a', name: 'Angela', status: 'working' }, 1500);
  noteDundiesAgent(st, { id: 'a', name: 'Angela', status: 'idle' }, 2000);
  // Had a re-confirm reset `since`, this would read 500 instead of 2000.
  assert.equal(dundiesStatsSnapshot(st, 5000)[0].activeMs, 2000);
});

test('an agent that disappears from the roster keeps its banked time', () => {
  const st = createDundiesTrackState();
  noteDundiesAgent(st, { id: 'a', name: 'Kevin', status: 'working' }, 0);
  noteDundiesAgent(st, { id: 'a', name: 'Kevin', status: 'idle' }, 2000);
  // No further calls for "a" (its terminal closed) — later snapshots still see it.
  const snap = dundiesStatsSnapshot(st, 999999);
  assert.equal(snap.find((s) => s.id === 'a')?.activeMs, 2000);
});

test('a renamed agent keeps its accumulated time under the same id', () => {
  const st = createDundiesTrackState();
  noteDundiesAgent(st, { id: 'a', name: 'Old Name', status: 'working' }, 0);
  noteDundiesAgent(st, { id: 'a', name: 'New Name', status: 'idle' }, 1000);
  const snap = dundiesStatsSnapshot(st, 1000);
  assert.deepEqual(snap, [{ id: 'a', name: 'New Name', activeMs: 1000 }]);
});

test('snapshot sorts most-active first', () => {
  const st = createDundiesTrackState();
  noteDundiesAgent(st, { id: 'quiet', name: 'Toby', status: 'working' }, 0);
  noteDundiesAgent(st, { id: 'quiet', name: 'Toby', status: 'idle' }, 100);
  noteDundiesAgent(st, { id: 'busy', name: 'Michael', status: 'working' }, 0);
  noteDundiesAgent(st, { id: 'busy', name: 'Michael', status: 'idle' }, 9000);
  const snap = dundiesStatsSnapshot(st, 9000);
  assert.deepEqual(snap.map((s) => s.id), ['busy', 'quiet']);
});

test('DUNDIES_BUSY_STATUSES matches the on-floor isBusy definition (OfficeFloor.tsx)', () => {
  assert.deepEqual([...DUNDIES_BUSY_STATUSES].sort(), ['compacting', 'thinking', 'working']);
});

test('formatDundiesDuration formats sub-minute, minutes-only, and hour+minute spans', () => {
  assert.equal(formatDundiesDuration(0), '<1m');
  assert.equal(formatDundiesDuration(20_000), '<1m');
  assert.equal(formatDundiesDuration(60_000), '1m');
  assert.equal(formatDundiesDuration(9 * 60_000), '9m');
  assert.equal(formatDundiesDuration(65 * 60_000), '1h 5m');
  assert.equal(formatDundiesDuration(125 * 60_000), '2h 5m');
});
