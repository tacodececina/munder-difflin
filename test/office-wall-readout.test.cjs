'use strict';

// THE OFFICE'S TWO WALL INSTRUMENTS SHOW REAL DATA, OR THEY SHOW NOTHING.
//
// The floor redesign hung a panoramic display over 01/OPERATIONS and a
// PLAN / BUILD / SHIP whiteboard in 04/BRIEFING, and filled both with invented
// content: a fixed "99.98 UPTIME", a nine-bar chart that was a literal array in
// the art, an API→CORE→DB topology naming services that do not exist, and four
// sticky notes standing for no card. This is the suite for the replacement.
//
// What it guards is precisely the thing that rots in silence, because none of
// it throws when it is wrong — it just looks plausible on a wall:
//
//   1. NO DATA IS NOT ZERO. Every panel distinguishes "could not read the
//      source" (null → the words NO DATA) from a real zero (a repo with no
//      runs, an hour with no closures, an empty ledger column). Collapsing the
//      two is exactly how a fake number gets back onto the wall, and it is the
//      most tempting simplification in the module. The rule holds per BAR too:
//      the event feed is read as a tail, and the hours that tail does not reach
//      back to are unmeasured, not quiet.
//   2. A FAILED POLL LAPSES. A held reading survives a dropped read and then
//      expires, so a source that dies does not leave its last number hanging
//      on the wall for ever.
//   3. NOTHING IS GUESSED. An unknown CI conclusion is `other`, not `pass`. An
//      unknown task status is counted in NO column. A closure outside the
//      nine-hour window is dropped, not clamped into the nearest bar.
//   4. THE ART STILL FITS. Every label, count, pip, chip and bar is drawn
//      inside the region the prop leaves for it — a readout that overflows its
//      glass is a readout painted onto the wall beside it.
//   5. THE INVENTED CONTENT IS ACTUALLY GONE from the baked atlas, and the two
//      props are still seamless, still palette-clean, still in the map.
//
// Pure by construction: no pixi, no store, no DOM — the same discipline
// wingFraming.ts, weather.ts and idleAffinity.ts are held to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const R = loadTs('src/renderer/src/scene/office/wallReadout.ts');
const {
  agentPips, bucketShipped, ciStateOf, countLabel, heldValue, planSignature,
  readoutSignature, summarizeCIRuns, summarizePlanBoard, NO_READOUT,
  CI_SLOTS, CI_TTL_MS, PLAN_TTL_MS, SHIPPED_BUCKETS, SHIPPED_BUCKET_MS, SHIPPED_TTL_MS,
  SHIPPED_LOG_WINDOW,
} = R;
const {
  drawOpsReadout, drawPlanReadout, OPS_READOUT_RECT, PLAN_READOUT_RECT,
  rgbFromHex, techTextWidth, drawTechProp, TECH_PIECES,
} = loadTs('src/renderer/src/scene/office/techOfficeArt.ts');
const { TILE_PALETTES } = loadTs('src/renderer/src/scene/office/tileArt.ts');
const { FloorWeather, READING_TTL_MS } = loadTs('src/renderer/src/scene/office/weather.ts');
const { OFFICE_BINDINGS } = loadTs('src/renderer/src/scene/office/officeLayout.ts');
const { buildOfficeMap } = require('../tools/gen-tech-office.cjs');

const PAL = TILE_PALETTES['office-tech'];
const NOW = 1_760_000_000_000;

/** Every distinct opaque colour in a buffer, as "r,g,b". */
function opaqueColors(buf) {
  const seen = new Set();
  for (let i = 0; i < buf.data.length; i += 4) {
    if (buf.data[i + 3] === 255) seen.add(`${buf.data[i]},${buf.data[i + 1]},${buf.data[i + 2]}`);
  }
  return seen;
}
/** Does `buf` contain any pixel of exactly this colour? */
function hasColor(buf, rgb) {
  return opaqueColors(buf).has(rgb.join(','));
}

// ─── 1 + 3. The derivation: null vs zero, and nothing guessed ───────────────

