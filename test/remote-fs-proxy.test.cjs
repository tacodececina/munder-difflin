'use strict';
/**
 * remote-fs-proxy.test.cjs — the bidirectional filesystem proxy, end to end.
 *
 * Both halves are the REAL ones and they talk over a REAL WebSocket:
 *
 *   - the daemon side is `remote-daemon/src/server.js` — the shipped
 *     RemoteDaemonServer, with the shipped HMAC authenticator and the shipped
 *     TrustedClientStore, listening on 127.0.0.1. It is constructed in-process
 *     rather than spawned as `daemon.js` for one reason: a filesystem mount is a
 *     LATER phase and does not exist yet, so the test has to stand in for it, and
 *     it does that by holding the same `FsMount` / `FsProxy` handle a mount will
 *     hold. No test-only code path exists in the daemon for this, and none should:
 *     a hook that let a client trigger arbitrary fs-requests would be exactly the
 *     bypass this protocol is built to prevent. (`daemon.js` itself — argv, bind
 *     guard, pairing — is covered by remote-daemon/test/test-client.mjs.)
 *
 *   - the GPD side is `src/main/remoteDaemon.ts` + `remoteFsHost.ts`, loaded
 *     through the same `load-ts` transpiler the other main-process tests use, and
 *     pointed at a throwaway hive with a fake agent's files pre-seeded.
 *
 * Nothing is mocked except where a test says so in its own name. The reads, the
 * writes, the renames and the refusals all happen against real files on disk, and
 * the escape cases assert that the real files OUTSIDE the sandbox are still
 * exactly as they were afterwards.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const DAEMON_DIR = path.join(REPO, 'remote-daemon');
const DAEMON_SRC = path.join(DAEMON_DIR, 'src');

/** Why this file cannot run here, or null when it can. */
function unavailable() {
  if (!fs.existsSync(path.join(DAEMON_SRC, 'server.js'))) return 'remote-daemon/ is not present in this checkout';
  try {
    require(path.join(DAEMON_DIR, 'node_modules', 'ws'));
  } catch (err) {
    return `remote-daemon dependencies are not installed (${err && err.message})`;
  }
  return null;
}
const skip = unavailable();

/** Whether the daemon's node-pty binary loads for THIS Node ABI (PTY cases only). */
function ptyUnavailable() {
  try {
    require(path.join(DAEMON_DIR, 'node_modules', 'node-pty'));
    return null;
  } catch (err) {
    return `remote-daemon node-pty will not load (${err && err.message})`;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** A console-shaped sink whose lines can be asserted on. */
function recorder() {
  const lines = [];
  const push = (...args) => lines.push(args.map(String).join(' '));
  return { lines, log: push, warn: push, error: push };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bytes no UTF-8 decoder can round-trip — the point of base64 on the wire. */
function binaryFixture() {
  return Buffer.concat([
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    Buffer.from([0xff, 0xfe, 0x80, 0x00, 0xc3, 0x28]),
    Buffer.from('tail-after-the-bad-bytes', 'utf8')
  ]);
}

/**
 * A throwaway hive with one agent (`orion-x`) laid out exactly the way
 * hive.ts `ensureAgent()` lays one out, a SIBLING agent whose name is a prefix
 * extension of it (`orion-x-evil` — the collision the containment check must not
 * fall for), and a secret file outside the hive entirely.
 */
function seedHive() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fsproxy-home-'));
  const agentsRoot = path.join(home, 'hive', 'agents');
  const agentDir = path.join(agentsRoot, 'orion-x');

  fs.mkdirSync(path.join(agentDir, 'inbox', '.done'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'outbox', '.sent'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'identity.md'), '# Orion (orion-x)\n\n- Role: tester\n', 'utf8');
  fs.writeFileSync(path.join(agentDir, 'memory.md'), '# Memory — Orion (orion-x)\n\nseeded-memory-line\n', 'utf8');
  fs.writeFileSync(path.join(agentDir, 'cursor.json'), JSON.stringify({ lastProcessed: null }), 'utf8');
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ hooks: {} }), 'utf8');
  fs.writeFileSync(path.join(agentDir, 'inbox', 'msg-a.json'), JSON.stringify({ id: 'msg-a', subject: 'first' }), 'utf8');
  fs.writeFileSync(path.join(agentDir, 'inbox', 'msg-b.json'), JSON.stringify({ id: 'msg-b', subject: 'second' }), 'utf8');
  fs.writeFileSync(path.join(agentDir, 'blob.bin'), binaryFixture());
  fs.mkdirSync(path.join(agentDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, '.claude', 'settings.json'), '{}', 'utf8');

  // The prefix-collision sibling: `…/agents/orion-x` must not "contain" this.
  const evilDir = path.join(agentsRoot, 'orion-x-evil');
  fs.mkdirSync(evilDir, { recursive: true });
  fs.writeFileSync(path.join(evilDir, 'secret.txt'), 'SIBLING-AGENT-SECRET', 'utf8');

  // Outside the hive altogether.
  const outside = path.join(home, 'outside-secret.txt');
  fs.writeFileSync(outside, 'OUTSIDE-THE-SANDBOX', 'utf8');

  return { home, agentsRoot, agentDir, evilDir, outside };
}

/**
 * Stand up the real daemon server + the real GPD client, paired and
 * authenticated, with the client serving `agentIds` and nothing else.
 */
