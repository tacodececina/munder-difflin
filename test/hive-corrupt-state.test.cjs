'use strict';

/**
 * A hive state file that cannot be read must NEVER degrade in silence.
 *
 * THE INCIDENT (production, real): an external tool rewrote `hive/registry.json`
 * with a UTF-8 BOM in front of otherwise perfect JSON. `JSON.parse` rejects a
 * BOM, and the old `readJson(path, default)` folded that rejection into its
 * `{ godId: null, agents: {} }` default. Everything downstream then believed the
 * hive was empty: the orchestrator lost its custom name and fell back to the
 * default, the next fleet snapshot was written with zero agents, and the app
 * kept running as if nothing had happened. Hours later the next registry write
 * had replaced the (still recoverable) corrupt file with an empty one, and the
 * real state was gone for good.
 *
 * Three properties, one per failure leg:
 *   (a) TOLERATE — valid JSON behind a BOM reads as valid JSON.
 *   (b) NEVER CLOBBER — a file that is PRESENT but unparseable is never written
 *       over; the last good value is served instead of a fresh default. A file
 *       that is ABSENT is the normal first-run shape and still yields the
 *       default. That distinction is the heart of this suite.
 *   (c) ANNOUNCE — the failure lands in log.jsonl and on the existing
 *       `hive:degraded` channel (which main turns into a native toast).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, stripBom } = loadTs('src/main/hive.ts');
const { RosterStore, rosterPath } = loadTs('src/main/roster.ts');

const BOM = '﻿';

/** A hive home with a registry that names a custom god — the exact state the
 *  incident destroyed. Returns helpers bound to that home. */
function makeHive(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-corrupt-state-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'hive');
  fs.mkdirSync(root, { recursive: true });

  const emitted = [];
  const hive = options.noEmit
    ? new HiveManager(() => home)
    : new HiveManager(() => home, (channel, payload) => { emitted.push({ channel, payload }); });

  const file = (name) => path.join(root, name);
  const write = (name, text) => fs.writeFileSync(file(name), text, 'utf8');
  const read = (name) => fs.readFileSync(file(name), 'utf8');
  const log = () => {
    const p = file('log.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  return { home, root, hive, emitted, file, write, read, log };
}

const REGISTRY = {
  godId: 'michael',
  agents: {
    michael: { id: 'michael', name: 'Rómulo', role: 'orchestrator', isGod: true },
    pam: { id: 'pam', name: 'Pam', role: 'design' }
  }
};

// ── (a) TOLERATE THE BOM ─────────────────────────────────────────────────────

test('stripBom removes a leading U+FEFF and leaves everything else alone', () => {
  assert.equal(stripBom(`${BOM}{"a":1}`), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}', 'a clean document is untouched');
  assert.equal(stripBom(''), '', 'an empty string does not throw');
  assert.equal(stripBom(`{"a":"${BOM}"}`), `{"a":"${BOM}"}`, 'only a LEADING BOM is a BOM');
});

test('a BOM-prefixed registry.json is read as the valid JSON it is', (t) => {
  const { hive, write } = makeHive(t);
  write('registry.json', BOM + JSON.stringify(REGISTRY, null, 2));

  const reg = hive.registry();
  assert.equal(reg.godId, 'michael', 'the god must not be lost to three bytes');
  assert.equal(reg.agents.michael.name, 'Rómulo', 'the custom orchestrator name survives');
  assert.deepEqual(Object.keys(reg.agents).sort(), ['michael', 'pam']);
});

test('a BOM-prefixed tasks.json is read as the valid board it is', (t) => {
  const { hive, write } = makeHive(t);
  const board = { tasks: [{ id: 'a', title: 'Ship it', status: 'doing' }] };
  write('tasks.json', BOM + JSON.stringify(board, null, 2));

  assert.deepEqual(hive.tasks(), board);
  assert.equal(hive.corruptStateFiles().length, 0, 'a BOM is not corruption');
});

test('a BOM-prefixed fleet.json still produces the live roster line', (t) => {
  const { hive, write } = makeHive(t);
  write('fleet.json', BOM + JSON.stringify({ ts: Date.now(), agents: [{ id: 'pam', name: 'Pam', role: 'design' }] }));

  const line = hive.rosterContext();
  assert.ok(line && line.includes('pam'), 'god must still be handed the floor it has');
});

// ── (b) AN ABSENT FILE IS NORMAL ─────────────────────────────────────────────

test('a hive with no files at all still boots on the defaults', (t) => {
  const { hive, root } = makeHive(t);
  fs.rmSync(root, { recursive: true, force: true }); // not even the directory

  assert.deepEqual(hive.registry(), { godId: null, agents: {} });
  assert.deepEqual(hive.tasks(), { tasks: [] });
  assert.equal(hive.corruptStateFiles().length, 0, 'missing is not corrupt — nothing to report');
});

test('first-run bootstrap writes the skeleton and is not blocked', (t) => {
  const { hive, file } = makeHive(t);
  hive.ensureHive();

  assert.deepEqual(JSON.parse(fs.readFileSync(file('registry.json'), 'utf8')), { godId: null, agents: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(file('tasks.json'), 'utf8')), { tasks: [] });
  assert.equal(hive.corruptStateFiles().length, 0);
});

test('an empty (0-byte) file yields the default and stays writable — a crash mid-write must self-heal', (t) => {
  const { hive, write, file } = makeHive(t);
  write('tasks.json', '');

  assert.deepEqual(hive.tasks(), { tasks: [] });
  hive.writeTasks([{ id: 'fresh', title: 'Fresh', status: 'todo' }]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file('tasks.json'), 'utf8')).tasks.map((x) => x.id),
    ['fresh'],
    'refusing here would brick the hive forever over a file that held nothing'
  );
});

