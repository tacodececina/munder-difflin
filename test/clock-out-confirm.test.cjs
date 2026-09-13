'use strict';

// The office wall clock asks before it ends the day.
//
// The incident: a user pressed the pixel-art clock on the office wall and the
// app vanished. They reported it as a crash. It was not — the prop's
// `pointertap` called `window.close()` directly, which runs the real close
// flow: nine agents stopped, session over, from one click on something that
// looked like wall decoration. Phase 1 then hung a SECOND clock on the same
// wall (scene/office/WorldClock.ts, a decorative CN/MX panel), so the floor
// now shows two clocks and only one of them ends the session.
//
// These tests pin the three parts of the fix that can regress silently:
// the confirmation exists, CANCELLING IT CLOSES NOTHING, and the clock that
// kills the session no longer reaches window.close() on its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/** Source with comments removed: these modules explain at length what they
 *  refuse to do, and naming an API in prose must not read as calling it. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const locale = (code) =>
  JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));

const {
  openClockOut, liveAgentCount, clockOutCountKey, cancelClockOut, confirmClockOut
} = loadTs('src/renderer/src/store/clockOut.ts');

/** A recorder for the two things the prompt can do to the outside world. */
function spyActions() {
  const calls = [];
  return {
    calls,
    dismiss: () => calls.push('dismiss'),
    close: () => calls.push('close')
  };
}

// --- the invariant: cancelling is inert ------------------------------------

test('cancelling the confirmation NEVER closes anything', () => {
  const a = spyActions();
  cancelClockOut(a);
  assert.ok(!a.calls.includes('close'),
    'cancel reached window.close() — this is the original bug, back again');
  assert.deepEqual(a.calls, ['dismiss'],
    'cancel must do exactly one thing: take the prompt down');
});

test('cancelling leaves nothing behind for a second click to trip over', () => {
  // Two cancels in a row are two clean dismissals, not an escalating state
  // machine that eventually closes on its own.
  const a = spyActions();
  cancelClockOut(a);
  cancelClockOut(a);
  assert.deepEqual(a.calls, ['dismiss', 'dismiss']);
});

test('only confirming closes, and the prompt comes down first', () => {
  const a = spyActions();
  confirmClockOut(a);
  assert.deepEqual(a.calls, ['dismiss', 'close'],
    'the dialog must be dismissed before the close, or it outlives the window it belongs to');
});

// --- the confirmation is raised, not the close -----------------------------