async function harness(t, { agentIds = ['orion-x'], clients = 1 } = {}) {
  const { RemoteDaemonServer } = require(path.join(DAEMON_SRC, 'server.js'));
  const { TrustedClientStore } = require(path.join(DAEMON_SRC, 'store.js'));
  const { RemoteDaemonClient } = loadTs('src/main/remoteDaemon.ts');

  const hive = seedHive();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fsproxy-state-'));
  const store = new TrustedClientStore(stateDir);
  const daemonLog = recorder();
  const hostLog = recorder();

  const creds = [];
  for (let i = 0; i < clients; i += 1) {
    const clientId = `client-${randomBytes(8).toString('hex')}`;
    const secret = randomBytes(32).toString('hex');
    store.add({ clientId, secret, name: `test-${i}` });
    creds.push({ clientId, secret });
  }

  const port = await freePort();
  const server = new RemoteDaemonServer({ host: '127.0.0.1', port, store, logger: daemonLog });
  await server.listen();

  const built = [];
  for (const c of creds) {
    const client = new RemoteDaemonClient({ host: '127.0.0.1', port, clientId: c.clientId, secret: c.secret });
    client.enableHiveFs(() => hive.agentsRoot, hostLog);
    const connected = await client.connect();
    assert.equal(connected.ok, true, `client ${c.clientId} failed to authenticate: ${connected.error}`);
    built.push(client);
  }
  // Only the FIRST client is granted the agent folders; the others exist to prove
  // that a second paired device does not inherit anything.
  for (const agentId of agentIds) built[0].authorizeAgent(agentId);

  /** The server-side socket belonging to one paired client. */
  const wsFor = (clientId) => {
    for (const [ws, state] of server.connections) if (state.clientId === clientId) return ws;
    return null;
  };

  t.after(async () => {
    for (const c of built) { try { c.dispose(); } catch { /* already gone */ } }
    try { await server.close(); } catch { /* already down */ }
    for (const dir of [hive.home, stateDir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  return { server, store, hive, creds, clients: built, client: built[0], wsFor, daemonLog, hostLog, port };
}

/** Issue one fs-request the way a mount will: over the wire, from the daemon. */
function ask(server, ws, agentId, op, p, extra = {}) {
  return server.fs.request(ws, { agentId, op, path: p, ...extra });
}

let rawSeq = 0;
/**
 * Send a HAND-BUILT fs-request frame straight down the socket, bypassing the
 * daemon's own outbound validation entirely.
 *
 * This is the threat model that matters. `ask()` above goes through FsProxy,
 * which validates the frame before it leaves — so a rejection there proves only
 * that the honest daemon is well behaved. The security claim is about a daemon
 * that is NOT well behaved: a buggy mount, an out-of-date daemon, or a remote
 * machine somebody else now controls. Those send whatever they like, and the
 * only thing standing in front of the operator's files is the responder in
 * src/main/remoteFsHost.ts. Every path-escape case below is sent this way.
 */
function rawAsk(ws, frame, timeoutMs = 10_000) {
  const reqId = frame.reqId ?? `fs-raw-${(rawSeq += 1)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`timed out waiting for fs-response ${reqId}`));
    }, timeoutMs);
    function onMessage(data) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== 'fs-response' || msg.reqId !== reqId) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      const { type, reqId: _id, ...payload } = msg;
      resolve(payload);
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'fs-request', path: '', ...frame, reqId }));
  });
}

// ───────────────────────────────────────────────────────────────────────────

test('fs proxy round-trips real files: read, write, readdir, stat, mkdir, unlink, rmdir, rename',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const ws = h.wsFor(h.creds[0].clientId);
  assert.ok(ws, 'the daemon should have an authenticated socket for the client');

  // ── read: text ──────────────────────────────────────────────────────────
  const memory = await ask(h.server, ws, 'orion-x', 'read', 'memory.md');
  assert.equal(memory.ok, true, `read failed: ${memory.error}`);
  assert.equal(
    Buffer.from(memory.data, 'base64').toString('utf8'),
    fs.readFileSync(path.join(h.hive.agentDir, 'memory.md'), 'utf8'),
    'a read should return exactly what is on disk'
  );
  assert.equal(memory.stat.type, 'file');
  assert.equal(memory.stat.writable, true, 'memory.md is the agent\'s own file');

  // ── read: BINARY (the whole reason `data` is base64) ─────────────────────
  const blob = await ask(h.server, ws, 'orion-x', 'read', 'blob.bin');
  assert.equal(blob.ok, true, `binary read failed: ${blob.error}`);
  const gotBytes = Buffer.from(blob.data, 'base64');
  assert.ok(gotBytes.equals(binaryFixture()), 'binary content must survive byte for byte');
  // Prove the fixture really is non-UTF8, i.e. that the assertion above had teeth.
  assert.notEqual(
    Buffer.from(binaryFixture().toString('utf8'), 'utf8').length,
    binaryFixture().length,
    'the binary fixture must NOT survive a UTF-8 round trip (otherwise it proves nothing)'
  );

  // ── write, then read back ───────────────────────────────────────────────
  const newMemory = '# Memory — Orion (orion-x)\n\nwritten-from-the-remote-side\n';
  const wrote = await ask(h.server, ws, 'orion-x', 'write', 'memory.md', {
    data: Buffer.from(newMemory, 'utf8').toString('base64')
  });
  assert.equal(wrote.ok, true, `write failed: ${wrote.error}`);
  assert.equal(
    fs.readFileSync(path.join(h.hive.agentDir, 'memory.md'), 'utf8'), newMemory,
    'a write must actually land on disk'
  );
  const reread = await ask(h.server, ws, 'orion-x', 'read', 'memory.md');
  assert.equal(Buffer.from(reread.data, 'base64').toString('utf8'), newMemory,
    'a subsequent read must see the write');
  assert.equal(wrote.stat.size, Buffer.byteLength(newMemory), 'write should report the new size');
  // No temp file left behind by the atomic write.
  assert.equal(fs.readdirSync(h.hive.agentDir).filter((f) => f.endsWith('.tmp')).length, 0);

  // ── write a NEW file into outbox/ (the agent's outbound channel) ─────────
  const message = JSON.stringify({ to: 'god', act: 'inform', subject: 'hi', body: 'from the mount' });
  const sent = await ask(h.server, ws, 'orion-x', 'write', 'outbox/out-1.json', {
    data: Buffer.from(message, 'utf8').toString('base64')
  });
  assert.equal(sent.ok, true, `outbox write failed: ${sent.error}`);
  assert.equal(fs.readFileSync(path.join(h.hive.agentDir, 'outbox', 'out-1.json'), 'utf8'), message);

  // ── readdir: the agent root ─────────────────────────────────────────────
  const root = await ask(h.server, ws, 'orion-x', 'readdir', '');
  assert.equal(root.ok, true, `readdir failed: ${root.error}`);
  const byName = new Map(root.entries.map((e) => [e.name, e]));
  assert.equal(byName.get('identity.md')?.type, 'file');
  assert.equal(byName.get('inbox')?.type, 'dir');
  assert.equal(byName.get('outbox')?.type, 'dir');
  assert.equal(
    byName.get('identity.md').size,
    fs.statSync(path.join(h.hive.agentDir, 'identity.md')).size,
    'readdir must report the real size'
  );
  assert.ok(byName.get('identity.md').mtimeMs > 0, 'readdir must report a real mtime');
  assert.equal(
    Math.round(byName.get('identity.md').mtimeMs),
    Math.round(fs.statSync(path.join(h.hive.agentDir, 'identity.md')).mtimeMs)
  );

  // ── readdir: a subfolder with two files and a subfolder in it ───────────
  const inbox = await ask(h.server, ws, 'orion-x', 'readdir', 'inbox');
  assert.equal(inbox.ok, true, `inbox readdir failed: ${inbox.error}`);
  const inboxNames = inbox.entries.map((e) => e.name).sort();
  assert.deepEqual(inboxNames, ['.done', 'msg-a.json', 'msg-b.json']);
  assert.equal(inbox.entries.find((e) => e.name === '.done').type, 'dir');
  assert.equal(inbox.entries.filter((e) => e.type === 'file').length, 2);

  // ── stat ────────────────────────────────────────────────────────────────
  const statFile = await ask(h.server, ws, 'orion-x', 'stat', 'inbox/msg-a.json');
  assert.equal(statFile.ok, true, `stat failed: ${statFile.error}`);
  assert.equal(statFile.stat.type, 'file');
  assert.equal(statFile.stat.size, fs.statSync(path.join(h.hive.agentDir, 'inbox', 'msg-a.json')).size);
  assert.ok(statFile.stat.mtimeMs > 0 && statFile.stat.birthtimeMs >= 0);

  const statDir = await ask(h.server, ws, 'orion-x', 'stat', 'inbox');
  assert.equal(statDir.stat.type, 'dir');

  const statRoot = await ask(h.server, ws, 'orion-x', 'stat', '');
  assert.equal(statRoot.ok, true, 'stat of the agent folder itself should work');
  assert.equal(statRoot.stat.type, 'dir');

  const missing = await ask(h.server, ws, 'orion-x', 'stat', 'no-such-file.md');
  assert.deepEqual(missing, { ok: false, error: 'not_found' });

  const readMissing = await ask(h.server, ws, 'orion-x', 'read', 'nope/none.md');
  assert.deepEqual(readMissing, { ok: false, error: 'not_found' });

  const readDir = await ask(h.server, ws, 'orion-x', 'read', 'inbox');
  assert.deepEqual(readDir, { ok: false, error: 'is_a_directory' });

  const readdirFile = await ask(h.server, ws, 'orion-x', 'readdir', 'identity.md');
  assert.equal(readdirFile.ok, false);
  assert.equal(readdirFile.error, 'not_a_directory');

  // ── mkdir / unlink / rmdir ──────────────────────────────────────────────
  const made = await ask(h.server, ws, 'orion-x', 'mkdir', 'outbox/drafts');
  assert.equal(made.ok, true, `mkdir failed: ${made.error}`);
  assert.ok(fs.statSync(path.join(h.hive.agentDir, 'outbox', 'drafts')).isDirectory());

  const madeTwice = await ask(h.server, ws, 'orion-x', 'mkdir', 'outbox/drafts');
  assert.deepEqual(madeTwice, { ok: false, error: 'exists' });

  await ask(h.server, ws, 'orion-x', 'write', 'outbox/drafts/d1.json', { data: Buffer.from('{}').toString('base64') });
  const rmNonEmpty = await ask(h.server, ws, 'orion-x', 'rmdir', 'outbox/drafts');
  assert.deepEqual(rmNonEmpty, { ok: false, error: 'not_empty' });

  const unlinked = await ask(h.server, ws, 'orion-x', 'unlink', 'outbox/drafts/d1.json');
  assert.equal(unlinked.ok, true, `unlink failed: ${unlinked.error}`);
  assert.equal(fs.existsSync(path.join(h.hive.agentDir, 'outbox', 'drafts', 'd1.json')), false);

  const unlinkDir = await ask(h.server, ws, 'orion-x', 'unlink', 'outbox/drafts');
  assert.deepEqual(unlinkDir, { ok: false, error: 'is_a_directory' });

  const removed = await ask(h.server, ws, 'orion-x', 'rmdir', 'outbox/drafts');
  assert.equal(removed.ok, true, `rmdir failed: ${removed.error}`);
  assert.equal(fs.existsSync(path.join(h.hive.agentDir, 'outbox', 'drafts')), false);

  // ── rename: the documented inbox -> inbox/.done move ─────────────────────
  const moved = await ask(h.server, ws, 'orion-x', 'rename', 'inbox/msg-a.json', { newPath: 'inbox/.done/msg-a.json' });
  assert.equal(moved.ok, true, `rename failed: ${moved.error}`);
  assert.equal(fs.existsSync(path.join(h.hive.agentDir, 'inbox', 'msg-a.json')), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(h.hive.agentDir, 'inbox', '.done', 'msg-a.json'), 'utf8')).id,
    'msg-a',
    'the handled message should be intact in .done/'
  );

  // ...and a rename inside outbox/, which a mount does when archiving.
  const archived = await ask(h.server, ws, 'orion-x', 'rename', 'outbox/out-1.json', { newPath: 'outbox/.sent/out-1.json' });
  assert.equal(archived.ok, true, `outbox rename failed: ${archived.error}`);
  assert.ok(fs.existsSync(path.join(h.hive.agentDir, 'outbox', '.sent', 'out-1.json')));
});

test('path escapes are rejected, logged, and touch nothing outside the sandbox',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const ws = h.wsFor(h.creds[0].clientId);

  const outsideBefore = fs.readFileSync(h.hive.outside, 'utf8');
  const siblingBefore = fs.readFileSync(path.join(h.hive.evilDir, 'secret.txt'), 'utf8');

  const attacks = [
    ['classic dot-dot traversal', '../../../etc/passwd'],
    ['Windows-flavoured traversal', '..\\..\\..\\..\\Windows\\System32\\drivers\\etc\\hosts'],
    ['traversal hidden mid-path', 'inbox/../../../../Windows/System32/config/SAM'],
    ['absolute POSIX path', '/etc/passwd'],
    ['absolute Windows path', 'C:\\Windows\\System32\\config\\SAM'],
    ['UNC path', '\\\\attacker\\share\\payload'],
    ['drive-relative path', 'C:evil.txt'],
    ['PREFIX COLLISION with a sibling agent', '../orion-x-evil/secret.txt'],
    ['prefix collision, dressed up', 'inbox/.done/../../../orion-x-evil/secret.txt'],
    ['straight out of the hive', '../../../outside-secret.txt'],
    ['NTFS alternate data stream', 'memory.md:evil'],
    ['trailing-dot Windows alias', 'identity.md.']
  ];

  for (const [name, attack] of attacks) {
    // RAW frames: a compromised daemon does not run its own validation, so the
    // client-side gate has to be the one that refuses.
    const read = await rawAsk(ws, { agentId: 'orion-x', op: 'read', path: attack });
    assert.equal(read.ok, false, `${name}: a read of ${JSON.stringify(attack)} must not succeed`);
    assert.equal(read.error, 'path_escape', `${name}: expected path_escape, got ${read.error}`);
    assert.equal(read.data, undefined, `${name}: no bytes may come back`);

    const write = await rawAsk(ws, {
      agentId: 'orion-x', op: 'write', path: attack, data: Buffer.from('PWNED', 'utf8').toString('base64')
    });
    assert.equal(write.error, 'path_escape', `${name}: a write must be refused too`);

    const list = await rawAsk(ws, { agentId: 'orion-x', op: 'readdir', path: attack });
    assert.equal(list.error, 'path_escape', `${name}: a readdir must be refused too`);

    const del = await rawAsk(ws, { agentId: 'orion-x', op: 'unlink', path: attack });
    assert.equal(del.error, 'path_escape', `${name}: an unlink must be refused too`);

    // ...and the honest daemon refuses to even put it on the wire.
    const local = await ask(h.server, ws, 'orion-x', 'read', attack);
    assert.equal(local.error, 'path_escape', `${name}: FsProxy should refuse it locally too`);
  }

  // A rename whose SOURCE is legal but whose DESTINATION escapes.
  const renameOut = await rawAsk(ws, {
    agentId: 'orion-x', op: 'rename', path: 'memory.md', newPath: '../orion-x-evil/stolen.md'
  });
  assert.equal(renameOut.error, 'path_escape', 'an escaping rename destination must be refused');
  assert.equal(fs.existsSync(path.join(h.hive.evilDir, 'stolen.md')), false);
  assert.ok(fs.existsSync(path.join(h.hive.agentDir, 'memory.md')), 'the source must not have moved');

  // A SYMLINK inside the sandbox pointing out of it — the case `path.resolve`
  // alone cannot see. (The hive really does contain symlinks: a Codex worker's
  // .codex data dirs are linked to the user's global ~/.codex.)
  const linkPath = path.join(h.hive.agentDir, 'escape-link');
  let linked = false;
  try {
    fs.symlinkSync(h.hive.home, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch {
    // Creating symlinks can require privileges; the rest of the file still stands.
  }
  if (linked) {
    const viaLink = await ask(h.server, ws, 'orion-x', 'read', 'escape-link/outside-secret.txt');
    assert.equal(viaLink.ok, false, 'a symlink out of the sandbox must not be followed');
    assert.equal(viaLink.error, 'path_escape');
    const listLink = await ask(h.server, ws, 'orion-x', 'readdir', 'escape-link');
    assert.equal(listLink.error, 'path_escape');
    // ...and the link is reported as what it is, not as a directory to descend.
    const rootList = await ask(h.server, ws, 'orion-x', 'readdir', '');
    const linkEntry = rootList.entries.find((e) => e.name === 'escape-link');
    assert.ok(linkEntry && linkEntry.type !== 'dir',
      'a symlink must not be advertised as a plain directory');
  }

  // NOTHING outside the sandbox changed, and nothing new appeared.
  assert.equal(fs.readFileSync(h.hive.outside, 'utf8'), outsideBefore);
  assert.equal(fs.readFileSync(path.join(h.hive.evilDir, 'secret.txt'), 'utf8'), siblingBefore);
  assert.deepEqual(fs.readdirSync(h.hive.evilDir), ['secret.txt'], 'the sibling agent folder must be untouched');
  assert.deepEqual(
    fs.readdirSync(h.hive.agentsRoot).sort(), ['orion-x', 'orion-x-evil'],
    'no new agent folder may have been created'
  );
  assert.equal(fs.existsSync(path.join(h.hive.home, 'evil.txt')), false);
  assert.equal(fs.existsSync(path.join(h.hive.home, 'PWNED')), false);

  // Every refusal was LOGGED — a silent rejection tells an operator nothing.
  const escapes = h.hostLog.lines.filter((l) => l.includes('PATH ESCAPE REJECTED'));
  assert.ok(escapes.length >= attacks.length * 4,
    `expected a log line per refused operation, got ${escapes.length}`);
  assert.ok(escapes.some((l) => l.includes('orion-x-evil')), 'the offending path should be in the log');
});

test('the hive write policy is enforced: harness-owned files are readable but never writable',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const ws = h.wsFor(h.creds[0].clientId);
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  const identityBefore = fs.readFileSync(path.join(h.hive.agentDir, 'identity.md'), 'utf8');
  const cursorBefore = fs.readFileSync(path.join(h.hive.agentDir, 'cursor.json'), 'utf8');

  // READS are allowed everywhere in the folder — a remote agent must be able to
  // read its identity and its mail, exactly like a local one.
  for (const readable of ['identity.md', 'cursor.json', 'settings.json', 'inbox/msg-a.json', '.claude/settings.json']) {
    const res = await ask(h.server, ws, 'orion-x', 'read', readable);
    assert.equal(res.ok, true, `${readable} should be readable: ${res.error}`);
  }

  // WRITES are confined to the agent's own half of the hive contract.
  const forbiddenWrites = [
    ['identity.md', 'the harness rewrites it on every spawn'],
    ['cursor.json', 'the inbox watermark — writable means an agent can suppress its own wakeups'],
    ['settings.json', 'hook + permission config'],
    ['.gitignore', 'harness-owned'],
    ['.claude/settings.json', 'provider config'],
    ['inbox/forged.json', 'inbox is the ROUTER\'s to fill — writing one forges mail'],
    ['inbox/msg-b.json', 'tampering with a message already delivered'],
    ['new-top-level.md', 'default-deny: anything not named in the policy']
  ];
  for (const [target, why] of forbiddenWrites) {
    const res = await ask(h.server, ws, 'orion-x', 'write', target, { data: b64('OVERWRITTEN') });
    assert.equal(res.ok, false, `writing ${target} must be refused (${why})`);
    assert.equal(res.error, 'read_only', `writing ${target} should be read_only, got ${res.error}`);
  }
  assert.equal(fs.readFileSync(path.join(h.hive.agentDir, 'identity.md'), 'utf8'), identityBefore);
  assert.equal(fs.readFileSync(path.join(h.hive.agentDir, 'cursor.json'), 'utf8'), cursorBefore);
  assert.equal(fs.existsSync(path.join(h.hive.agentDir, 'inbox', 'forged.json')), false);
  assert.equal(fs.existsSync(path.join(h.hive.agentDir, 'new-top-level.md')), false);

  // Deletes follow the same policy.
  assert.equal((await ask(h.server, ws, 'orion-x', 'unlink', 'identity.md')).error, 'read_only');
  assert.equal((await ask(h.server, ws, 'orion-x', 'unlink', 'cursor.json')).error, 'read_only');
  assert.equal((await ask(h.server, ws, 'orion-x', 'rmdir', 'inbox')).error, 'read_only');
  assert.equal((await ask(h.server, ws, 'orion-x', 'rmdir', 'outbox')).error, 'read_only');
  assert.equal((await ask(h.server, ws, 'orion-x', 'mkdir', 'newdir')).error, 'read_only');
  assert.ok(fs.existsSync(path.join(h.hive.agentDir, 'identity.md')));
  assert.ok(fs.existsSync(path.join(h.hive.agentDir, 'inbox')));

  // A rename may not launder a writable file into a protected name.
  const launder = await ask(h.server, ws, 'orion-x', 'rename', 'memory.md', { newPath: 'identity.md' });
  assert.equal(launder.error, 'read_only', 'rename must check the DESTINATION policy too');
  assert.equal(fs.readFileSync(path.join(h.hive.agentDir, 'identity.md'), 'utf8'), identityBefore);

  // ...nor move a protected file out of the way.
  const evict = await ask(h.server, ws, 'orion-x', 'rename', 'cursor.json', { newPath: 'outbox/cursor.json' });
  assert.equal(evict.error, 'read_only', 'rename must check the SOURCE policy too');
  assert.ok(fs.existsSync(path.join(h.hive.agentDir, 'cursor.json')));

  // What the agent IS allowed to do still works.
  assert.equal((await ask(h.server, ws, 'orion-x', 'write', 'memory.md', { data: b64('# memory\nok\n') })).ok, true);
  assert.equal((await ask(h.server, ws, 'orion-x', 'write', 'outbox/m.json', { data: b64('{}') })).ok, true);
  assert.equal((await ask(h.server, ws, 'orion-x', 'rename', 'inbox/msg-b.json',
    { newPath: 'inbox/.done/msg-b.json' })).ok, true);
  assert.equal((await ask(h.server, ws, 'orion-x', 'unlink', 'inbox/.done/msg-b.json')).ok, true);
});

test('an fs-request for an agent the connection was not authorized for is refused',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { agentIds: ['orion-x'] });
  const ws = h.wsFor(h.creds[0].clientId);

  // `orion-x-evil` exists on disk and is a perfectly valid agent id — the ONLY
  // thing standing between the daemon and its files is the grant.
  const sibling = await ask(h.server, ws, 'orion-x-evil', 'read', 'secret.txt');
  assert.deepEqual(sibling, { ok: false, error: 'unauthorized_agent' });

  const listSibling = await ask(h.server, ws, 'orion-x-evil', 'readdir', '');
  assert.deepEqual(listSibling, { ok: false, error: 'unauthorized_agent' });

  // An id that does not exist at all is refused the same way, so the error can
  // never be used to enumerate which agents this machine has.
  const ghost = await ask(h.server, ws, 'no-such-agent', 'stat', '');
  assert.deepEqual(ghost, { ok: false, error: 'unauthorized_agent' });

  // The authorized one still works, then stops the moment the grant is withdrawn
  // (which is what a kill/exit does — see RemoteDaemonManager).
  assert.equal((await ask(h.server, ws, 'orion-x', 'stat', 'memory.md')).ok, true);
  h.client.revokeAgent('orion-x');
  assert.deepEqual(await ask(h.server, ws, 'orion-x', 'read', 'memory.md'),
    { ok: false, error: 'unauthorized_agent' });

  // And a client that never enabled the feature answers nothing at all.
  const { RemoteDaemonClient } = loadTs('src/main/remoteDaemon.ts');
  const plain = new RemoteDaemonClient({ host: '127.0.0.1', port: h.port, clientId: h.creds[0].clientId, secret: h.creds[0].secret });
  t.after(() => { try { plain.dispose(); } catch { /* already gone */ } });
  assert.equal(plain.isHiveFsEnabled, false);
  const conn = await plain.connect();
  assert.equal(conn.ok, true, `second connection failed: ${conn.error}`);
  const plainWs = [...h.server.connections.keys()].find((w) => w !== ws);
  assert.ok(plainWs, 'the daemon should see the second socket');
  assert.deepEqual(await ask(h.server, plainWs, 'orion-x', 'read', 'memory.md'),
    { ok: false, error: 'unsupported_op' });

  // A grant cannot be created out of a malformed id.
  assert.equal(h.client.authorizeAgent('../orion-x-evil'), false);
  assert.equal(h.client.authorizeAgent('c:evil'), false);
  assert.equal(h.client.authorizeAgent(''), false);
  assert.deepEqual(h.client.authorizedAgents(), []);
});

test('concurrent requests resolve to their own callers, in-order and out-of-order',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const ws = h.wsFor(h.creds[0].clientId);

  // 1. REAL files, all in flight at once. Each file's content encodes its index,
  //    so a crossed wire shows up as a mismatch rather than as a silent pass.
  const files = [];
  for (let i = 0; i < 12; i += 1) {
    const name = `outbox/concurrent-${i}.json`;
    const body = JSON.stringify({ index: i, payload: 'x'.repeat(i * 97) });
    const wrote = await ask(h.server, ws, 'orion-x', 'write', name, {
      data: Buffer.from(body, 'utf8').toString('base64')
    });
    assert.equal(wrote.ok, true, `seed write ${i} failed: ${wrote.error}`);
    files.push({ name, body, i });
  }

  const results = await Promise.all(files.map((f) => ask(h.server, ws, 'orion-x', 'read', f.name)));
  results.forEach((res, i) => {
    assert.equal(res.ok, true, `concurrent read ${i} failed: ${res.error}`);
    assert.equal(JSON.parse(Buffer.from(res.data, 'base64').toString('utf8')).index, i,
      `read ${i} came back with another request's answer`);
  });

  // Mixed ops in flight together — a failing one must not poison its neighbours.
  const mixed = await Promise.all([
    ask(h.server, ws, 'orion-x', 'read', 'outbox/concurrent-3.json'),
    ask(h.server, ws, 'orion-x', 'stat', 'no-such-thing'),
    ask(h.server, ws, 'orion-x', 'readdir', 'inbox'),
    ask(h.server, ws, 'orion-x', 'read', 'outbox/concurrent-7.json'),
    ask(h.server, ws, 'orion-x-evil', 'read', 'secret.txt')
  ]);
  assert.equal(JSON.parse(Buffer.from(mixed[0].data, 'base64').toString('utf8')).index, 3);
  assert.deepEqual(mixed[1], { ok: false, error: 'not_found' });
  assert.equal(mixed[2].entries.length, 3);
  assert.equal(JSON.parse(Buffer.from(mixed[3].data, 'base64').toString('utf8')).index, 7);
  assert.deepEqual(mixed[4], { ok: false, error: 'unauthorized_agent' });

  // 2. The adversarial ordering: a responder that answers in EXACTLY the reverse
  //    order it was asked. Real I/O usually completes near enough in order for
  //    an id-less protocol to look fine, which is precisely how this class of bug
  //    ships. Here the first request is the slowest and the last is instant.
  const N = 8;
  h.client.attachFsHost({
    async handle(req) {
      const idx = Number(req.path.replace(/\D/g, ''));
      await sleep((N - idx) * 25);
      return { ok: true, data: Buffer.from(`answer-for-${idx}`, 'utf8').toString('base64') };
    }
  });
  const reversed = await Promise.all(
    Array.from({ length: N }, (_, i) => ask(h.server, ws, 'orion-x', 'read', `outbox/slow-${i}.json`))
  );
  reversed.forEach((res, i) => {
    assert.equal(res.ok, true);
    assert.equal(Buffer.from(res.data, 'base64').toString('utf8'), `answer-for-${i}`,
      `out-of-order reply ${i} was delivered to the wrong pending request`);
  });

  // Every request got its own reqId; none were reused.
  assert.equal(h.server.fs.inflight, 0, 'no request may be left pending');
});

test('a dead connection fails fs requests instead of hanging the mount',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const ws = h.wsFor(h.creds[0].clientId);

  assert.equal((await ask(h.server, ws, 'orion-x', 'stat', 'memory.md')).ok, true);

  h.client.dispose();
  // Wait for the daemon to notice the socket went away.
  for (let i = 0; i < 100 && h.server.connections.has(ws); i += 1) await sleep(20);
  assert.equal(h.server.connections.has(ws), false, 'the daemon should have dropped the closed connection');

  const afterClose = await ask(h.server, ws, 'orion-x', 'read', 'memory.md');
  assert.deepEqual(afterClose, { ok: false, error: 'disconnected' },
    'a request on a dead socket must fail immediately, not wait for the deadline');
});