// ── (b) A PRESENT-BUT-UNREADABLE FILE IS NEVER CLOBBERED ─────────────────────

test('a corrupt registry.json is never overwritten by a default', (t) => {
  const { hive, write, read } = makeHive(t);
  const corrupt = '{ "godId": "michael", "agents": { TRUNCATED';
  write('registry.json', corrupt);

  hive.registry();
  // Every registry mutation path: role, archive, hold, rename, session.
  hive.patchAgentRole('michael', 'orchestrator');
  hive.setArchived('pam', true);
  hive.setAgentHold('michael', true);
  hive.renameAgent('michael', 'Somebody Else');
  hive.recordSession('michael', 'session-xyz');
  hive.ensureHive(); // the bootstrap path must not "repair" it either

  assert.equal(read('registry.json'), corrupt, 'the corrupt bytes must survive verbatim for repair');
});

test('a corrupt tasks.json is never flattened into an empty board', (t) => {
  const { hive, write, read } = makeHive(t);
  const corrupt = '{ "tasks": [ {"id":"a","title":"Ship it"';
  write('tasks.json', corrupt);

  hive.tasks();
  hive.writeTasks([{ id: 'b', title: 'Something else', status: 'todo' }]);
  hive.addTask({ id: 'c', title: 'And another', status: 'todo' });

  assert.equal(read('tasks.json'), corrupt, 'a corrupt board must not become an empty board');
});

test('the last good value is served while the file is unreadable, not a lying default', (t) => {
  const { hive, write } = makeHive(t);
  write('registry.json', JSON.stringify(REGISTRY));
  assert.equal(hive.registry().agents.michael.name, 'Rómulo');

  // Now an external tool mangles it under us.
  write('registry.json', 'not json at all');

  const reg = hive.registry();
  assert.equal(reg.godId, 'michael', 'the god keeps its identity instead of resetting to the default');
  assert.equal(reg.agents.michael.name, 'Rómulo');
});

