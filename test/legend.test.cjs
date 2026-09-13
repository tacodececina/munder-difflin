'use strict';

// The floor's LEGEND wall (src/renderer/src/store/legend.ts) and the main-side
// observer that feeds it (HiveManager.observeTaskCompletions).
//
// The one property worth protecting here is TRUTHFULNESS: every line on that
// wall must correspond to a real closure the hive recorded, with the closer and
// the time it actually happened. So these tests are mostly about what the code
// REFUSES to do — invent a timestamp, re-announce old work on every app start,
// or credit a closure to nobody in particular.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { buildLegend, readTaskDoneEvents, longestStreak, STREAK_MILESTONE } =
  loadTs('src/renderer/src/store/legend.ts');

const done = (ts, taskId, title, assignee) => ({ kind: 'task_done', ts, taskId, title, assignee });
const card = (id, title, status, assignee) => ({ id, title, status, assignee });

// ─── reading the event feed ─────────────────────────────────────────────────

test('only well-formed task_done rows become events', () => {
  const events = readTaskDoneEvents([
    { kind: 'message', ts: 1, from: 'jim', to: 'pam' },   // a different event kind
    { raw: 'this line did not parse' },                   // logTail's fallback shape
    { kind: 'task_done', ts: 5 },                         // no task id
    { kind: 'task_done', taskId: 't-1' },                 // no timestamp
    done(9, 't-2', 'Ship the thing', 'jim'),
    null,
    'nope'
  ]);
  assert.deepEqual(events, [{ taskId: 't-2', at: 9, title: 'Ship the thing', who: 'jim' }]);
});

test('a non-array log is empty, not a crash', () => {
  assert.deepEqual(readTaskDoneEvents(undefined), []);
  assert.deepEqual(readTaskDoneEvents({ tasks: [] }), []);
});

// ─── building the wall ──────────────────────────────────────────────────────

test('witnessed closures are newest first, numbered oldest first', () => {
  const wall = buildLegend([
    done(100, 't-1', 'First real thing', 'jim'),
    done(300, 't-3', 'Third', 'pam'),
    done(200, 't-2', 'Second', 'pam')
  ], []);
  assert.deepEqual(wall.map((e) => e.id), ['t-3', 't-2', 't-1']);
  assert.deepEqual(wall.map((e) => e.ordinal), [3, 2, 1]);
  // #1 is the first thing this floor ever finished — that is the badge the panel shows.
  assert.equal(wall.find((e) => e.ordinal === 1).title, 'First real thing');
});

test('a card closed twice appears once, dated by its latest close', () => {
  const wall = buildLegend([
    done(100, 't-1', 'Reopened later', 'jim'),
    done(900, 't-1', 'Reopened later', 'pam')
  ], []);
  assert.equal(wall.length, 1);
  assert.equal(wall[0].at, 900);
  assert.equal(wall[0].who, 'pam', 'the closer of record is whoever closed it last');
});

test('consecutive closures by one agent build a run; anyone else resets it', () => {
  const wall = buildLegend([
    done(1, 't-1', 'a', 'jim'),
    done(2, 't-2', 'b', 'jim'),
    done(3, 't-3', 'c', 'jim'),
    done(4, 't-4', 'd', 'pam')
  ], []);
  const byId = Object.fromEntries(wall.map((e) => [e.id, e.streak]));
  assert.deepEqual(byId, { 't-1': 1, 't-2': 2, 't-3': 3, 't-4': 1 });
  assert.equal(longestStreak(wall), 3);
  assert.ok(STREAK_MILESTONE <= 3, 'the run badge must be reachable by this fixture');
});

test('unassigned closures never form a run with each other', () => {
  // Two cards nobody owned are not "the same agent twice" — crediting a run to
  // an absent owner is exactly the kind of invented story this wall must not tell.
  const wall = buildLegend([done(1, 't-1', 'a'), done(2, 't-2', 'b')], []);
  assert.deepEqual(wall.map((e) => e.streak), [1, 1]);
  assert.equal(longestStreak(wall), 1);
  assert.equal(wall[0].who, undefined);
});

test('a done card the log never witnessed is listed WITHOUT a time, never a guessed one', () => {
  const wall = buildLegend([done(50, 't-1', 'Witnessed', 'jim')], [
    card('t-1', 'Witnessed', 'done', 'jim'),
    card('t-old', 'Closed before the observer existed', 'done', 'pam'),
    card('t-open', 'Still going', 'doing', 'pam')
  ]);
  assert.deepEqual(wall.map((e) => e.id), ['t-1', 't-old'], 'open cards are not legends');
  const old = wall[1];
  assert.equal(old.at, undefined);
  assert.equal(old.ordinal, undefined, 'an undated entry has no position in the sequence');
  assert.equal(old.who, 'pam', 'the ledger still knows who owned it');
  assert.equal(longestStreak(wall), 1, 'undated entries never count toward a run');
});

