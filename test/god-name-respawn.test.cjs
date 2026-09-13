'use strict';

/**
 * God's NAME survives a respawn.
 *
 * Seen live: a god renamed "lex one" came back as "Michael" after a restart and
 * the custom name was gone for good. The renderer resolves god's name out of
 * THIS registry before spawning him, but that read sits behind a
 * `.catch(() => null)` — so any hiccup (a registry not written yet this run, a
 * slow/failed IPC) silently degrades to the built-in default, and the spawn then
 * writes that default straight back over the real name. One bad read is enough:
 * the overwrite is persisted, so the next boot reads "Michael" legitimately and
 * the original is unrecoverable.
 *
 * The fix is the same protection `role` already gets one line above in
 * `ensureAgent`: a spawn CARRYING THE BARE DEFAULT may not overwrite a name
 * already on record. These tests run the real HiveManager against a temp home,
 * so they exercise the registry write, not a description of it.
 *
 * The scope matters as much as the rule — three of the tests below fail on an
 * over-broad fix ("god's name never changes at a spawn"), which would break
 * every legitimate rename instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { DEFAULT_GOD_NAME } = loadTs('src/shared/godIdentity.ts');

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-god-name-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function registryOf(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8'));
}

function identityOf(home, id) {
  return fs.readFileSync(path.join(home, 'hive', 'agents', id, 'identity.md'), 'utf8');
}

const god = (over = {}) => ({
  id: 'god', name: DEFAULT_GOD_NAME, provider: 'claude', cwd: os.tmpdir(), isGod: true, ...over
});

test('a default-named respawn cannot erase god\'s custom name', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);

  // The user named him once; the registry is the record of that.
  await hive.ensureAgent(god({ name: 'lex one' }));
  assert.equal(registryOf(home).agents.god.name, 'lex one');

  // Restart. The renderer's registry read failed, so it spawns the built-in
  // default — verbatim the shape that used to destroy the name.
  await hive.ensureAgent(god());

  assert.equal(registryOf(home).agents.god.name, 'lex one',
    'the default overwrote a name already on record — the bug');
  assert.equal(registryOf(home).godId, 'god');
});

test('the rescued name is what identity.md tells the agent it is called', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);

  await hive.ensureAgent(god({ name: 'lex one' }));
  await hive.ensureAgent(god());

  // identity.md is rewritten on EVERY spawn from the same `meta` the registry
  // gets. If the guard ran after that write, the registry would look right while
  // the agent introduced itself as Michael for the rest of the session.
  const identity = identityOf(home, 'god');
  assert.ok(identity.includes('lex one'), 'identity.md still calls him the default');
  assert.ok(!identity.includes(DEFAULT_GOD_NAME), `identity.md leaked ${DEFAULT_GOD_NAME}`);
});

test('it holds across repeated failed-read restarts, not just the first', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);

  await hive.ensureAgent(god({ name: 'Savvas' }));
  for (let i = 0; i < 5; i++) await hive.ensureAgent(god());
  assert.equal(registryOf(home).agents.god.name, 'Savvas');
});

test('a rename persisted through renameAgent() is protected the same way', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);

  // The real rename route: spawn as the default, THEN rename. This is how the
  // production registry actually reached its custom name.
  await hive.ensureAgent(god());
  assert.equal(registryOf(home).agents.god.name, DEFAULT_GOD_NAME);
  assert.equal(hive.renameAgent('god', 'lex one').ok, true);

  await hive.ensureAgent(god());
  assert.equal(registryOf(home).agents.god.name, 'lex one');
});

// ── scope: the guard must not become "god's name is frozen" ──────────────────

test('a spawn carrying a REAL name still renames god', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);

  await hive.ensureAgent(god({ name: 'lex one' }));
  // Not the default → this is someone deliberately naming him, and it must land.
  await hive.ensureAgent(god({ name: 'Savvas' }));

  assert.equal(registryOf(home).agents.god.name, 'Savvas',
    'the guard froze the name and broke renaming');
  assert.ok(identityOf(home, 'god').includes('Savvas'));
});

test('a fresh hive still gets the default — there is nothing to protect yet', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);

  await hive.ensureAgent(god());
  assert.equal(registryOf(home).agents.god.name, DEFAULT_GOD_NAME,
    'a first spawn with no prior record must not be blocked');
});

test('a default-named god who was never renamed keeps the default', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);

  await hive.ensureAgent(god());
  await hive.ensureAgent(god());
  assert.equal(registryOf(home).agents.god.name, DEFAULT_GOD_NAME);
});

test('the guard is god-only: a worker can be renamed to anything, default included', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);

  await hive.ensureAgent({ id: 'w1', name: 'Toby', provider: 'claude', cwd: os.tmpdir() });
  await hive.ensureAgent({ id: 'w1', name: DEFAULT_GOD_NAME, provider: 'claude', cwd: os.tmpdir() });

  assert.equal(registryOf(home).agents.w1.name, DEFAULT_GOD_NAME,
    'the god rule leaked onto a normal agent');
});