test('writes resume once the file parses again', (t) => {
  const { hive, write, read } = makeHive(t);
  write('registry.json', '{ broken');
  hive.registry();
  hive.recordSession('michael', 's1');
  assert.equal(read('registry.json'), '{ broken', 'blocked while broken');

  write('registry.json', JSON.stringify(REGISTRY));
  hive.registry(); // the repaired file is seen
  assert.equal(hive.corruptStateFiles().length, 0, 'the path is un-poisoned');

  hive.recordSession('michael', 's2');
  assert.equal(JSON.parse(read('registry.json')).agents.michael.sessionId, 's2');
});

test('a mutation that could not be saved reports failure instead of claiming success', (t) => {
  const { hive, write } = makeHive(t);
  write('registry.json', JSON.stringify(REGISTRY));
  hive.registry();
  write('registry.json', '{ broken');
  hive.registry(); // poison the path

  assert.equal(hive.renameAgent('michael', 'Nope').ok, false);
  assert.equal(hive.patchAgentRole('michael', 'nope').ok, false);
  assert.equal(hive.setAgentHold('michael', true).ok, false);
});

test('fleet.json is a regenerable cache — a corrupt one is replaced, not protected', (t) => {
  const { hive, write, read } = makeHive(t);
  write('fleet.json', '{ not json');

  // The 8s snapshot rebuilds this file wholesale from the registry (the record),
  // so overwriting it loses nothing. Protecting it would freeze god's roster.
  hive.writeFleetSnapshot({ ts: 1, agents: [{ id: 'pam' }] });
  assert.deepEqual(JSON.parse(read('fleet.json')).agents, [{ id: 'pam' }]);
});

// ── (c) THE FAILURE IS ANNOUNCED ─────────────────────────────────────────────

test('corruption is written to log.jsonl with the file and the parse error', (t) => {
  const { hive, write, log } = makeHive(t);
  write('registry.json', '{ "agents": ');
  hive.registry();

  const entry = log().find((e) => e.kind === 'state-corrupt');
  assert.ok(entry, 'a corrupt state file must leave a trace in the hive log');
  assert.equal(entry.file, 'registry.json');
  assert.ok(typeof entry.error === 'string' && entry.error.length > 0, 'the parse error is recorded');
  assert.ok(typeof entry.ts === 'number');
});

test('a refused write is logged too — a save that did not happen must be visible', (t) => {
  const { hive, write, log } = makeHive(t);
  write('tasks.json', '{ "tasks": [');
  hive.tasks();
  hive.writeTasks([{ id: 'x', title: 'X', status: 'todo' }]);

  assert.ok(log().some((e) => e.kind === 'state-write-refused' && e.file === 'tasks.json'));
  assert.ok(log().some((e) => e.kind === 'tasks-not-written'));
});

test('corruption is pushed out on the existing hive:degraded channel', (t) => {
  const { hive, write, emitted } = makeHive(t);
  write('registry.json', '}{');
  hive.registry();

  const degraded = emitted.filter((e) => e.channel === 'hive:degraded');
  assert.equal(degraded.length, 1, 'exactly one alarm per incident');
  assert.equal(degraded[0].payload.reason, 'state-parse');
  assert.equal(degraded[0].payload.file, 'registry.json');
  assert.ok(degraded[0].payload.message.includes('registry.json'), 'the message names the file to repair');
});

test('the alarm does not repeat on every poll, and re-arms after a recovery', (t) => {
  const { hive, write, emitted } = makeHive(t);
  write('registry.json', '}{');
  for (let i = 0; i < 5; i += 1) hive.registry();
  assert.equal(emitted.filter((e) => e.channel === 'hive:degraded').length, 1,
    'a toast per poll tick is a siren, not a report');

  write('registry.json', JSON.stringify(REGISTRY));
  hive.registry();
  write('registry.json', '}{');
  hive.registry();
  assert.equal(emitted.filter((e) => e.channel === 'hive:degraded').length, 2,
    'a NEW incident after a repair must alarm again');
});

