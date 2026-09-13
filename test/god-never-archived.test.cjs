'use strict';

/**
 * "God is never archived" — the invariant, in all three places that archive.
 *
 * `archiveOrphanedAgents` in main has always documented and obeyed it. The other
 * two archivers did not: `teardownPty` (main) flipped the flag on ANY pty death,
 * and the renderer's `archiveAgent` did the same for the floor card. Either one
 * firing was permanent damage, because the archived list is PERSISTED — a god
 * whose boot spawn crashed (or lost a race with itself) went into the archived
 * list, stayed there across every restart, and left the floor with no
 * orchestrator and no UI path back. He auto-respawns; there was never anything
 * to archive.
 *
 * Coverage split, because the two halves are not equally reachable:
 *
 *  - the RENDERER half runs for real. store.ts is pixi/React-free and loads
 *    under plain node, so these tests call the actual `archiveAgent` action and
 *    read the actual persisted slice back out of localStorage.
 *  - the MAIN half is asserted against source text. index.ts imports electron
 *    and cannot load under node (the same reason telemetry-message-count.test.cjs
 *    and others check main's wiring this way), and `teardownPty` is a private
 *    function inside that module.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A localStorage + window stand-in, installed BEFORE store.ts is loaded: the
// store reads its persisted slices at module load and writes them back inside
// every `set()`. Without this the writes are swallowed by store.ts's own
// try/catch and the "did it persist?" half of the bug is unobservable.
const mem = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); }
  },
  addEventListener: () => {}
};

const loadTs = require('./load-ts.cjs');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const LS_ARCHIVED = 'cth.archivedAgents';
const persistedArchived = () => JSON.parse(mem.get(LS_ARCHIVED) ?? '[]');

function agent(over) {
  return {
    id: 'w1', name: 'Toby', character: 'toby', accent: 'blue', description: '', project: '',
    tmuxTarget: '', cwd: '/tmp', status: 'idle', action: '', progress: 0, ptyId: 'pty-1', ...over
  };
}

/** A floor with god plus one worker, and nothing archived yet. */
function seedFloor(t, over = {}) {
  mem.clear();
  useStore.setState({
    agents: [agent({ id: 'god', name: 'lex one', isGod: true, ...over }), agent()],
    archivedAgents: [],
    selectedId: 'god',
    feeds: { god: [{ agentId: 'god', text: 'hello', ts: 1 }], w1: [] },
    messageQueues: { god: [{ id: 'm1', text: 'ship it', ts: 1 }] },
    fullscreenAgentId: null
  });
  t.after(() => { mem.clear(); });
}

const ids = (list) => list.map((a) => a.id);

// ── the renderer half: the real action ───────────────────────────────────────

test('archiving god is a no-op — he stays on the floor', (t) => {
  seedFloor(t);
  useStore.getState().archiveAgent('god');

  const s = useStore.getState();
  assert.deepEqual(ids(s.agents), ['god', 'w1'], 'god was removed from the floor');
  assert.deepEqual(ids(s.archivedAgents), [], 'god landed in the archived list');
  assert.equal(s.agents.find((a) => a.id === 'god').archived, undefined,
    'god must not even be FLAGGED archived');
});

test('nothing about god is persisted as archived — that is what made it permanent', (t) => {
  seedFloor(t);
  useStore.getState().archiveAgent('god');

  assert.deepEqual(ids(persistedArchived()), [],
    'a persisted archived god survives every restart with no way back');
});

test('a crash loop cannot accumulate archived copies of god', (t) => {
  seedFloor(t);
  // Each pty death calls this. The boot-crash case fires it repeatedly.
  for (let i = 0; i < 10; i++) useStore.getState().archiveAgent('god');

  const s = useStore.getState();
  assert.deepEqual(ids(s.agents), ['god', 'w1']);
  assert.deepEqual(ids(s.archivedAgents), []);
  assert.deepEqual(ids(persistedArchived()), []);
});