test('a CI reply that is not an answer is null, and an empty repo is an empty answer', () => {
  for (const reply of [null, undefined, 'nope', 42, {}, { ok: false, error: 'gh: not found' },
    { ok: true }, { ok: true, runs: 'boom' }]) {
    assert.equal(summarizeCIRuns(reply), null, JSON.stringify(reply));
  }
  // A repository with Actions enabled and no runs yet. REAL, and not NO DATA.
  assert.deepEqual(summarizeCIRuns({ ok: true, runs: [] }), []);
});

test('a run is only pass or fail when gh actually said so', () => {
  assert.equal(ciStateOf({ status: 'completed', conclusion: 'success' }), 'pass');
  assert.equal(ciStateOf({ status: 'completed', conclusion: 'failure' }), 'fail');
  assert.equal(ciStateOf({ status: 'completed', conclusion: 'timed_out' }), 'fail');
  assert.equal(ciStateOf({ status: 'completed', conclusion: 'startup_failure' }), 'fail');
  assert.equal(ciStateOf({ status: 'in_progress', conclusion: null }), 'running');
  assert.equal(ciStateOf({ status: 'queued', conclusion: null }), 'running');
  // Cancelled, skipped, neutral, action_required, a conclusion GitHub adds next
  // year, a malformed row: grey. Never green.
  for (const conclusion of ['cancelled', 'skipped', 'neutral', 'action_required', '', null, 7]) {
    assert.equal(ciStateOf({ status: 'completed', conclusion }), 'other', String(conclusion));
  }
  assert.equal(ciStateOf(null), 'other');
  assert.equal(ciStateOf({ status: 'some_new_state' }), 'other');
});

test('the CI strip reads left to right: gh lists newest first, the wall shows it last', () => {
  const reply = { ok: true, runs: [
    { status: 'in_progress' },                               // newest
    { status: 'completed', conclusion: 'failure' },
    { status: 'completed', conclusion: 'success' },          // oldest
  ] };
  assert.deepEqual(summarizeCIRuns(reply), ['pass', 'fail', 'running']);
});

test('the CI strip never shows more runs than it has slots for', () => {
  const runs = new Array(12).fill({ status: 'completed', conclusion: 'success' });
  assert.equal(summarizeCIRuns({ ok: true, runs }).length, CI_SLOTS);
});

test('an unreadable event feed is null; a readable one with no closures is nine real zeros', () => {
  for (const log of [null, undefined, {}, 'rows']) assert.equal(bucketShipped(log, NOW), null);
  assert.deepEqual(bucketShipped([], NOW), new Array(SHIPPED_BUCKETS).fill(0));
  // A log full of OTHER hive events is also a real zero: nothing shipped.
  const noise = [{ kind: 'agent_spawned', ts: NOW }, { raw: 'unparseable line' }, { kind: 'task_done' }];
  assert.deepEqual(bucketShipped(noise, NOW), new Array(SHIPPED_BUCKETS).fill(0));
});

test('closures land in the hour they happened, and only inside the window', () => {
  const done = (minutesAgo, id) => ({ kind: 'task_done', ts: NOW - minutesAgo * 60_000, taskId: id, title: 't' });
  const buckets = bucketShipped([
    done(10, 'a'), done(20, 'b'),      // this hour → last bucket
    done(70, 'c'),                     // one hour back
    done(60 * 8 + 30, 'd'),            // still inside the nine-hour window
    done(60 * 9 + 1, 'e'),             // just outside — dropped, not clamped
    done(60 * 400, 'f'),               // ancient
    { kind: 'task_done', ts: NOW + 60_000, taskId: 'g', title: 't' },  // the future
  ], NOW);
  assert.equal(buckets.length, SHIPPED_BUCKETS);
  assert.equal(buckets[SHIPPED_BUCKETS - 1], 2);
  assert.equal(buckets[SHIPPED_BUCKETS - 2], 1);
  assert.equal(buckets[0], 1);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 4);
});