test('registerFsMount only grants an agent to the connection that owns its PTY session',
  { skip: skip || ptyUnavailable() || false, timeout: 90_000 }, async (t) => {
  const h = await harness(t, { clients: 2 });
  const wsA = h.wsFor(h.creds[0].clientId);
  const wsB = h.wsFor(h.creds[1].clientId);
  const isWin = process.platform === 'win32';

  // No session yet: nothing to own, nothing to grant.
  assert.equal(h.server.registerFsMount(wsA, { agentId: 'orion-x', sessionId: 'ghost' }).ok, false);

  // Client A spawns the remote agent's PTY.
  const spawned = await h.clients[0].spawn({
    id: 'remote-orion',
    command: isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    args: [],
    cols: 80,
    rows: 24
  });
  assert.equal(spawned.ok, true, `spawn failed: ${spawned.error}`);
  t.after(() => { try { h.clients[0].kill('remote-orion'); } catch { /* already gone */ } });

  // The daemon recorded WHO spawned it, and never leaks that in `list`.
  assert.equal(h.server.sessions.ownerOf('remote-orion'), h.creds[0].clientId);
  assert.equal(h.server.sessions.list().find((s) => s.id === 'remote-orion').ownerClientId, undefined);

  // B is authenticated, paired, and completely legitimate — and still may not
  // mount an agent whose session belongs to A.
  const refused = h.server.registerFsMount(wsB, { agentId: 'orion-x', sessionId: 'remote-orion' });
  assert.equal(refused.ok, false, 'a different paired device must not inherit the mount');
  assert.match(refused.error, /another client/);
  assert.deepEqual(h.server.fsAgentsFor(wsB), []);

  // A gets the grant, and the handle really works end to end.
  const granted = h.server.registerFsMount(wsA, { agentId: 'orion-x', sessionId: 'remote-orion' });
  assert.equal(granted.ok, true, `mount refused: ${granted.error}`);
  assert.deepEqual(h.server.fsAgentsFor(wsA), ['orion-x']);

  const read = await granted.mount.read('memory.md');
  assert.equal(read.ok, true, `mount read failed: ${read.error}`);
  assert.match(read.data.toString('utf8'), /seeded-memory-line/);

  const written = await granted.mount.write('outbox/from-mount.json', Buffer.from('{"via":"mount"}'));
  assert.equal(written.ok, true, `mount write failed: ${written.error}`);
  assert.equal(fs.readFileSync(path.join(h.hive.agentDir, 'outbox', 'from-mount.json'), 'utf8'), '{"via":"mount"}');

  const listed = await granted.mount.readdir('inbox');
  assert.equal(listed.ok, true);
  assert.equal(listed.entries.length, 3);

  // A released handle stops working even though the socket is still up.
  granted.mount.release();
  assert.deepEqual(await granted.mount.stat('memory.md'), { ok: false, error: 'unauthorized_agent' });

  // Even B's own second mount attempt with a made-up agent id is refused for the
  // same reason, not because the id is unknown.
  assert.equal(h.server.registerFsMount(wsB, { agentId: 'orion-x', sessionId: 'remote-orion' }).ok, false);
});

