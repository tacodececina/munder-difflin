'use strict';

// VISITOR MODE — the screen-redaction policy (src/renderer/src/store/visitorMode.ts).
//
// The property under test is one-directional and blunt: the flag must NEVER be
// able to fail open. Every path that is not an explicit `true` has to read as
// "off" for the activity helpers and, crucially, the reverse must hold for the
// seal — an undefined/garbage flag must not seal the app either, because a
// privacy screen that latches on for no reason is a bug the operator cannot
// diagnose while a guest watches.
//
// These tests also pin the surface LIST, which is the contract the components
// import by name: a renamed surface has to break here, loudly, rather than
// silently stop sealing a panel that still calls `isSealed('threads', …)`.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  VISITOR_SURFACES,
  isSealed,
  visitorSafeActivity,
  visitorSafeProject
} = loadTs('src/renderer/src/store/visitorMode.ts');

// ─── the surface list is the contract ───────────────────────────────────────

test('every surface the components ask for exists in the policy', () => {
  // Each name here is used verbatim at a call site; see the grep in the module
  // header. Dropping one silently un-seals that panel.
  for (const name of [
    'terminal', 'threads', 'traces', 'git', 'ide',
    'memory', 'commandCenter', 'taskDetail', 'activity'
  ]) {
    assert.ok(VISITOR_SURFACES.includes(name), `missing surface: ${name}`);
  }
});

test('the surface list has no duplicates', () => {
  assert.equal(new Set(VISITOR_SURFACES).size, VISITOR_SURFACES.length);
});

// ─── the seal ───────────────────────────────────────────────────────────────

test('off means nothing is sealed', () => {
  for (const surface of VISITOR_SURFACES) {
    assert.equal(isSealed(surface, false), false, surface);
  }
});

test('on seals every known surface', () => {
  for (const surface of VISITOR_SURFACES) {
    assert.equal(isSealed(surface, true), true, surface);
  }
});

test('an absent flag reads as off, never as sealed', () => {
  // The failure this guards: a config file written before the field existed, or
  // a partial object over IPC. Sealing on `undefined` would blank the app for a
  // user who never asked for visitor mode and has no idea what to turn off.
  assert.equal(isSealed('terminal', undefined), false);
  assert.equal(isSealed('terminal', null), false);
});

test('only a real boolean true arms the seal', () => {
  // Truthy-but-not-true must NOT arm it either: the store mirror is typed
  // boolean and the config read is `=== true`, so anything else reaching here
  // means something upstream is wrong, and guessing is the wrong response.
  for (const truthy of [1, 'true', 'on', {}, []]) {
    assert.equal(isSealed('terminal', truthy), false, String(truthy));
  }
});

test('an unknown surface is never sealed, even when the mode is on', () => {
  // A typo'd surface name at a call site should render the panel, not a
  // permanent placeholder nobody can explain.
  assert.equal(isSealed('not-a-surface', true), false);
});

// ─── the activity text ──────────────────────────────────────────────────────

test('off, the real activity passes through untouched', () => {
  assert.equal(visitorSafeActivity('edit src/main/config.ts', 'working', false),
    'edit src/main/config.ts');
});

test('on, the real activity never appears in the output', () => {
  const secret = 'bash aws s3 cp s3://acme-internal/prod.env .';
  const out = visitorSafeActivity(secret, 'working', true);
  assert.equal(out, 'working');
  assert.ok(!out.includes('acme'));
  assert.ok(!out.includes('s3'));
});

test('on, an empty generic yields an empty bubble rather than the real text', () => {
  // The scene renders '' as an animated ellipsis, so this degrades to "thinking"
  // — which is a fine fallback and, more to the point, still not a leak.
  assert.equal(visitorSafeActivity('edit secrets.env', '', true), '');
});

test('off with no activity is the empty string, not undefined', () => {
  // The bubble API takes a string; `undefined` would render as "undefined".
  assert.equal(visitorSafeActivity(undefined, 'working', false), '');
  assert.equal(visitorSafeActivity('', 'working', false), '');
});

test('an absent flag leaves the activity alone', () => {
  assert.equal(visitorSafeActivity('edit App.tsx', 'working', undefined), 'edit App.tsx');
});

// ─── the project name ───────────────────────────────────────────────────────

test('off, the project name passes through untouched', () => {
  assert.equal(visitorSafeProject('acme-billing', 'working', false), 'acme-billing');
});

test('on, the project name is replaced', () => {
  // A repo name is a small leak but a reliable one — it names the client or the
  // unshipped thing, which is exactly what a guest should not walk away with.
  assert.equal(visitorSafeProject('acme-billing', 'working', true), 'working');
});

test('off with no project is the empty string', () => {
  assert.equal(visitorSafeProject(undefined, 'working', false), '');
});

// ─── purity ─────────────────────────────────────────────────────────────────

test('the helpers are pure — same inputs, same answer, no state carried over', () => {
  const first = visitorSafeActivity('edit App.tsx', 'working', true);
  // Interleave an "off" call: a helper that cached the flag would now be wrong.
  visitorSafeActivity('edit App.tsx', 'working', false);
  assert.equal(visitorSafeActivity('edit App.tsx', 'working', true), first);
});

test('the exported surface list cannot be mutated into un-sealing a panel', () => {
  // Frozen or not, the SEALED set is built once at module load from a copy — so
  // even a caller that mangles the exported array cannot change the decision.
  try { VISITOR_SURFACES.length = 0; } catch { /* frozen: also fine */ }
  assert.equal(isSealed('terminal', true), true);
});