test('god keeps his selection, feed and queue — nothing is torn down', (t) => {
  seedFloor(t);
  const before = useStore.getState();
  useStore.getState().archiveAgent('god');
  const after = useStore.getState();

  assert.equal(after.selectedId, 'god', 'selection jumped away from god');
  assert.deepEqual(after.feeds.god, before.feeds.god, 'god\'s feed was dropped');
  assert.deepEqual(after.messageQueues.god, before.messageQueues.god,
    'god\'s queued messages were dropped — they are still deliverable, he respawns');
});

test('the guard reads isGod, not the id "god" — a renamed/re-ided god is still god', (t) => {
  // The god id is not a constant everywhere (registry.godId can be any id);
  // keying the exception off the literal string would miss those.
  seedFloor(t);
  useStore.setState({
    agents: [agent({ id: 'michael-9f2x', name: 'lex one', isGod: true }), agent()],
    archivedAgents: [],
    selectedId: 'michael-9f2x'
  });
  useStore.getState().archiveAgent('michael-9f2x');

  assert.deepEqual(ids(useStore.getState().agents), ['michael-9f2x', 'w1']);
  assert.deepEqual(ids(useStore.getState().archivedAgents), []);
});

// ── scope: closing a NORMAL terminal must still archive ──────────────────────

test('a normal agent is still archived, retained and persisted', (t) => {
  seedFloor(t);
  useStore.getState().archiveAgent('w1');

  const s = useStore.getState();
  assert.deepEqual(ids(s.agents), ['god'], 'the worker stayed on the floor');
  assert.deepEqual(ids(s.archivedAgents), ['w1']);
  assert.equal(s.archivedAgents[0].archived, true);
  assert.equal(s.archivedAgents[0].ptyId, undefined, 'the dead pty must be cleared');
  assert.deepEqual(ids(persistedArchived()), ['w1'], 'the archive must survive a restart');
});

test('an unknown id is still a no-op, distinct from the god case', (t) => {
  seedFloor(t);
  const before = useStore.getState().agents;
  useStore.getState().archiveAgent('nobody');
  assert.equal(useStore.getState().agents, before, 'state identity changed for a no-op');
});

// ── the main half: source-text wiring (index.ts cannot load under node) ──────

const main = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');

/** The text of one top-level `function name(...)` body, brace-matched. */
function functionBody(src, signature) {
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

test('every setArchived in teardownPty is guarded by the god id', () => {
  const body = functionBody(main, 'function teardownPty(id: string): void');
  const lines = body.split('\n');
  const calls = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes('setArchived('));

  assert.ok(calls.length >= 1, 'teardownPty no longer archives at all — check this test, not the code');
  for (const { line, i } of calls) {
    // The guard may sit on the call line or just above it (a hoisted godId
    // const, an early return); either spelling is fine, its ABSENCE is the bug.
    const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    assert.match(window, /godId/,
      `unguarded setArchived in teardownPty — a dead god pty archives him:\n${line.trim()}`);
  }
});

test('archiveOrphanedAgents still skips god, where the invariant started', () => {
  const body = functionBody(main, 'function archiveOrphanedAgents(): void');
  assert.match(body, /if \(id === reg\.godId\) continue;/);
});

test('the renderer is told to archive workers, never god', () => {
  // teardownPty's floor-card broadcast is worker-only; if it ever widened to all
  // agents, the renderer's own guard is the last line of defence — so both must
  // hold, and this pins the main-side half.
  const body = functionBody(main, 'function teardownPty(id: string): void');
  assert.match(body, /if \(wasWorker\) \{[\s\S]*?hive:agentArchived/,
    'the agentArchived broadcast is no longer worker-scoped');
});

test('the renderer action refuses god by flag, in the shipped source', () => {
  // Belt and braces for the behavioural tests above: pins the guard itself, so a
  // refactor that keeps the tests green by some other route still has to be a
  // deliberate act rather than an accident.
  const store = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/renderer/src/store/store.ts'), 'utf8');
  const archive = store.slice(store.indexOf('  archiveAgent: (id) =>'));
  assert.match(archive.slice(0, archive.indexOf('removeArchivedAgent')),
    /if \(target\.isGod\) return s;/);
});