test('the daemon survives malformed fs traffic and keeps answering',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const ws = h.wsFor(h.creds[0].clientId);

  // Requests the daemon refuses to even put on the wire.
  assert.deepEqual(await ask(h.server, ws, '../evil', 'read', 'memory.md'), { ok: false, error: 'invalid_request' });
  assert.deepEqual(await ask(h.server, ws, 'orion-x', 'chmod', 'memory.md'), { ok: false, error: 'unsupported_op' });
  assert.deepEqual(await ask(h.server, ws, 'orion-x', 'read', '../../etc/passwd'), { ok: false, error: 'path_escape' });
  assert.deepEqual(await ask(h.server, ws, 'orion-x', 'read', ''), { ok: false, error: 'invalid_request' });
  // '' is a legal path (the agent folder) but never a legal rename destination.
  assert.deepEqual(await ask(h.server, ws, 'orion-x', 'rename', 'memory.md', { newPath: '' }),
    { ok: false, error: 'invalid_request' });
  assert.deepEqual(await ask(h.server, ws, 'orion-x', 'rename', 'memory.md', { newPath: '../out.md' }),
    { ok: false, error: 'path_escape' });
  assert.deepEqual(await ask(h.server, ws, 'orion-x', 'write', 'outbox/x.json', { data: 'not base64!!' }),
    { ok: false, error: 'invalid_request' });

  // Junk from the client direction, at the socket level.
  const WebSocket = require(path.join(REPO, 'node_modules', 'ws'));
  const rogue = new WebSocket(`ws://127.0.0.1:${h.port}`);
  await new Promise((resolve, reject) => { rogue.once('open', resolve); rogue.once('error', reject); });
  // Unauthenticated: anything, including an fs-response, closes the socket.
  rogue.send(JSON.stringify({ type: 'fs-response', reqId: 'fs-deadbeef-1', ok: true }));
  await new Promise((resolve) => rogue.once('close', resolve));

  // Now an AUTHENTICATED but unsolicited/garbage response.
  const socket = [...h.server.connections.keys()].find((w) => w === ws);
  assert.ok(socket, 'the authenticated socket should still be there');
  const inflightBefore = h.server.fs.inflight;
  // A response nobody is waiting for is logged and dropped, never fatal.
  h.server.handleAuthedMessage(ws, { type: 'fs-response', reqId: 'fs-nobody-1', ok: true }, 'test');
  assert.equal(h.server.fs.inflight, inflightBefore);
  assert.ok(h.daemonLog.lines.some((l) => l.includes('unsolicited fs-response')));

  // And the link still works.
  assert.equal((await ask(h.server, ws, 'orion-x', 'stat', 'memory.md')).ok, true);
});