test('a hand-edited ledger that repeats an id yields ONE entry, not a duplicate React key', () => {
  // tasks.json is hand-editable, so the same id can appear twice. The panel keys
  // its rows on `id`; two entries with one id is a duplicate-key render bug.
  const wall = buildLegend([], [
    card('t-dup', 'First copy', 'done', 'jim'),
    card('t-dup', 'Second copy', 'done', 'pam'),
    card('t-other', 'A different card', 'done', 'pam')
  ]);
  assert.deepEqual(wall.map((e) => e.id), ['t-dup', 't-other']);
  assert.equal(wall[0].title, 'First copy', 'first card wins, same rule the hive observer uses');
  assert.equal(new Set(wall.map((e) => e.id)).size, wall.length, 'every key on the wall is unique');
});

test('the log outranks the ledger for a card that was closed and then dismissed', () => {
  // The card is gone from tasks.json; the closure still happened.
  const wall = buildLegend([done(7, 't-gone', 'Shipped, then cleared off the board', 'jim')], []);
  assert.equal(wall.length, 1);
  assert.equal(wall[0].title, 'Shipped, then cleared off the board');
});

test('an empty floor produces an empty wall, not a placeholder legend', () => {
  assert.deepEqual(buildLegend([], []), []);
});

// ─── the observer that writes the events ────────────────────────────────────

const { HiveManager } = loadTs('src/main/hive.ts');

function tempHive(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'legend-hive-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  return { home, hive, root: path.join(home, 'hive') };
}
const putTasks = (root, tasks) =>
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks }, null, 2), 'utf8');
const doneRows = (root) =>
  fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.kind === 'task_done');

test('the first tick only baselines — existing done cards are never re-announced', (t) => {
  const { hive, root } = tempHive(t);
  putTasks(root, [card('t-1', 'Closed last week', 'done', 'jim')]);
  assert.deepEqual(hive.observeTaskCompletions(), []);
  assert.deepEqual(doneRows(root), [], 'an app start must not replay the whole board');
  // …and staying done on later ticks stays silent too.
  assert.deepEqual(hive.observeTaskCompletions(), []);
  assert.deepEqual(doneRows(root), []);
});

test('a real transition into done is recorded with title, closer and origin', (t) => {
  const { hive, root } = tempHive(t);
  putTasks(root, [card('t-1', 'Wire the printer', 'doing', 'jim')]);
  hive.observeTaskCompletions(); // baseline
  putTasks(root, [card('t-1', 'Wire the printer', 'done', 'jim')]);
  assert.deepEqual(hive.observeTaskCompletions(), ['t-1']);
  const rows = doneRows(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskId, 't-1');
  assert.equal(rows[0].title, 'Wire the printer');
  assert.equal(rows[0].assignee, 'jim');
  assert.equal(rows[0].from, 'doing');
  assert.ok(typeof rows[0].ts === 'number' && rows[0].ts > 0, 'appendLog stamps the time');
  // Idempotent: a card that simply stays done does not log again.
  assert.deepEqual(hive.observeTaskCompletions(), []);
  assert.equal(doneRows(root).length, 1);
});

test('a card reopened and closed again is a second, real closure', (t) => {
  const { hive, root } = tempHive(t);
  putTasks(root, [card('t-1', 'Flaky thing', 'doing', 'jim')]);
  hive.observeTaskCompletions();
  putTasks(root, [card('t-1', 'Flaky thing', 'done', 'jim')]);
  hive.observeTaskCompletions();
  putTasks(root, [card('t-1', 'Flaky thing', 'todo', 'jim')]);
  hive.observeTaskCompletions();
  putTasks(root, [card('t-1', 'Flaky thing', 'done', 'pam')]);
  hive.observeTaskCompletions();
  const rows = doneRows(root);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].assignee, 'pam');
  // The wall still shows ONE line for it — the latest close.
  const wall = buildLegend(rows, []);
  assert.equal(wall.length, 1);
  assert.equal(wall[0].who, 'pam');
});

test('a card created and closed between two ticks still counts', (t) => {
  const { hive, root } = tempHive(t);
  putTasks(root, []);
  hive.observeTaskCompletions(); // baseline on an empty board
  putTasks(root, [card('t-fast', 'Same-tick job', 'done', 'dwight')]);
  assert.deepEqual(hive.observeTaskCompletions(), ['t-fast']);
  assert.equal(doneRows(root)[0].from, undefined, 'no prior status to report, and none invented');
});

test('an unreadable ledger skips the tick and keeps the baseline', (t) => {
  const { hive, root } = tempHive(t);
  putTasks(root, [card('t-1', 'Real work', 'doing', 'jim')]);
  hive.observeTaskCompletions();
  fs.writeFileSync(path.join(root, 'tasks.json'), '{ this is not json', 'utf8');
  assert.deepEqual(hive.observeTaskCompletions(), []);
  // Recovering the file and closing the card still fires — the baseline survived
  // the bad read rather than being replaced by an empty one.
  putTasks(root, [card('t-1', 'Real work', 'done', 'jim')]);
  assert.deepEqual(hive.observeTaskCompletions(), ['t-1']);
});

test('cards without an id are skipped rather than merged into one another', (t) => {
  const { hive, root } = tempHive(t);
  putTasks(root, []);
  hive.observeTaskCompletions();
  putTasks(root, [{ title: 'No id', status: 'done' }, card('t-1', 'Has one', 'done', 'jim')]);
  assert.deepEqual(hive.observeTaskCompletions(), ['t-1']);
});