test('hours the log tail never reached are unmeasured, not quiet', () => {
  // `hive:log` answers with the LAST n rows of a file that logs EVERY hive
  // event, so a busy floor's 400 rows can span far less than nine hours. The
  // hours off the top of that tail were never looked at, and a zero bar there
  // would be a fabricated reading — the exact defect this module deleted from
  // the baked art, only smaller.
  const window = 5;
  const chatty = [
    // Oldest row we hold is two and a half hours ago: everything before it was
    // cut off the top of the tail.
    { kind: 'message', ts: NOW - 150 * 60_000 },
    { kind: 'message', ts: NOW - 100 * 60_000 },
    { kind: 'task_done', ts: NOW - 90 * 60_000, taskId: 'a', title: 't' },
    { kind: 'message', ts: NOW - 30 * 60_000 },
    { kind: 'task_done', ts: NOW - 10 * 60_000, taskId: 'b', title: 't' },
  ];
  const buckets = bucketShipped(chatty, NOW, window);
  assert.equal(buckets.length, SHIPPED_BUCKETS);
  // Nine buckets, oldest first; the tail opens 2.5 h back, so only the last two
  // FULL hours are vouched for. The bucket the coverage starts inside is null
  // too — a partial count is a wrong count, not a small one.
  assert.deepEqual(buckets, [null, null, null, null, null, null, null, 1, 1]);

  // The same rows, under a window they do not fill, are a complete feed: the
  // file is simply that short, and every hour really is measured.
  const complete = bucketShipped(chatty, NOW, window + 1);
  assert.deepEqual(complete, [0, 0, 0, 0, 0, 0, 0, 1, 1]);

  // A full window with no usable timestamp anywhere proves nothing about any
  // hour, so nothing is claimed for any of them.
  const undatable = bucketShipped(
    [{ raw: 'x' }, { raw: 'y' }, { kind: 'spawn' }], NOW, 3);
  assert.deepEqual(undatable, new Array(SHIPPED_BUCKETS).fill(null));

  // A closure inside an hour the tail only half covers stays UNCOUNTED, rather
  // than being reported as if the hour had been fully read.
  const partial = bucketShipped([
    { kind: 'task_done', ts: NOW - 95 * 60_000, taskId: 'c', title: 't' },
    { kind: 'task_done', ts: NOW - 70 * 60_000, taskId: 'd', title: 't' },
    { kind: 'task_done', ts: NOW - 10 * 60_000, taskId: 'e', title: 't' },
  ], NOW, 3);
  assert.equal(partial[SHIPPED_BUCKETS - 2], null);     // the half-covered hour
  assert.equal(partial[SHIPPED_BUCKETS - 1], 1);

  // The default window is the one OfficeFloor asks `hiveLog` for.
  assert.equal(SHIPPED_LOG_WINDOW, 400);
  const floor = fs.readFileSync(
    path.join(__dirname, '../src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');
  assert.match(floor, /bucketShipped\(log, Date\.now\(\), SHIPPED_LOG_WINDOW\)/);
  assert.match(floor, /hiveLog\(SHIPPED_LOG_WINDOW\)/);
});

test('the SHIPPED window is anchored on now, so the newest bucket is the live hour', () => {
  const at = NOW - 30 * 60_000;
  const buckets = bucketShipped([{ kind: 'task_done', ts: at, taskId: 'a', title: 't' }], NOW);
  assert.equal(buckets[SHIPPED_BUCKETS - 1], 1);
  // …and half an hour later that same closure has slid one bucket left.
  const later = bucketShipped(
    [{ kind: 'task_done', ts: at, taskId: 'a', title: 't' }], NOW + SHIPPED_BUCKET_MS);
  assert.equal(later[SHIPPED_BUCKETS - 1], 0);
  assert.equal(later[SHIPPED_BUCKETS - 2], 1);
});

test('an unreadable ledger is null; an empty ledger is four real zeros', () => {
  for (const reply of [null, undefined, [], 'tasks', { tasks: null }]) {
    assert.equal(summarizePlanBoard(reply), null, JSON.stringify(reply));
  }
  assert.deepEqual(summarizePlanBoard({ tasks: [] }), { plan: 0, build: 0, blocked: 0, ship: 0 });
});

test('a card with an unrecognised status is counted in NO column', () => {
  const board = summarizePlanBoard({ tasks: [
    { status: 'todo' }, { status: 'todo' }, { status: 'doing' },
    { status: 'blocked' }, { status: 'done' }, { status: 'done' }, { status: 'done' },
    { status: 'archived' }, { status: '' }, { status: 7 }, null, 'nope',
  ] });
  assert.deepEqual(board, { plan: 2, build: 1, blocked: 1, ship: 3 });
});

test('nobody reporting to the breaker is NO DATA, not an all-clear', () => {
  assert.equal(agentPips([], NOW), null);
  // A reading that has lapsed leaves the wall the same way it leaves the sky.
  const stale = [{ agentId: 'a', level: 'healthy', ts: NOW - READING_TTL_MS - 1 }];
  assert.equal(agentPips(stale, NOW), null);
  // An agent no longer on the floor has no pip.
  const gone = [{ agentId: 'ghost', level: 'stopped', ts: NOW }];
  assert.equal(agentPips(gone, NOW, new Set(['someone-else'])), null);
});

test('one pip per reporting agent, stably ordered and deduplicated', () => {
  const readings = [
    { agentId: 'c', level: 'stopped', ts: NOW },
    { agentId: 'a', level: 'healthy', ts: NOW },
    { agentId: 'b', level: 'steering', ts: NOW },
    { agentId: 'a', level: 'constrained', ts: NOW + 1 },   // later reading wins
  ];
  assert.deepEqual(agentPips(readings, NOW + 1), ['constrained', 'steering', 'stopped']);
});

test('FloorWeather.fresh feeds the pips from the very readings the sky uses', () => {
  const w = new FloorWeather();
  w.record({ agentId: 'a', level: 'healthy', ts: NOW });
  w.record({ agentId: 'b', level: 'stopped', ts: NOW });
  w.record({ agentId: 'old', level: 'steering', ts: NOW - READING_TTL_MS - 1 });
  assert.deepEqual(agentPips(w.fresh(NOW), NOW), ['healthy', 'stopped']);
  // fresh() prunes, exactly like summary() — so the two can never disagree.
  assert.equal(w.size, 2);
  assert.equal(w.weather(NOW), 'rain');       // one stopped agent is a storm
  assert.deepEqual(agentPips(w.fresh(NOW, new Set(['a'])), NOW, new Set(['a'])), ['healthy']);
});

// ─── 2. A failed poll keeps its answer, then lapses ─────────────────────────

test('a held reading survives a dropped poll and then expires to NO DATA', () => {
  const held = { value: ['pass'], at: NOW };
  assert.deepEqual(heldValue(held, NOW, CI_TTL_MS), ['pass']);
  assert.deepEqual(heldValue(held, NOW + CI_TTL_MS - 1, CI_TTL_MS), ['pass']);
  assert.equal(heldValue(held, NOW + CI_TTL_MS, CI_TTL_MS), null);
  assert.equal(heldValue(null, NOW, CI_TTL_MS), null);
  assert.equal(heldValue({ value: ['pass'], at: NaN }, NOW, CI_TTL_MS), null);
  // The ledger board lapses fastest: the cork boards beside it read the same
  // file every 5 s, so four silent polls already means something is wrong.
  assert.ok(PLAN_TTL_MS < SHIPPED_TTL_MS && SHIPPED_TTL_MS < CI_TTL_MS);
});

test('the repaint signature never confuses "no data" with a real zero', () => {
  const zeros = { agents: null, ci: [], shipped: new Array(SHIPPED_BUCKETS).fill(0) };
  assert.notEqual(readoutSignature(zeros), readoutSignature(NO_READOUT));
  assert.notEqual(
    readoutSignature({ ...zeros, ci: null }),
    readoutSignature(zeros));
  assert.equal(readoutSignature(zeros), readoutSignature({ ...zeros }));
  // …nor an unmeasured hour with a zero one: the repaint guard must not be the
  // place where the distinction quietly collapses.
  const blankHour = new Array(SHIPPED_BUCKETS).fill(0);
  blankHour[0] = null;
  assert.notEqual(readoutSignature({ ...zeros, shipped: blankHour }), readoutSignature(zeros));
  assert.notEqual(
    readoutSignature({ ...zeros, shipped: new Array(SHIPPED_BUCKETS).fill(null) }),
    readoutSignature({ ...zeros, shipped: null }));
  assert.notEqual(planSignature({ plan: 0, build: 0, blocked: 0, ship: 0 }), planSignature(null));
  assert.equal(planSignature({ plan: 1, build: 2, blocked: 3, ship: 4 }),
    planSignature({ plan: 1, build: 2, blocked: 3, ship: 4 }));
});

// ─── 4. Legibility: what is drawn fits where it is drawn ────────────────────

test('a count is printed only while it fits inside one board column', () => {
  assert.equal(countLabel(0), '0');
  assert.equal(countLabel(999), '999');
  // Three glyphs is the budget; past it the number is DROPPED, never clamped
  // into a plausible-looking "999".
  assert.equal(countLabel(1000), '');
  assert.equal(countLabel(-1), '');
  assert.equal(countLabel(NaN), '');
  assert.equal(countLabel(Infinity), '');
  // …and three glyphs really do fit: the column rules are 27px apart.
  assert.ok(techTextWidth('999') < 27);
  assert.ok(techTextWidth('NO DATA') < PLAN_READOUT_RECT.w);
});

test('both readouts fill their region exactly and paint nothing outside it', () => {
  const ops = drawOpsReadout({ agents: ['healthy'], ci: ['pass'], shipped: [1] }, PAL);
  assert.equal(ops.width, OPS_READOUT_RECT.w);
  assert.equal(ops.height, OPS_READOUT_RECT.h);
  assert.equal(ops.data.length, ops.width * ops.height * 4);
  const plan = drawPlanReadout({ plan: 1, build: 1, blocked: 1, ship: 1 }, PAL);
  assert.equal(plan.width, PLAN_READOUT_RECT.w);
  assert.equal(plan.height, PLAN_READOUT_RECT.h);
  // Opaque everywhere: these sit ON the prop's glass/board and replace it, so a
  // transparent pixel would show the baked art through the live reading.
  for (const buf of [ops, plan]) {
    for (let i = 3; i < buf.data.length; i += 4) assert.equal(buf.data[i], 255);
  }
  // The live region stays inside the prop it is pinned to.
  assert.ok(OPS_READOUT_RECT.x + OPS_READOUT_RECT.w <= TECH_PIECES.screen.w * 16);
  assert.ok(OPS_READOUT_RECT.y + OPS_READOUT_RECT.h <= TECH_PIECES.screen.h * 16);
  assert.ok(PLAN_READOUT_RECT.x + PLAN_READOUT_RECT.w <= TECH_PIECES.whiteboard.w * 16);
  assert.ok(PLAN_READOUT_RECT.y + PLAN_READOUT_RECT.h <= TECH_PIECES.whiteboard.h * 16);
});

test('the readouts stay inside the props\' palette rather than inventing colours', () => {
  const ops = drawOpsReadout(
    { agents: ['healthy', 'steering', 'constrained', 'stopped'], ci: ['pass', 'fail', 'running', 'other'], shipped: [0, 1, 9] },
    PAL);
  assert.ok(opaqueColors(ops).size <= 12, `ops readout uses ${opaqueColors(ops).size} colours`);
  const plan = drawPlanReadout({ plan: 9, build: 2, blocked: 1, ship: 40 }, PAL);
  assert.ok(opaqueColors(plan).size <= 10, `plan readout uses ${opaqueColors(plan).size} colours`);
});

test('the readouts are a pure function of their data and their palette', () => {
  const data = { agents: ['healthy'], ci: ['fail'], shipped: [3, 0, 1, 0, 0, 0, 0, 0, 2] };
  assert.deepEqual(drawOpsReadout(data, PAL).data, drawOpsReadout(data, PAL).data);
  assert.notDeepEqual(
    drawOpsReadout(data, PAL).data,
    drawOpsReadout({ ...data, ci: ['pass'] }, PAL).data);
  // A re-themed floor re-tints the instrument with it.
  assert.notDeepEqual(drawOpsReadout(data, PAL).data, drawOpsReadout(data, TILE_PALETTES.office).data);
  const board = { plan: 2, build: 1, blocked: 0, ship: 3 };
  assert.deepEqual(drawPlanReadout(board, PAL).data, drawPlanReadout(board, PAL).data);
  assert.notDeepEqual(drawPlanReadout(board, PAL).data, drawPlanReadout({ ...board, ship: 4 }, PAL).data);
});

// ─── 1 (again), at the pixel level: no data LOOKS like no data ──────────────

test('an unreadable panel draws no marks at all, only the words', () => {
  const ink = { todo: [1, 2, 3], doing: [4, 5, 6], blocked: [7, 8, 9], done: [10, 11, 12] };
  const blank = drawOpsReadout(NO_READOUT, PAL, ink);
  // Not one status colour anywhere: no pip, no chip, no bar.
  for (const [name, rgb] of Object.entries(ink)) assert.ok(!hasColor(blank, rgb), name);
  // …and the same surface WITH data does use them, so the check above has teeth.
  const live = drawOpsReadout(
    { agents: ['healthy'], ci: ['fail'], shipped: [9, 0, 0, 0, 0, 0, 0, 0, 0] }, PAL, ink);
  assert.ok(hasColor(live, ink.done));      // healthy pip + the saturation cap
  assert.ok(hasColor(live, ink.blocked));   // failed run
  const noBoard = drawPlanReadout(null, PAL, ink);
  for (const [name, rgb] of Object.entries(ink)) assert.ok(!hasColor(noBoard, rgb), name);
  assert.ok(hasColor(drawPlanReadout({ plan: 1, build: 1, blocked: 1, ship: 1 }, PAL, ink), ink.todo));
});

test('an empty CI strip and an empty hour are DRAWN, not skipped', () => {
  const ink = { todo: [1, 2, 3], doing: [4, 5, 6], blocked: [7, 8, 9], done: [10, 11, 12] };
  const empty = drawOpsReadout({ agents: null, ci: [], shipped: new Array(9).fill(0) }, PAL, ink);
  const missing = drawOpsReadout(NO_READOUT, PAL, ink);
  // Empty slots and zero-height stubs are marks on the glass; NO DATA is words.
  // The two must not render identically, or "nothing happened this hour" and
  // "the log could not be read" would look the same on the wall.
  assert.notDeepEqual(empty.data, missing.data);
});

test('a saturated hour says so instead of being clipped in silence', () => {
  const ink = { todo: [1, 2, 3], doing: [4, 5, 6], blocked: [7, 8, 9], done: [10, 11, 12] };
  const busy = drawOpsReadout({ agents: null, ci: null, shipped: [8, 0, 0, 0, 0, 0, 0, 0, 0] }, PAL, ink);
  const swamped = drawOpsReadout({ agents: null, ci: null, shipped: [99, 0, 0, 0, 0, 0, 0, 0, 0] }, PAL, ink);
  assert.notDeepEqual(busy.data, swamped.data);
  assert.ok(!hasColor(busy, ink.done));      // 8 exactly fills the panel, uncapped
  assert.ok(hasColor(swamped, ink.done));    // beyond it, the bar is capped
});

test('the chart draws exactly SHIPPED_BUCKETS hours — no more, no fewer', () => {
  const base = new Array(SHIPPED_BUCKETS).fill(0).map((_, i) => i % 3);
  // A tenth bucket has nowhere to go, and is not quietly folded into the ninth.
  assert.deepEqual(
    drawOpsReadout({ agents: null, ci: null, shipped: [...base, 7] }, PAL).data,
    drawOpsReadout({ agents: null, ci: null, shipped: base }, PAL).data);
  // An array shorter than the chart leaves the hours it does not describe
  // BLANK. Reading a missing bucket as zero would put a "nothing shipped this
  // hour" mark on the glass for an hour nobody measured.
  assert.deepEqual(
    drawOpsReadout({ agents: null, ci: null, shipped: base.slice(0, 4) }, PAL).data,
    drawOpsReadout({ agents: null, ci: null, shipped: [...base.slice(0, 4), null, null, null, null, null] }, PAL).data);
  assert.notDeepEqual(
    drawOpsReadout({ agents: null, ci: null, shipped: base.slice(0, 4) }, PAL).data,
    drawOpsReadout({ agents: null, ci: null, shipped: [...base.slice(0, 4), 0, 0, 0, 0, 0] }, PAL).data);
});

test('an hour nobody measured is not drawn as an hour in which nothing shipped', () => {
  const ink = { todo: [1, 2, 3], doing: [4, 5, 6], blocked: [7, 8, 9], done: [10, 11, 12] };
  const ops = (shipped) => drawOpsReadout({ agents: null, ci: null, shipped }, PAL, ink);
  const zeros = new Array(SHIPPED_BUCKETS).fill(0);
  const halfKnown = [null, null, null, null, 0, 0, 0, 1, 2];
  // The two differ on the glass: an unmeasured hour leaves the bare axis, a
  // measured-empty one keeps its stub. This is the SHIPPED column's half of the
  // same rule the NO DATA panels enforce.
  assert.notDeepEqual(ops(halfKnown).data, ops([0, 0, 0, 0, 0, 0, 0, 1, 2]).data);
  assert.notDeepEqual(ops(zeros).data, ops(new Array(SHIPPED_BUCKETS).fill(null)).data);
  // …and nine unmeasured hours are not a chart at all: the column says so in
  // words, exactly as it does when the feed cannot be read.
  assert.deepEqual(
    ops(new Array(SHIPPED_BUCKETS).fill(null)).data,
    ops(null).data);
  // A bar the feed DID cover still draws, unaffected by its blank neighbours.
  assert.ok(hasColor(ops([null, null, null, null, null, null, null, null, 99]), ink.done));
});

test('overflowing columns pile up instead of silently dropping cards', () => {
  const six = drawPlanReadout({ plan: 6, build: 0, blocked: 0, ship: 0 }, PAL);
  const seven = drawPlanReadout({ plan: 7, build: 0, blocked: 0, ship: 0 }, PAL);
  assert.notDeepEqual(six.data, seven.data);
  const thirty = drawOpsReadout({ agents: new Array(30).fill('healthy'), ci: null, shipped: null }, PAL);
  const thirtyOne = drawOpsReadout({ agents: new Array(31).fill('healthy'), ci: null, shipped: null }, PAL);
  assert.notDeepEqual(thirty.data, thirtyOne.data);
});

test('a blocked card rides the BUILD column, in the blocked colour', () => {
  const ink = { todo: [1, 2, 3], doing: [4, 5, 6], blocked: [7, 8, 9], done: [10, 11, 12] };
  const stuck = drawPlanReadout({ plan: 0, build: 0, blocked: 2, ship: 0 }, PAL, ink);
  assert.ok(hasColor(stuck, ink.blocked));
  assert.ok(!hasColor(stuck, ink.doing));
  // The column count covers both: BUILD is everything in flight.
  assert.deepEqual(
    drawPlanReadout({ plan: 0, build: 1, blocked: 1, ship: 0 }, PAL, ink).data.length,
    stuck.data.length);
});

// ─── 5. The invented content really is gone from the baked art ─────────────

test('the baked props carry chrome only: no uptime, no topology, no fixed bars', () => {
  const screen = drawTechProp('screen', PAL);
  const board = drawPlanReadout(null, PAL);
  assert.ok(screen.data.length > 0 && board.data.length > 0);
  // The invented content lived INSIDE the readout regions. Whatever the atlas
  // still draws there must be flat — one single colour — or the live panel
  // would be composited over a leftover chart.
  const region = new Set();
  for (let y = OPS_READOUT_RECT.y; y < OPS_READOUT_RECT.y + OPS_READOUT_RECT.h; y++) {
    for (let x = OPS_READOUT_RECT.x; x < OPS_READOUT_RECT.x + OPS_READOUT_RECT.w; x++) {
      const i = (y * screen.width + x) * 4;
      region.add(`${screen.data[i]},${screen.data[i + 1]},${screen.data[i + 2]}`);
    }
  }
  assert.equal(region.size, 1, `the screen's live region still bakes ${region.size} colours`);

  const wb = drawTechProp('whiteboard', PAL);
  const wbRegion = new Set();
  for (let y = PLAN_READOUT_RECT.y; y < PLAN_READOUT_RECT.y + PLAN_READOUT_RECT.h; y++) {
    for (let x = PLAN_READOUT_RECT.x; x < PLAN_READOUT_RECT.x + PLAN_READOUT_RECT.w; x++) {
      const i = (y * wb.width + x) * 4;
      wbRegion.add(`${wb.data[i]},${wb.data[i + 1]},${wb.data[i + 2]}`);
    }
  }
  assert.equal(wbRegion.size, 1, `the whiteboard's live region still bakes ${wbRegion.size} colours`);
});

test('the two live props are anchored by the theme, at the tiles the map stamps them on', () => {
  const { opsScreen, planBoard } = OFFICE_BINDINGS.anchors;
  const map = buildOfficeMap();
  const inventory = JSON.parse(map.properties.find((p) => p.name === 'propPlacements').value);
  const at = (key) => inventory.find((p) => p.key === key);
  assert.deepEqual({ x: at('screen').x, y: at('screen').y }, { x: opsScreen.x, y: opsScreen.y });
  assert.deepEqual({ x: at('whiteboard').x, y: at('whiteboard').y }, { x: planBoard.x, y: planBoard.y });
  // Both hang on `furniture-above`, i.e. on a wall, which is what the readout
  // overlay's depth (the prop's LAST row) assumes.
  assert.equal(at('screen').layer, 'furniture-above');
  assert.equal(at('whiteboard').layer, 'furniture-above');
});

test('no other shipped theme claims these anchors, so no other floor draws a readout', () => {
  // themeRegistry.ts imports `.png?url` assets and cannot be loaded outside the
  // bundler, so this reads the source: the ONLY place either anchor is assigned
  // a value is the office floor's own layout bindings. brooklyn99 /
  // siliconvalley / friends / got / hogwarts / isometric each keep their anchor
  // block right there in themeRegistry.ts, and none of them may grow one —
  // these props exist solely in the procedural tech-office atlas, and an anchor
  // without the prop would paint a live readout onto a bare wall.
  const registry = fs.readFileSync(
    path.join(__dirname, '../src/renderer/src/scene/office/themeRegistry.ts'), 'utf8');
  for (const key of ['opsScreen', 'planBoard']) {
    assert.equal((registry.match(new RegExp(`^\\s*${key}:`, 'gm')) ?? []).length, 0,
      `${key} must not be assigned in themeRegistry.ts`);
    const layout = fs.readFileSync(
      path.join(__dirname, '../src/renderer/src/scene/office/officeLayout.ts'), 'utf8');
    assert.match(layout, new RegExp(`${key}: \\{ x: \\d+, y: \\d+ \\}`));
  }
});

test('a bundle that never declared the live anchors does not get given them', () => {
  const { validateManifestShape } = loadTs('src/renderer/src/scene/office/themeBundle.ts');
  const fixture = () => JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'theme-bundle-valid', 'theme.json'), 'utf8'));
  const older = validateManifestShape(fixture());
  assert.ok(older.ok, JSON.stringify(older.errors));
  // Every other anchor added since bundles started shipping is DEFAULTED here
  // (worldClock, askBoard, coffeeSteam, the three board stands). These two are
  // the exception, deliberately: there is no sane position to invent for a
  // wall display on a map that has no wall display.
  assert.ok(older.manifest.anchors.worldClock, 'worldClock is still defaulted');
  assert.equal(older.manifest.anchors.opsScreen, undefined);
  assert.equal(older.manifest.anchors.planBoard, undefined);
  // A malformed value is dropped rather than half-honoured.
  const junk = fixture();
  junk.anchors.opsScreen = { x: 5 };
  junk.anchors.planBoard = { x: 36, y: 1 };
  const fixed = validateManifestShape(junk);
  assert.ok(fixed.ok, JSON.stringify(fixed.errors));
  assert.equal(fixed.manifest.anchors.opsScreen, undefined);
  assert.deepEqual(fixed.manifest.anchors.planBoard, { x: 36, y: 1 });
});

test('rgbFromHex converts the theme note colours the cork boards already use', () => {
  assert.deepEqual(rgbFromHex(0xf2df8a), [0xf2, 0xdf, 0x8a]);
  assert.deepEqual(rgbFromHex(0x000000), [0, 0, 0]);
  assert.deepEqual(rgbFromHex(0xffffff), [255, 255, 255]);
});
