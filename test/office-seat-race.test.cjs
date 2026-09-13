'use strict';

/**
 * One agent, one desk — the double-spawn race.
 *
 * `addCharacter()` claims a seat SYNCHRONOUSLY (`claimSeat` mutates the shared
 * `seatClaims` set) but only lands in `runtimes` after `await
 * theme.cast.getFrames(...)`. `syncAgents()` decides whether to build an agent
 * by looking at `runtimes` alone, so any store update landing inside that await
 * window saw nothing, started a SECOND build for the same agent, and burned a
 * second desk. With nine agents booting at once — exactly what a restored team
 * does — the named desks ran out and whoever came last was seated in the
 * boardroom overflow chairs.
 *
 * WHAT THIS FILE COVERS, HONESTLY: the guard is a `spawning` Set living inside
 * OfficeFloor's ~2000-line init effect, alongside `runtimes` and `seatClaims`.
 * Nothing in that scope is exported or reachable: the effect needs a live Pixi
 * Application with a WebGL context, a loaded theme atlas, and a mounted React
 * tree. Extracting the seat/runtime bookkeeping into a testable module is a real
 * refactor of the hottest file in the renderer, not a test-time change, so it is
 * deliberately not done here.
 *
 * So these are SOURCE assertions, not behavioural ones. They fail if the fix is
 * reverted or quietly weakened, which is what they are for; they do not prove
 * the floor seats nine agents correctly — only a running floor does that.
 * (test/office-gl-recovery.test.cjs is the counter-example: that logic WAS
 * extracted to glRecovery.ts and is exercised for real.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');

/** The brace-matched body of an arrow/function declaration, from its signature. */
function bodyAfter(signature) {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found — was it renamed?`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

const addCharacter = bodyAfter('const addCharacter = async (agent: Agent) => ');
const syncAgents = bodyAfter('const syncAgents = () => ');

test('the in-flight set lives in the same scope as runtimes and seatClaims', () => {
  // It has to outlive a single syncAgents() call and be shared with
  // addCharacter — a set declared inside either one would guard nothing.
  const scope = src.slice(src.indexOf('const runtimes = new Map<string, Runtime>();'));
  const decls = scope.slice(0, scope.indexOf('const addCharacter'));
  assert.match(decls, /const seatClaims = new Set<number>\(\);/);
  assert.match(decls, /const spawning = new Set<string>\(\);/,
    'the in-flight set is gone — syncAgents has nothing to check');
});

test('syncAgents will not start a build for an agent already being built', () => {
  // The whole bug in one line: `if (!rt)` alone is not enough, because `rt` does
  // not exist yet for an agent that is mid-await.
  assert.match(syncAgents, /if \(!rt\) \{ if \(!spawning\.has\(agent\.id\)\) void addCharacter\(agent\); \}/,
    'syncAgents builds on !runtimes alone again — the double-spawn is back');
  // …and it still applies state to agents that ARE built. A guard that also
  // skipped applyState would freeze every avatar.
  assert.match(syncAgents, /else applyState\(agent, rt\);/);
});

test('the id is marked before anything can yield, and cleared in a finally', () => {
  const firstStatement = addCharacter.slice(0, addCharacter.indexOf('\n', addCharacter.indexOf('spawning')));
  assert.match(firstStatement, /^\{\s*spawning\.add\(agent\.id\);/,
    'marking the id after an await leaves the same window open');

  // `finally`, not a trailing delete: addCharacter has an early `return` for a
  // torn-down scene and another for an agent removed mid-load, and getFrames can
  // reject. Any of those leaking the id would be WORSE than the original bug —
  // syncAgents would skip that agent forever and it would never appear at all.
  assert.match(addCharacter, /\}\s*finally\s*\{\s*spawning\.delete\(agent\.id\);\s*\}/,
    'the in-flight mark is not released on every exit path');
  assert.equal((addCharacter.match(/spawning\.delete\(/g) ?? []).length, 1,
    'more than one release point — the finally should be the only one');
});

test('a build abandoned mid-flight gives its desk back', () => {
  // The other half of "one agent, one desk": bailing after claimSeat without
  // releasing would leak a named desk on every removed-while-loading agent.
  assert.match(addCharacter,
    /if \(!useStore\.getState\(\)\.agents\.some\(\(a\) => a\.id === agent\.id\)\) \{\s*if \(seatIndex != null\) seatClaims\.delete\(seatIndex\);\s*return;\s*\}/,
    'an abandoned spawn keeps its desk claimed');
});

test('the hazard the guard exists for is still present', () => {
  // A canary, not a rule: the guard is only needed because the seat is claimed
  // BEFORE an await and the runtime is registered AFTER it. If this ordering
  // ever changes, revisit the guard rather than deleting this assertion.
  const claim = addCharacter.indexOf('const seatIndex = claimSeat(agent);');
  const await_ = addCharacter.indexOf('await theme.cast.getFrames(');
  const register = addCharacter.indexOf('runtimes.set(agent.id, rt);');
  assert.ok(claim > -1 && await_ > -1 && register > -1, 'addCharacter no longer has the shape described');
  assert.ok(claim < await_, 'seat claimed after the await — re-read this test');
  assert.ok(await_ < register, 'runtime registered before the await — re-read this test');
});

test('only the floor teardown paths release a seat, and they own a runtime', () => {
  // Sanity on the seat ledger as a whole: every other seatClaims.delete sits in
  // removeCharacter-style code that has a live runtime to read `seatIndex` from,
  // so no path can free someone else's desk.
  const releases = [...src.matchAll(/seatClaims\.delete\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(releases.sort(), ['rt.seatIndex', 'seatIndex']);
});