test('the two protocol copies (daemon JS and main-process TS) agree', { skip: skip || false }, () => {
  const js = require(path.join(DAEMON_SRC, 'protocol.js'));
  const ts = loadTs('src/main/remoteFsProtocol.ts');

  assert.deepEqual([...js.FS_OPS], [...ts.FS_OPS], 'the op list must match');
  assert.deepEqual([...js.FS_ROOT_OPS], [...ts.FS_ROOT_OPS]);
  assert.deepEqual([...js.FS_TWO_PATH_OPS], [...ts.FS_TWO_PATH_OPS]);
  assert.deepEqual(js.FS_ERRORS, { ...ts.FS_ERRORS }, 'the error codes must match');
  assert.equal(js.MAX_FS_FILE_BYTES, ts.MAX_FS_FILE_BYTES);
  assert.equal(js.MAX_FS_PATH_LENGTH, ts.MAX_FS_PATH_LENGTH);
  assert.equal(js.MAX_FS_ENTRIES, ts.MAX_FS_ENTRIES);
  assert.equal(js.MAX_FS_INFLIGHT, ts.MAX_FS_INFLIGHT);
  // The file size cap must still fit inside one frame after base64 + envelope.
  assert.ok(Math.ceil(js.MAX_FS_FILE_BYTES / 3) * 4 < js.MAX_MESSAGE_BYTES,
    'a max-size file must fit in one MAX_MESSAGE_BYTES frame once base64-encoded');

  const paths = [
    '', 'memory.md', 'inbox/msg.json', 'inbox\\msg.json', 'inbox/.done/msg.json', 'a/b/c.txt', './memory.md',
    '..', '../x', 'a/../../b', '/etc/passwd', '\\etc\\passwd', 'C:\\Windows', 'C:x', '\\\\host\\share',
    'memory.md:ads', 'trailing.', 'trailing ', 'x'.repeat(1025), 'a/../b'
  ];
  for (const p of paths) {
    assert.equal(js.isSafeRelPath(p), ts.isSafeRelPath(p), `isSafeRelPath disagrees on ${JSON.stringify(p)}`);
  }
  for (const id of ['orion-x', 'orion_x.1', '..', '.', 'c:evil', 'a/b', 'a\\b', '', 'x'.repeat(129), 'ok-123']) {
    assert.equal(js.isValidAgentId(id), ts.isValidAgentId(id), `isValidAgentId disagrees on ${JSON.stringify(id)}`);
  }
  for (const rid of ['fs-abc-1', 'a:b', 'a/b', '', 'x'.repeat(129)]) {
    assert.equal(js.isValidReqId(rid), ts.isValidReqId(rid), `isValidReqId disagrees on ${JSON.stringify(rid)}`);
  }

  // Sanity on the guard itself, not just on the two copies agreeing.
  assert.equal(js.isSafeRelPath('../../../etc/passwd'), false);
  assert.equal(js.isSafeRelPath('inbox/.done/x.json'), true);
  assert.equal(ts.isSafeRelPath('..\\..\\Windows\\System32'), false);
});

