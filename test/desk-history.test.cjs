'use strict';

// Desk history (src/renderer/src/scene/office/deskHistory.ts) — the ladder that
// turns an agent's REAL closed-task count into the trinkets on its desk.
//
// The properties worth protecting are the ones that make the decoration
// trustworthy rather than pretty:
//   - it is a pure function of the ledger (same count in → same desk out), so
//     a desk can never claim work the task board does not also show as closed;
//   - it is MONOTONIC (a bigger count never takes a prop away), so a desk reads
//     as a history and not as a mood;
//   - it is CAPPED (never more props than the ladder has rungs), so twenty busy
//     agents cannot bury the floor in clutter;
//   - it FAILS EMPTY on anything malformed, so a hand-edited tasks.json can
//     never invent a trophy.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  deskHistoryFor, sameDesk, countDoneByAssignee,
  DESK_PROP_LADDER, MAX_DESK_PROPS, MAX_SHEETS, EMPTY_DESK
} = loadTs('src/renderer/src/scene/office/deskHistory.ts');

// ─── the ladder ─────────────────────────────────────────────────────────────

test('a fresh hire sits at a bare desk', () => {
  assert.deepEqual(deskHistoryFor(0), EMPTY_DESK);
  assert.deepEqual(deskHistoryFor(0).props, []);
  assert.equal(deskHistoryFor(0).sheets, 0);
});

test('the first closure puts paper on the desk', () => {
  const desk = deskHistoryFor(1);
  assert.deepEqual(desk.props, ['papers']);
  assert.equal(desk.sheets, 1);
  assert.equal(desk.done, 1);
});

test('each rung of the ladder adds exactly one prop', () => {
  for (let i = 0; i < DESK_PROP_LADDER.length; i++) {
    const step = DESK_PROP_LADDER[i];
    const desk = deskHistoryFor(step.at);
    assert.equal(desk.props.length, i + 1, `rung ${step.kind} at ${step.at}`);
    assert.equal(desk.props[i], step.kind);
  }
});

test('a count one short of a rung does not unlock it', () => {
  for (const step of DESK_PROP_LADDER) {
    const before = deskHistoryFor(step.at - 1);
    assert.ok(!before.props.includes(step.kind), `${step.kind} leaked at ${step.at - 1}`);
  }
});

test('the ladder is strictly ascending — no rung is unreachable', () => {
  for (let i = 1; i < DESK_PROP_LADDER.length; i++) {
    assert.ok(DESK_PROP_LADDER[i].at > DESK_PROP_LADDER[i - 1].at);
  }
});

test('every rung is a distinct prop', () => {
  const kinds = new Set(DESK_PROP_LADDER.map((s) => s.kind));
  assert.equal(kinds.size, DESK_PROP_LADDER.length);
});

// ─── monotonic, and capped ──────────────────────────────────────────────────

test('a desk only ever gains — nothing is ever taken away', () => {
  let prev = deskHistoryFor(0);
  for (let n = 1; n <= 60; n++) {
    const desk = deskHistoryFor(n);
    assert.ok(desk.props.length >= prev.props.length, `lost a prop at ${n}`);
    // everything previously on the desk is still on it, in the same order
    assert.deepEqual(desk.props.slice(0, prev.props.length), [...prev.props]);
    assert.ok(desk.sheets >= prev.sheets, `lost a sheet at ${n}`);
    prev = desk;
  }
});

test('the floor can never be buried — props stop at the cap', () => {
  for (const n of [8, 9, 20, 100, 10_000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(deskHistoryFor(n).props.length, MAX_DESK_PROPS);
  }
});

test('past the last rung only the paper stack grows, and it too stops', () => {
  const last = DESK_PROP_LADDER[DESK_PROP_LADDER.length - 1].at;
  assert.equal(deskHistoryFor(last).sheets, 1);
  assert.equal(deskHistoryFor(last + 1).sheets, 2);
  assert.equal(deskHistoryFor(last + MAX_SHEETS).sheets, MAX_SHEETS);
  assert.equal(deskHistoryFor(last + 500).sheets, MAX_SHEETS);
});

test('the desk is a pure function of the count', () => {
  assert.deepEqual(deskHistoryFor(7), deskHistoryFor(7));
  assert.notDeepEqual(deskHistoryFor(7), deskHistoryFor(8));
});

// ─── failing empty ──────────────────────────────────────────────────────────

test('nonsense counts earn nothing rather than something', () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, -5, '12', {}, [], true]) {
    assert.deepEqual(deskHistoryFor(bad).props, [], `unlocked on ${String(bad)}`);
  }
});