test('a recovery is logged, so the timeline shows when it was fixed', (t) => {
  const { hive, write, log } = makeHive(t);
  write('registry.json', '}{');
  hive.registry();
  write('registry.json', JSON.stringify(REGISTRY));
  hive.registry();

  assert.ok(log().some((e) => e.kind === 'state-recovered' && e.file === 'registry.json'));
});

// ── the task-completion observer shares the policy ───────────────────────────

test('observeTaskCompletions skips an unreadable ledger and poisons it for writers', (t) => {
  const { hive, write, read, log } = makeHive(t);
  write('tasks.json', '{ "tasks": [ {"id":"a","status":"done"');

  assert.deepEqual(hive.observeTaskCompletions(), [], 'a failed read redefines nothing');
  assert.ok(log().some((e) => e.kind === 'state-corrupt' && e.file === 'tasks.json'));

  const before = read('tasks.json');
  hive.writeTasks([{ id: 'z', title: 'Z', status: 'todo' }]);
  assert.equal(read('tasks.json'), before, 'the poll that saw the corruption protects the next write');
});

// ── (c) THE ALARM IS ACTUALLY VISIBLE ON A DEFAULT INSTALL ───────────────────
//
// Emitting on `hive:degraded` only counts if something turns it into pixels.
// Nothing in the renderer or the preload listens to that channel (deliberately —
// main owns it), so the native toast in src/main/index.ts is the ONLY user-facing
// surface. It used to go through `breakerToast`, which returns early unless
// `notifications` is true — and that setting defaults to FALSE (config.ts
// DEFAULTS), so on a default install a corrupt registry.json produced a
// console.error nobody sees in a packaged app and a log.jsonl row nobody is
// shown, while the floor looked perfectly healthy.
//
// index.ts imports electron and cannot load under node, so — as in
// god-never-archived / telemetry-message-count — main's wiring is asserted
// against source text.

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');