test('the path sandbox holds as a pure function, independent of any socket',
  { skip: skip || false }, async (t) => {
  const { resolveWithinAgentDir, hiveWriteClass } = loadTs('src/main/remoteFsHost.ts');
  const hive = seedHive();
  t.after(() => { try { fs.rmSync(hive.home, { recursive: true, force: true }); } catch { /* best-effort */ } });

  const ok = await resolveWithinAgentDir(hive.agentsRoot, 'orion-x', 'inbox/msg-a.json');
  assert.equal(ok.ok, true);
  assert.equal(ok.resolved.full, path.join(hive.agentDir, 'inbox', 'msg-a.json'));

  for (const attack of ['../orion-x-evil/secret.txt', '../../../etc/passwd', '/etc/passwd', 'C:\\x', '..']) {
    const res = await resolveWithinAgentDir(hive.agentsRoot, 'orion-x', attack);
    assert.equal(res.ok, false, `${attack} must not resolve`);
    assert.equal(res.error, 'path_escape');
  }
  // The prefix-collision case, spelled out: the sibling folder is a STRING prefix
  // extension of the sandbox, and must still be out of reach.
  assert.ok(path.join(hive.agentsRoot, 'orion-x-evil').startsWith(path.join(hive.agentsRoot, 'orion-x')),
    'the fixture must actually reproduce the prefix collision');
  const collision = await resolveWithinAgentDir(hive.agentsRoot, 'orion-x', '../orion-x-evil/secret.txt');
  assert.equal(collision.error, 'path_escape');

  // An agent id that is not a plain folder name never becomes a path at all.
  for (const badId of ['../orion-x-evil', 'a/b', 'c:evil', '..']) {
    const res = await resolveWithinAgentDir(hive.agentsRoot, badId, 'memory.md');
    assert.equal(res.ok, false, `${badId} must not resolve`);
  }

  // The write policy, as a table.
  assert.equal(hiveWriteClass('memory.md'), 'writable');
  assert.equal(hiveWriteClass('outbox/m.json'), 'writable');
  assert.equal(hiveWriteClass('outbox/.sent/m.json'), 'writable');
  assert.equal(hiveWriteClass('inbox/.done/m.json'), 'writable');
  assert.equal(hiveWriteClass('inbox/m.json'), 'mutable-only');
  assert.equal(hiveWriteClass('inbox'), 'read-only');
  assert.equal(hiveWriteClass('outbox'), 'read-only');
  assert.equal(hiveWriteClass('inbox/.done'), 'read-only');
  assert.equal(hiveWriteClass('identity.md'), 'read-only');
  assert.equal(hiveWriteClass('cursor.json'), 'read-only');
  assert.equal(hiveWriteClass('settings.json'), 'read-only');
  assert.equal(hiveWriteClass('.claude/settings.json'), 'read-only');
  assert.equal(hiveWriteClass(''), 'read-only');
  assert.equal(hiveWriteClass('memory.md/nested'), 'read-only');
});