test('a fractional count is floored, not rounded up into a rung', () => {
  assert.deepEqual(deskHistoryFor(2.9).props, deskHistoryFor(2).props);
  assert.equal(deskHistoryFor(0.9).props.length, 0);
});

// ─── the repaint guard ──────────────────────────────────────────────────────

test('sameDesk is true only when the drawing would be identical', () => {
  assert.ok(sameDesk(deskHistoryFor(3), deskHistoryFor(4)));   // same rung, same sheets
  assert.ok(!sameDesk(deskHistoryFor(4), deskHistoryFor(5)));  // crossed a rung
  const last = DESK_PROP_LADDER[DESK_PROP_LADDER.length - 1].at;
  assert.ok(!sameDesk(deskHistoryFor(last), deskHistoryFor(last + 1))); // sheet gained
  assert.ok(sameDesk(deskHistoryFor(last + 90), deskHistoryFor(last + 400))); // both capped
});

// ─── reading the ledger ─────────────────────────────────────────────────────

test('only done cards with a real assignee are counted', () => {
  const counts = countDoneByAssignee([
    { status: 'done', assignee: 'jim' },
    { status: 'done', assignee: 'jim' },
    { status: 'doing', assignee: 'jim' },      // not closed
    { status: 'done', assignee: '  ' },        // nobody's
    { status: 'done' },                        // unassigned
    { status: 'done', assignee: 'pam' },
    { status: 'blocked', assignee: 'pam' }
  ]);
  assert.equal(counts.get('jim'), 2);
  assert.equal(counts.get('pam'), 1);
  assert.equal(counts.size, 2);
});

test('assignee ids are trimmed so one agent is never two desks', () => {
  const counts = countDoneByAssignee([
    { status: 'done', assignee: 'jim' },
    { status: 'done', assignee: ' jim ' }
  ]);
  assert.equal(counts.get('jim'), 2);
  assert.equal(counts.size, 1);
});

test('a malformed ledger reads as an empty floor, not a crash', () => {
  for (const bad of [null, undefined, {}, 'tasks', 7]) {
    assert.equal(countDoneByAssignee(bad).size, 0);
  }
  assert.equal(countDoneByAssignee([null, undefined, 3, 'x', { status: 'done', assignee: 4 }]).size, 0);
});

test('status must be exactly done — no truthy near-misses', () => {
  const counts = countDoneByAssignee([
    { status: 'DONE', assignee: 'jim' },
    { status: 'done ', assignee: 'jim' },
    { status: true, assignee: 'jim' }
  ]);
  assert.equal(counts.size, 0);
});

// ─── end to end: ledger → desk ──────────────────────────────────────────────

test('a ledger maps straight onto desks', () => {
  const cards = [];
  for (let i = 0; i < 9; i++) cards.push({ status: 'done', assignee: 'dwight' });
  for (let i = 0; i < 2; i++) cards.push({ status: 'done', assignee: 'kevin' });
  cards.push({ status: 'todo', assignee: 'kevin' });
  const counts = countDoneByAssignee(cards);
  const dwight = deskHistoryFor(counts.get('dwight'));
  const kevin = deskHistoryFor(counts.get('kevin'));
  const oscar = deskHistoryFor(counts.get('oscar'));   // never closed anything
  assert.equal(dwight.props.length, MAX_DESK_PROPS);
  assert.ok(dwight.props.includes('trophy'));
  assert.deepEqual(kevin.props, ['papers', 'plant']);
  assert.deepEqual(oscar.props, []);
});