/** The body of a top-level `function name(...) { ... }` in main. */
function mainFn(name) {
  const start = MAIN.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} vanished from src/main/index.ts`);
  const open = MAIN.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < MAIN.length; i += 1) {
    if (MAIN[i] === '{') depth += 1;
    else if (MAIN[i] === '}') { depth -= 1; if (depth === 0) return MAIN.slice(open, i + 1); }
  }
  throw new Error(`could not find the end of ${name}`);
}

test('the state-parse alarm does not go out through the notifications-gated toast', () => {
  const handler = MAIN.slice(MAIN.indexOf("if (channel === 'hive:degraded')"));
  const body = handler.slice(0, handler.indexOf('const wc = liveWebContents()'));
  assert.match(body, /alarmToast\('Hive state unreadable'/,
    'the corrupt-state alarm must use the ungated alarm toast');
  assert.doesNotMatch(body, /breakerToast\(/,
    'breakerToast is gated on `notifications`, which is false by default — '
    + 'routing the alarm through it hides a data-loss condition from most users');
});

test('alarmToast ignores the notifications setting, breakerToast still honours it', () => {
  assert.doesNotMatch(mainFn('alarmToast'), /notifications/,
    'a file that stopped being written to is not a courtesy ping');
  assert.match(mainFn('breakerToast'), /notifications/,
    'the lifecycle pings must stay opt-in');
});

test('both toasts still respect visitor mode', () => {
  assert.match(mainFn('showNativeToast'), /visitorMode/,
    'an OS toast paints over the screen the mode exists to keep clean');
  for (const fn of ['alarmToast', 'breakerToast']) {
    assert.match(mainFn(fn), /showNativeToast\(/, `${fn} must go through the shared gate`);
  }
});

// ── every write to unreconstructable state is atomic ─────────────────────────
//
// `writeJson` is a bare writeFileSync: a crash (or a power cut) between the
// truncate and the last byte leaves a half-written file — which is EXACTLY the
// present-but-corrupt file this whole suite protects against, only self-
// inflicted, and with writes then refused until someone repairs it by hand.
// registry.json and tasks.json hold state nobody can reconstruct, so every
// mutation path must go through temp-file + rename.

const HIVE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/main/hive.ts'), 'utf8');

test('registry.json and tasks.json are only ever written atomically', () => {
  const offenders = HIVE_SRC.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /this\.writeJson\(/.test(line) && /registry\.json|tasks\.json|\bpath\b/.test(line))
    // The first-run skeleton in ensureHive creates the files; there is no prior
    // content to lose, and classifyJson treats a half-written one as corrupt and
    // protects it from there on.
    .filter(({ line }) => !line.includes('{ godId: null, agents: {} }') && !line.includes('{ tasks: [] }'));
  assert.deepEqual(offenders, [],
    `these writes must use atomicWriteJson: ${offenders.map((o) => `hive.ts:${o.n}`).join(', ')}`);
});

test('the mutation paths keep reporting a refused write instead of faking success', (t) => {
  // atomicWriteJson returns the same boolean writeJson did, so the "could not be
  // saved" answers above must survive the swap.
  const { hive, write, read } = makeHive(t);
  write('registry.json', JSON.stringify(REGISTRY));
  hive.registry();
  write('registry.json', '{ broken');
  hive.registry();

  assert.equal(hive.patchAgentRole('michael', 'nope').ok, false);
  assert.equal(hive.setAgentHold('michael', true).ok, false);
  assert.equal(hive.renameAgent('michael', 'Nope').ok, false);
  assert.equal(read('registry.json'), '{ broken');
});

test('an atomic write leaves no temp file behind', (t) => {
  const { hive, write, read, root } = makeHive(t);
  write('registry.json', JSON.stringify(REGISTRY));
  // patchAgentRole also rewrites identity.md, which lives in the agent's folder.
  fs.mkdirSync(path.join(root, 'agents', 'pam'), { recursive: true });
  hive.registry();

  assert.equal(hive.renameAgent('pam', 'Pamela').ok, true);
  assert.equal(hive.setAgentHold('pam', true).ok, true);
  assert.equal(hive.patchAgentRole('pam', 'design lead').ok, true);

  const saved = JSON.parse(read('registry.json'));
  assert.equal(saved.agents.pam.name, 'Pamela');
  assert.equal(saved.agents.pam.onHold, true);
  assert.equal(saved.agents.pam.role, 'design lead');
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.tmp-')), [],
    'the rename half of the atomic write must have run');
});

// ── the roster mirror: same class, same rule ─────────────────────────────────

test('a BOM-prefixed roster.json still reads', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-corrupt-roster-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const snap = { version: 1, savedAt: '2026-09-12T00:00:00.000Z', agents: [{ id: 'pam' }], archived: [], restorable: [] };
  fs.writeFileSync(rosterPath(home), BOM + JSON.stringify(snap), 'utf8');

  const store = new RosterStore(() => home);
  assert.deepEqual(store.read().agents, [{ id: 'pam' }]);
});

test('an unreadable roster.json is not flattened by an empty first write', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-corrupt-roster-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const corrupt = '{ "version": 1, "agents": [ {"id":"pam"';
  fs.writeFileSync(rosterPath(home), corrupt, 'utf8');

  const store = new RosterStore(() => home);
  const res = store.write({ version: 1, savedAt: 'x', agents: [], archived: [], restorable: [] });

  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'unreadable-not-overwritten');
  assert.equal(fs.readFileSync(rosterPath(home), 'utf8'), corrupt);
});

test('a REAL roster still repairs an unreadable file — the mirror must not stay stuck', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-corrupt-roster-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(rosterPath(home), '{ "agents": [ broken', 'utf8');

  const store = new RosterStore(() => home);
  const res = store.write({ version: 1, savedAt: 'x', agents: [{ id: 'jim' }], archived: [], restorable: [] });

  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(rosterPath(home), 'utf8')).agents, [{ id: 'jim' }]);
});