test('the office clock ASKS — nothing in the scene can close the app', () => {
  const src = strip(read('src/renderer/src/scene/office/OfficeFloor.tsx'));
  assert.ok(!/window\.close\s*\(/.test(src),
    'the office floor calls window.close() again — the clock must only raise a confirmation');
  assert.match(src, /requestClockOut\(\)/,
    'the clock no longer raises the clock-out confirmation at all');
});

test('the store carries the pending confirmation, and can drop it', () => {
  const src = strip(read('src/renderer/src/store/store.ts'));
  assert.match(src, /clockOutRequest: null/, 'the store never starts with the prompt down');
  assert.match(src, /requestClockOut:/);
  assert.match(src, /dismissClockOut: \(\) => set\(\{ clockOutRequest: null \}\)/,
    'dismissing must be a pure renderer-local reset — no IPC, no trace');
});

test('a second click after a cancel is a NEW request, not a stale one', () => {
  // `seq` is what makes the modal re-open: without it the store would already
  // hold an identical object and React would see no change.
  const first = openClockOut(null);
  const second = openClockOut(first);
  assert.notDeepEqual(first, second);
  assert.equal(second.seq, first.seq + 1);
  assert.equal(first.seq, 1, 'openClockOut must not mutate the previous request');
});

// --- what the confirmation says --------------------------------------------

test('the count is the agents actually running, not the roster', () => {
  const roster = [
    { id: 'god', ptyId: 'p1' },
    { id: 'a', ptyId: 'p2' },
    { id: 'dead' },                 // terminal already gone
    { id: 'archived', ptyId: '' }   // cleared on archive
  ];
  assert.equal(liveAgentCount(roster), 2,
    'a confirmation that overstates the damage is as untrustworthy as one that hides it');
  assert.equal(liveAgentCount([]), 0);
});

test('the sentence matches the count, zero included', () => {
  assert.equal(clockOutCountKey(0), 'office.clockOut.agentsNone');
  assert.equal(clockOutCountKey(1), 'office.clockOut.agentsOne');
  assert.equal(clockOutCountKey(9), 'office.clockOut.agentsMany');
  // Defensive: a negative count is nonsense, and must not read as "1 agent".
  assert.equal(clockOutCountKey(-1), 'office.clockOut.agentsNone');
});

test('the modal states the real count and cannot close on its own', () => {
  const src = strip(read('src/renderer/src/components/ClockOutConfirmModal.tsx'));
  assert.match(src, /clockOutCountKey\(agentCount\)/,
    'the dialog stopped naming how many agents it stops');
  assert.ok(!/window\.close/.test(src),
    'the dialog must ask for a close through its props, never perform one');
  // Same dialog language as the quit warning it leads into — PixelModal frame,
  // PixelButton row — not a second, invented modal style.
  for (const part of ['PixelModal', 'PixelButton', "from './Icon'"]) {
    assert.ok(src.includes(part), `the confirmation drifted off the quit-dialog pattern: ${part}`);
  }
});

test('App wires cancel to the inert path and confirm to the closing one', () => {
  const src = strip(read('src/renderer/src/App.tsx'));
  assert.match(src, /\{clockOutRequest && \(/, 'the confirmation is never rendered');
  assert.match(src, /onCancel=\{\(\) => cancelClockOut\(/,
    'cancel must run through cancelClockOut, the path proven inert above');
  assert.match(src, /onConfirm=\{\(\) => confirmClockOut\(/);
});

// --- telling the two clocks apart ------------------------------------------

test('the decorative world clock stays untouchable', () => {
  const src = strip(read('src/renderer/src/scene/office/WorldClock.ts'));
  assert.match(src, /eventMode = 'none'/,
    'the decorative clock became clickable — two clickable clocks is the confusion, doubled');
  assert.ok(!/close|quit/i.test(src), 'the decorative clock must reach nothing');
});

test('the closing clock is drawn as an action, and announces itself on hover', () => {
  const src = strip(read('src/renderer/src/scene/office/OfficeFloor.tsx'));
  // Before the fix this prop drew NOTHING: an invisible hit box over the wall
  // tiles. Decoration is exactly what it looked like.
  assert.match(src, /const drawClock = /, 'the closing clock is invisible again');
  assert.match(src, /clockG\.on\('pointerover'/,
    'the clock lost its hover announcement — the click is unannounced again');
  assert.match(src, /clockG\.on\('pointerout'/, 'the hover label never goes away');
  assert.match(src, /office\.clockOut\.hint/, 'the hover label lost its text');
});

// --- every locale can say all of it ----------------------------------------

test('the confirmation and the hover label exist in all four locales', () => {
  const KEYS = ['title', 'agentsNone', 'agentsOne', 'agentsMany',
                'body', 'tip', 'cancel', 'confirm', 'hint'];
  const seen = new Map();
  for (const code of ['en', 'es', 'ar', 'zh-CN']) {
    const block = locale(code).office?.clockOut;
    assert.ok(block, `${code} has no office.clockOut block`);
    for (const k of KEYS) {
      assert.equal(typeof block[k], 'string', `${code} is missing office.clockOut.${k}`);
      assert.ok(block[k].trim().length > 0, `${code}'s office.clockOut.${k} is empty`);
    }
    assert.match(block.agentsMany, /\{\{count\}\}/,
      `${code} dropped the count out of the only sentence that carries it`);
    seen.set(code, block);
  }
  // A copied English string looks translated and is not (arabic-ui.test.cjs
  // makes the same argument for the whole tree).
  for (const code of ['es', 'ar', 'zh-CN']) {
    for (const k of KEYS) {
      assert.notEqual(seen.get(code)[k], seen.get('en')[k],
        `${code}'s office.clockOut.${k} is still the English source`);
    }
  }
});

test('the Spanish is Latin American, not peninsular', () => {
  // House rule for this locale: no vosotros, no "vale"/"ordenador".
  const block = locale('es').office.clockOut;
  const text = Object.values(block).join(' ').toLowerCase();
  for (const word of ['vosotros', 'ordenador', 'vale,', 'cerráis', 'queréis']) {
    assert.ok(!text.includes(word), `peninsular Spanish leaked in: ${word}`);
  }
});
