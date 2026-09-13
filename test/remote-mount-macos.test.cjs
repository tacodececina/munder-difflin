'use strict';
/**
 * remote-mount-macos.test.cjs — Phase 3e, the macOS mount's translation layer.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT. Read this before trusting a green run.
 *
 * REAL: the daemon (`remote-daemon/src/server.js`), the correlation layer
 * (`fsproxy.js`), the capability handle (`FsMount`), the WebSocket between them,
 * the GPD-side responder (`src/main/remoteDaemon.ts` + `remoteFsHost.ts`) with
 * its real path sandbox and real write policy, a real throwaway hive on disk,
 * and every line of `remote-daemon/src/mount-macos.js`. A `read_only` in these
 * tests is produced by the actual hive policy; a `path_escape` is produced by
 * the actual sandbox; an `ENOENT` is produced because the file is actually not
 * there.
 *
 * NOT REAL: the FUSE binding, and therefore the kernel. There is no macOS here
 * and no FUSE-T driver, so `MockFuse` below stands in for the native addon. It
 * is not a stub that returns canned answers — it is a faithful reimplementation
 * of the ONE thing the binding does that this code depends on: how
 * `@cocalc/fuse-native`'s `index.js` invokes an ops callback and how it reads
 * that callback's arguments back. `callOp()` mirrors `_op_getattr`,
 * `_op_read`, `_op_write` and friends line for line, including the detail that
 * read/write return their byte count in the FIRST callback argument, where every
 * other op puts its return code.
 *
 * So what a green run here proves is: given a FUSE binding that behaves the way
 * fuse-native documents and implements, this mount speaks the proxy protocol
 * correctly and returns the right errno for every documented failure. What it
 * does not prove is that the binding loads on a Mac. See the checklist at the
 * bottom of this file.
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

function unavailable() {
  if (!fs.existsSync(path.join(DAEMON_SRC, 'mount-macos.js'))) return 'remote-daemon/src/mount-macos.js is not present';
  try {
    require(path.join(DAEMON_DIR, 'node_modules', 'ws'));
  } catch (err) {
    return `remote-daemon dependencies are not installed (${err && err.message})`;
  }
  return null;
}
const skip = unavailable();

function ptyUnavailable() {
  try {
    require(path.join(DAEMON_DIR, 'node_modules', 'node-pty'));
    return null;
  } catch (err) {
    return `remote-daemon node-pty will not load (${err && err.message})`;
  }
}

const MOUNT = skip ? null : require(path.join(DAEMON_SRC, 'mount-macos.js'));
const PROTOCOL = skip ? null : require(path.join(DAEMON_SRC, 'protocol.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function recorder() {
  const lines = [];
  const push = (...args) => lines.push(args.map(String).join(' '));
  return { lines, log: push, warn: push, error: push };
}

// ───────────────────────────────────────────────────────────────────────────
// The fixture
// ───────────────────────────────────────────────────────────────────────────

/**
 * A throwaway hive laid out the way `hive.ts ensureAgent()` lays one out, plus
 * the pieces these tests need: a file over the 512 KiB cap, and the sibling
 * agent whose name is a string-prefix extension of ours.
 */
function seedHive() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mount-home-'));
  const agentsRoot = path.join(home, 'hive', 'agents');
  const agentDir = path.join(agentsRoot, 'orion-x');

  fs.mkdirSync(path.join(agentDir, 'inbox', '.done'), { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'outbox', '.sent'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'identity.md'), '# Orion (orion-x)\n\n- Role: tester\n', 'utf8');
  fs.writeFileSync(path.join(agentDir, 'memory.md'), '# Memory — Orion (orion-x)\n\nseeded-memory-line\n', 'utf8');
  fs.writeFileSync(path.join(agentDir, 'cursor.json'), JSON.stringify({ lastProcessed: null }), 'utf8');
  fs.writeFileSync(path.join(agentDir, 'inbox', 'msg-a.json'), JSON.stringify({ id: 'msg-a' }), 'utf8');
  fs.writeFileSync(path.join(agentDir, 'inbox', 'msg-b.json'), JSON.stringify({ id: 'msg-b' }), 'utf8');
  // Over MAX_FS_FILE_BYTES (512 KiB), so `open` must refuse it with EFBIG
  // before a read is ever attempted (README §10).
  fs.writeFileSync(path.join(agentDir, 'outbox', 'huge.bin'), Buffer.alloc(600 * 1024, 0x41));

  const evilDir = path.join(agentsRoot, 'orion-x-evil');
  fs.mkdirSync(evilDir, { recursive: true });
  fs.writeFileSync(path.join(evilDir, 'secret.txt'), 'SIBLING-AGENT-SECRET', 'utf8');
  fs.writeFileSync(path.join(home, 'outside-secret.txt'), 'OUTSIDE-THE-SANDBOX', 'utf8');

  return { home, agentsRoot, agentDir, evilDir };
}

/**
 * Count what actually goes on the wire.
 *
 * The attribute cache and the sidecar filter are both claims about round trips
 * NOT happening. Asserting on the returned value cannot tell a cache hit from a
 * cache miss that got the same answer, so these tests assert on this log.
 */
function spyOn(mount) {
  const calls = [];
  const spy = Object.create(mount);
  for (const op of ['read', 'write', 'readdir', 'stat', 'mkdir', 'unlink', 'rmdir', 'rename']) {
    spy[op] = (...args) => {
      calls.push(`${op} ${args.filter((a) => typeof a === 'string').join(' -> ')}`.trim());
      return mount[op](...args);
    };
  }
  spy.calls = calls;
  spy.since = (n) => calls.slice(n);
  return spy;
}

/**
 * Stand up the real daemon + the real GPD client, and hand back a real FsMount.
 *
 * `viaRegister` takes the capability through `registerFsMount()` — the shipped
 * authorization path — which needs a real PTY session and therefore node-pty.
 * The default constructs the same `FsMount` class against the same `FsProxy`
 * and the same socket, so the protocol path is identical and the suite runs on a
 * machine whose node-pty will not load. One test below covers the grant itself.
 */
async function harness(t, { agentIds = ['orion-x'], attrTtlMs = 1000, spy = true } = {}) {
  const { RemoteDaemonServer } = require(path.join(DAEMON_SRC, 'server.js'));
  const { TrustedClientStore } = require(path.join(DAEMON_SRC, 'store.js'));
  const { FsMount } = require(path.join(DAEMON_SRC, 'fsproxy.js'));
  const { RemoteDaemonClient } = loadTs('src/main/remoteDaemon.ts');

  const hive = seedHive();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mount-state-'));
  const store = new TrustedClientStore(stateDir);
  const daemonLog = recorder();
  const hostLog = recorder();
  const mountLog = recorder();

  const clientId = `client-${randomBytes(8).toString('hex')}`;
  const secret = randomBytes(32).toString('hex');
  store.add({ clientId, secret, name: 'mount-test' });

  const port = await freePort();
  const server = new RemoteDaemonServer({ host: '127.0.0.1', port, store, logger: daemonLog });
  await server.listen();

  const client = new RemoteDaemonClient({ host: '127.0.0.1', port, clientId, secret });
  client.enableHiveFs(() => hive.agentsRoot, hostLog);
  const connected = await client.connect();
  assert.equal(connected.ok, true, `client failed to authenticate: ${connected.error}`);
  for (const id of agentIds) client.authorizeAgent(id);

  const wsFor = (id) => {
    for (const [ws, state] of server.connections) if (state.clientId === id) return ws;
    return null;
  };
  const ws = wsFor(clientId);
  assert.ok(ws, 'the daemon should have an authenticated socket');

  const realMount = new FsMount(server.fs, ws, 'orion-x');
  const mount = spy ? spyOn(realMount) : realMount;
  const ops = MOUNT.createFsOps({
    mount,
    platform: 'darwin',
    uid: 501,
    gid: 20,
    attrTtlMs,
    logger: mountLog
  });

  t.after(async () => {
    try { client.dispose(); } catch { /* already gone */ }
    try { await server.close(); } catch { /* already down */ }
    for (const dir of [hive.home, stateDir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  return { server, store, hive, client, clientId, secret, port, ws, wsFor, mount, ops, daemonLog, hostLog, mountLog };
}

// ───────────────────────────────────────────────────────────────────────────
// The mock FUSE binding
// ───────────────────────────────────────────────────────────────────────────

/**
 * Invoke one op the way `@cocalc/fuse-native`'s `_op_*` methods do, and return
 * the raw callback arguments.
 *
 * Also enforces two rules the real binding cannot: a callback is invoked exactly
 * ONCE (the native side signals FUSE on the first call and a second one is a
 * use-after-free), and its first argument is a NUMBER. Returning an Error object
 * or `undefined` from a FUSE callback is a whole genre of bug — `signal(err)`
 * passes it straight through to the kernel — and it is invisible unless
 * something asserts on it.
 */
function callOp(ops, name, args) {
  assert.ok(typeof ops[name] === 'function', `the ops object should implement ${name}`);
  return new Promise((resolve, reject) => {
    let count = 0;
    const timer = setTimeout(() => reject(new Error(`${name} never called its callback`)), 20_000);
    const cb = (...cbArgs) => {
      count += 1;
      if (count > 1) {
        clearTimeout(timer);
        return reject(new Error(`${name} called its callback ${count} times`));
      }
      if (typeof cbArgs[0] !== 'number') {
        clearTimeout(timer);
        return reject(new Error(`${name} returned ${typeof cbArgs[0]} (${cbArgs[0]}) where FUSE wants a number`));
      }
      // Let a duplicate call land before resolving, the way the real binding
      // would keep running after signalling.
      setTimeout(() => { clearTimeout(timer); resolve(cbArgs); }, 0);
      return undefined;
    };
    ops[name](...args, cb);
  });
}

/** The syscall-shaped helpers the tests actually use. */
const fuse = {
  async getattr(ops, p) {
    const [rc, stat] = await callOp(ops, 'getattr', [p]);
    return { rc, stat };
  },
  async readdir(ops, p) {
    const [rc, names, stats] = await callOp(ops, 'readdir', [p]);
    return { rc, names, stats };
  },
  async open(ops, p, flags = 0) {
    const [rc, fd] = await callOp(ops, 'open', [p, flags]);
    return { rc, fd };
  },
  async create(ops, p, mode = 0o644) {
    const [rc, fd] = await callOp(ops, 'create', [p, mode]);
    return { rc, fd };
  },
  /** `_op_read` reads the byte count out of the FIRST callback argument. */
  async read(ops, p, fd, len, pos) {
    const buf = Buffer.alloc(len);
    const [n] = await callOp(ops, 'read', [p, fd, buf, len, pos]);
    return { n, buf };
  },
  async write(ops, p, fd, data, pos) {
    const buf = Buffer.from(data);
    const [n] = await callOp(ops, 'write', [p, fd, buf, buf.length, pos]);
    return { n };
  },
  async simple(ops, name, args) {
    const [rc] = await callOp(ops, name, args);
    return rc;
  }
};

/**
 * A stand-in for the `Fuse` class `@cocalc/fuse-native` exports.
 *
 * Only what `mountAgent()` touches: the constructor signature `(mnt, ops, opts)`
 * and a `mount(cb)` that calls back with an error or nothing. Enough to prove
 * the wiring — that a capability handle becomes an ops object that becomes a
 * mounted volume — without a kernel.
 */
function makeMockFuse({ failWith = null } = {}) {
  const instances = [];
  class MockFuse {
    constructor(mnt, ops, opts) {
      this.mnt = mnt;
      this.ops = ops;
      this.opts = opts;
      this.mounted = false;
      instances.push(this);
    }

    mount(cb) {
      if (failWith) return process.nextTick(cb, new Error(failWith));
      this.mounted = true;
      return process.nextTick(cb, null);
    }

    unmount(cb) {
      this.mounted = false;
      return process.nextTick(cb, null);
    }
  }
  MockFuse.instances = instances;
  return MockFuse;
}

// ───────────────────────────────────────────────────────────────────────────
// 1. The errno table
// ───────────────────────────────────────────────────────────────────────────

test('every proxy error code maps to the errno README §8 names, on both platforms',
  { skip: skip || false }, () => {
  const { FS_ERROR_TO_ERRNO, ERRNO_DARWIN, ERRNO_LINUX, errnoForFsError } = MOUNT;
  const { FS_ERRORS } = PROTOCOL;

  // The set is closed (README §8) so the mapping must be exhaustive. A code with
  // no entry would fall through to EIO and nobody would ever notice.
  const codes = Object.values(FS_ERRORS);
  assert.equal(codes.length, 17, 'README §8 documents seventeen error codes');
  for (const code of codes) {
    assert.ok(FS_ERROR_TO_ERRNO[code], `no errno mapped for "${code}"`);
  }
  assert.deepEqual(
    Object.keys(FS_ERROR_TO_ERRNO).sort(), [...codes].sort(),
    'the mapping must cover the protocol codes exactly — no more, no less'
  );

  // The table from README §8, transcribed independently of the implementation.
  const README = {
    not_found: 'ENOENT',
    not_a_directory: 'ENOTDIR',
    is_a_directory: 'EISDIR',
    not_empty: 'ENOTEMPTY',
    exists: 'EEXIST',
    path_escape: 'EACCES',
    unauthorized_agent: 'EACCES',
    agent_not_found: 'ENOENT',
    read_only: 'EROFS',
    permission_denied: 'EACCES',
    too_large: 'EFBIG',
    invalid_request: 'EINVAL',
    unsupported_op: 'ENOSYS',
    busy: 'EAGAIN',
    io_error: 'EIO',
    timeout: 'ETIMEDOUT',
    disconnected: 'ENOTCONN'
  };
  assert.deepEqual(FS_ERROR_TO_ERRNO, README, 'the mapping must match README §8 exactly');

  // Every name resolves on both platforms, and always to a NEGATIVE number.
  for (const [code, name] of Object.entries(README)) {
    for (const platform of ['darwin', 'linux']) {
      const value = errnoForFsError(code, platform);
      assert.ok(Number.isInteger(value) && value < 0, `${code} on ${platform} produced ${value}`);
      const table = platform === 'darwin' ? ERRNO_DARWIN : ERRNO_LINUX;
      assert.equal(value, -table[name], `${code} on ${platform} should be -${name}`);
    }
  }

  // THE POINT OF HAVING TWO TABLES. These are the codes whose numbers differ
  // between Darwin and Linux; using fuse-native's Linux-valued constants on a
  // Mac would return each of the right-hand meanings instead.
  assert.equal(errnoForFsError('not_empty', 'darwin'), -66);
  assert.equal(errnoForFsError('not_empty', 'linux'), -39, 'Linux ENOTEMPTY; on macOS 39 is EDESTADDRREQ');
  assert.equal(errnoForFsError('busy', 'darwin'), -35);
  assert.equal(errnoForFsError('busy', 'linux'), -11, 'Linux EAGAIN; on macOS 11 is EDEADLK');
  assert.equal(errnoForFsError('unsupported_op', 'darwin'), -78);
  assert.equal(errnoForFsError('unsupported_op', 'linux'), -38, 'Linux ENOSYS; on macOS 38 is ENOTSOCK');

  // An independent cross-check of the Darwin column: fuse-native's own index.js
  // hardcodes `IS_OSX ? -57 : -107` for ENOTCONN and `IS_OSX ? -60 : -110` for
  // ETIMEDOUT, precisely because its public constants are Linux's. If this table
  // were wrong, these would disagree with the binding we hand it to.
  assert.equal(errnoForFsError('disconnected', 'darwin'), -57);
  assert.equal(errnoForFsError('disconnected', 'linux'), -107);
  assert.equal(errnoForFsError('timeout', 'darwin'), -60);
  assert.equal(errnoForFsError('timeout', 'linux'), -110);

  // Codes shared by both, so a regression in either table shows up.
  for (const [name, value] of [['ENOENT', 2], ['EACCES', 13], ['EEXIST', 17], ['EISDIR', 21],
    ['ENOTDIR', 20], ['EROFS', 30], ['EFBIG', 27], ['EINVAL', 22], ['EIO', 5]]) {
    assert.equal(ERRNO_DARWIN[name], value, `darwin ${name}`);
    assert.equal(ERRNO_LINUX[name], value, `linux ${name}`);
  }

  // An unknown code (the two protocol copies having drifted — README §13) is
  // EIO, not a crash and not a silent success.
  assert.equal(errnoForFsError('something_new_in_a_later_phase', 'darwin'), -MOUNT.ERRNO_DARWIN.EIO);
});

test('FUSE paths become protocol paths, and unsafe ones never get that far',
  { skip: skip || false }, () => {
  const { toRelPath } = MOUNT;

  assert.deepEqual(toRelPath('/'), { ok: true, rel: '', base: '' });
  assert.deepEqual(toRelPath('/memory.md'), { ok: true, rel: 'memory.md', base: 'memory.md' });
  assert.deepEqual(toRelPath('/inbox/msg-a.json'), { ok: true, rel: 'inbox/msg-a.json', base: 'msg-a.json' });
  assert.deepEqual(toRelPath('/inbox/.done/x.json'), { ok: true, rel: 'inbox/.done/x.json', base: 'x.json' });
  // Redundant separators and '.' segments are normalised, not rejected: the
  // kernel really does hand these down.
  assert.equal(toRelPath('/inbox//msg-a.json').rel, 'inbox/msg-a.json');
  assert.equal(toRelPath('/./inbox/./msg-a.json').rel, 'inbox/msg-a.json');
  assert.equal(toRelPath('/inbox/').rel, 'inbox');

  // README §6: normalise and validate on this side too. A `path_escape` coming
  // back from the GPD means this mount had a bug — so these never travel.
  for (const bad of ['/../../etc/passwd', '/inbox/../../../etc/passwd', '/memory.md:ads',
    '/identity.md.', '/trailing ', `/${'x'.repeat(1100)}`]) {
    const res = toRelPath(bad);
    assert.equal(res.ok, false, `${bad} must not resolve`);
    assert.equal(res.name, 'EACCES', `${bad} should be EACCES`);
  }
  // Not absolute, or not a string at all: the binding misbehaving.
  for (const bad of ['', 'relative/path', null, undefined, 42]) {
    assert.equal(toRelPath(bad).ok, false, `${JSON.stringify(bad)} must not resolve`);
  }
  // A `..` segment is REFUSED rather than resolved, even where resolving it
  // would land back inside the sandbox ('/../../etc/passwd' normalises to
  // '/etc/passwd'). The kernel resolves `..` before calling a filesystem, so
  // nothing legitimate contains one, and the GPD's own gate rejects them — the
  // two must not disagree about the same string.
  for (const dots of ['/..', '/../x', '/inbox/../memory.md', '/a/b/../../c']) {
    const res = toRelPath(dots);
    assert.equal(res.ok, false, `${dots} must be refused, not normalised away`);
    assert.equal(res.name, 'EACCES');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The happy path, against real files
// ───────────────────────────────────────────────────────────────────────────

test('FUSE callbacks round-trip real files: getattr, readdir, open/read, create/write, mkdir, unlink, rmdir, rename',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { ops } = h;

  // ── getattr on the root, a file and a directory ───────────────────────────
  const root = await fuse.getattr(ops, '/');
  assert.equal(root.rc, 0, 'the mount root must stat');
  assert.equal(root.stat.mode & 0o170000, 0o040000, 'the root is a directory');
  assert.equal(root.stat.uid, 501, 'getattr should report the uid it was configured with');
  assert.equal(root.stat.gid, 20);

  const memory = await fuse.getattr(ops, '/memory.md');
  assert.equal(memory.rc, 0);
  assert.equal(memory.stat.mode & 0o170000, 0o100000, 'memory.md is a regular file');
  assert.equal(
    memory.stat.size,
    fs.statSync(path.join(h.hive.agentDir, 'memory.md')).size,
    'getattr must report the real size'
  );
  assert.ok(memory.stat.mtime instanceof Date && memory.stat.mtime.getTime() > 0);
  // The proxy reports `mtimeMs` as a FLOAT (README §5) and a JS Date holds only
  // whole milliseconds, so the sub-millisecond part is lost in the conversion.
  // That is inherent to what FUSE wants, not a bug — but it means this can only
  // ever be asserted to within a millisecond.
  const realMtime = fs.statSync(path.join(h.hive.agentDir, 'memory.md')).mtimeMs;
  assert.ok(
    Math.abs(memory.stat.mtime.getTime() - realMtime) <= 1,
    `getattr must report the real mtime (got ${memory.stat.mtime.getTime()}, disk has ${realMtime})`
  );

  const inbox = await fuse.getattr(ops, '/inbox');
  assert.equal(inbox.stat.mode & 0o170000, 0o040000);
  assert.equal(inbox.stat.nlink, 2, 'a directory reports nlink 2');

  // ── readdir, with the '.' and '..' README §5 says to synthesize ───────────
  const listing = await fuse.readdir(ops, '/inbox');
  assert.equal(listing.rc, 0, 'readdir should succeed');
  assert.equal(listing.names[0], '.', 'readdir must synthesize "."');
  assert.equal(listing.names[1], '..', 'readdir must synthesize ".."');
  assert.deepEqual(listing.names.slice(2).sort(), ['.done', 'msg-a.json', 'msg-b.json']);
  assert.equal(listing.stats.length, listing.names.length,
    'the stats array must be index-aligned with the names array');
  const msgAIndex = listing.names.indexOf('msg-a.json');
  assert.equal(
    listing.stats[msgAIndex].size,
    fs.statSync(path.join(h.hive.agentDir, 'inbox', 'msg-a.json')).size,
    'a readdir stat must carry the real size'
  );
  const doneIndex = listing.names.indexOf('.done');
  assert.equal(listing.stats[doneIndex].mode & 0o170000, 0o040000, '.done is a directory');

  // ── open + read a whole file through the buffer model ─────────────────────
  const onDisk = fs.readFileSync(path.join(h.hive.agentDir, 'memory.md'));
  const opened = await fuse.open(ops, '/memory.md', 0);
  assert.equal(opened.rc, 0, 'open should succeed');
  assert.ok(Number.isInteger(opened.fd) && opened.fd > 0, 'open must return a file descriptor');

  const whole = await fuse.read(ops, '/memory.md', opened.fd, onDisk.length, 0);
  assert.equal(whole.n, onDisk.length, 'a full read returns the byte count');
  assert.ok(whole.buf.subarray(0, whole.n).equals(onDisk), 'the bytes must be exactly what is on disk');

  // Partial reads at an offset, served from the same buffer with no extra
  // round trip — the protocol has no offsets at all (README §11).
  const before = h.mount.calls.length;
  const middle = await fuse.read(ops, '/memory.md', opened.fd, 6, 2);
  assert.equal(middle.n, 6);
  assert.ok(middle.buf.subarray(0, 6).equals(onDisk.subarray(2, 8)));
  const past = await fuse.read(ops, '/memory.md', opened.fd, 16, onDisk.length);
  assert.equal(past.n, 0, 'a read at EOF returns 0, not an error');
  assert.deepEqual(h.mount.since(before), [], 'reads after open must not touch the wire');
  assert.equal(await fuse.simple(ops, 'release', ['/memory.md', opened.fd]), 0);

  // ── create + write + release into outbox/ (the agent's own half) ──────────
  const payload = JSON.stringify({ to: 'god', act: 'inform', body: 'from the mount' });
  const created = await fuse.create(ops, '/outbox/reply-1.json');
  assert.equal(created.rc, 0, 'create in outbox/ should succeed');
  assert.ok(
    fs.existsSync(path.join(h.hive.agentDir, 'outbox', 'reply-1.json')),
    'create must materialise the file immediately, not at release'
  );
  const wrote = await fuse.write(ops, '/outbox/reply-1.json', created.fd, payload, 0);
  assert.equal(wrote.n, payload.length, 'write returns the number of bytes it took');
  assert.equal(await fuse.simple(ops, 'release', ['/outbox/reply-1.json', created.fd]), 0);
  assert.equal(
    fs.readFileSync(path.join(h.hive.agentDir, 'outbox', 'reply-1.json'), 'utf8'), payload,
    'the buffer must reach the GPD\'s disk on release'
  );

  // ── overwriting an existing file ──────────────────────────────────────────
  // The em dash is deliberate: FUSE counts BYTES, not JS string characters, and
  // a mount that returned a character count would under-report every write of
  // any non-ASCII text and silently truncate it.
  const newMemory = '# Memory — Orion (orion-x)\n\nwritten-through-the-mount\n';
  assert.notEqual(newMemory.length, Buffer.byteLength(newMemory), 'the fixture must be multi-byte');
  const w = await fuse.open(ops, '/memory.md', 1 /* O_WRONLY */ | 0x0400 /* O_TRUNC (darwin) */);
  assert.equal(w.rc, 0, 'memory.md is the agent\'s own file and must open for writing');
  assert.equal(
    (await fuse.write(ops, '/memory.md', w.fd, newMemory, 0)).n,
    Buffer.byteLength(newMemory),
    'write must return a byte count'
  );
  assert.equal(await fuse.simple(ops, 'release', ['/memory.md', w.fd]), 0);
  assert.equal(fs.readFileSync(path.join(h.hive.agentDir, 'memory.md'), 'utf8'), newMemory);

  // ── mkdir / rmdir / unlink ────────────────────────────────────────────────
  assert.equal(await fuse.simple(ops, 'mkdir', ['/outbox/drafts', 0o755]), 0);
  assert.ok(fs.statSync(path.join(h.hive.agentDir, 'outbox', 'drafts')).isDirectory());

  const d = await fuse.create(ops, '/outbox/drafts/d1.json');
  assert.equal(d.rc, 0);
  assert.equal(await fuse.simple(ops, 'release', ['/outbox/drafts/d1.json', d.fd]), 0);
  assert.equal(await fuse.simple(ops, 'unlink', ['/outbox/drafts/d1.json']), 0);
  assert.equal(fs.existsSync(path.join(h.hive.agentDir, 'outbox', 'drafts', 'd1.json')), false);
  assert.equal(await fuse.simple(ops, 'rmdir', ['/outbox/drafts']), 0);
  assert.equal(fs.existsSync(path.join(h.hive.agentDir, 'outbox', 'drafts')), false);

  // ── rename: the documented inbox -> inbox/.done move (README §7, §11) ─────
  assert.equal(await fuse.simple(ops, 'rename', ['/inbox/msg-a.json', '/inbox/.done/msg-a.json']), 0);
  assert.equal(fs.existsSync(path.join(h.hive.agentDir, 'inbox', 'msg-a.json')), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(h.hive.agentDir, 'inbox', '.done', 'msg-a.json'), 'utf8')).id,
    'msg-a'
  );

  // A rename destination of '' is a legal PATH but never a legal destination
  // (README §4), and is refused here rather than on the wire.
  assert.equal(await fuse.simple(ops, 'rename', ['/memory.md', '/']), MOUNT.errno('EINVAL', 'darwin'));
  assert.ok(fs.existsSync(path.join(h.hive.agentDir, 'memory.md')));
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Errors → errno, produced by the real thing
// ───────────────────────────────────────────────────────────────────────────

test('every documented failure surfaces as the right macOS errno',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { attrTtlMs: 0 });
  const { ops } = h;
  const E = (name) => MOUNT.errno(name, 'darwin');

  // not_found -> ENOENT
  assert.equal((await fuse.getattr(ops, '/no-such-file.md')).rc, E('ENOENT'));
  assert.equal((await fuse.open(ops, '/no-such-file.md', 0)).rc, E('ENOENT'));
  // ...for a path in the agent's own half of the folder, where the write policy
  // permits the operation and existence is therefore the question being asked.
  assert.equal(await fuse.simple(ops, 'unlink', ['/outbox/never-existed.json']), E('ENOENT'));

  // In a PROTECTED area the answer is EROFS even when the file is not there:
  // the GPD checks the write policy (README §7) before it checks existence, so
  // `rm /mnt/hive/orion-x/nope/none.md` reports "read-only file system" rather
  // than "no such file". That is deliberate on the GPD's side — the policy is
  // default-deny and a differing error would let a caller probe which
  // harness-owned paths exist — and this mount must pass it through unchanged
  // rather than "helpfully" rewriting it to ENOENT.
  assert.equal(await fuse.simple(ops, 'unlink', ['/nope/none.md']), E('EROFS'));

  // is_a_directory -> EISDIR. `open` catches it locally off the stat; `unlink`
  // gets it from the GPD — but only where the write policy permits the unlink
  // at all, since the policy is evaluated first (see the EROFS note above).
  assert.equal((await fuse.open(ops, '/inbox', 0)).rc, E('EISDIR'));
  assert.equal(await fuse.simple(ops, 'mkdir', ['/outbox/adir', 0o755]), 0);
  assert.equal(await fuse.simple(ops, 'unlink', ['/outbox/adir']), E('EISDIR'));
  assert.equal(await fuse.simple(ops, 'rmdir', ['/outbox/adir']), 0);
  // ...whereas the same call on a protected directory is EROFS: `inbox/.done`
  // is the agent's to fill and never its to delete (README §7).
  assert.equal(await fuse.simple(ops, 'unlink', ['/inbox/.done']), E('EROFS'));

  // not_a_directory -> ENOTDIR
  assert.equal((await fuse.readdir(ops, '/identity.md')).rc, E('ENOTDIR'));

  // exists -> EEXIST
  assert.equal(await fuse.simple(ops, 'mkdir', ['/outbox/.sent', 0o755]), E('EEXIST'));

  // not_empty -> ENOTEMPTY (66 on darwin, and the reason two tables exist)
  assert.equal(await fuse.simple(ops, 'rmdir', ['/outbox']), E('EROFS'),
    'outbox/ itself is protected by the write policy before emptiness matters');
  assert.equal(await fuse.simple(ops, 'mkdir', ['/outbox/tmpdir', 0o755]), 0);
  const inner = await fuse.create(ops, '/outbox/tmpdir/keep.json');
  assert.equal(await fuse.simple(ops, 'release', ['/outbox/tmpdir/keep.json', inner.fd]), 0);
  const notEmpty = await fuse.simple(ops, 'rmdir', ['/outbox/tmpdir']);
  assert.equal(notEmpty, E('ENOTEMPTY'));
  assert.equal(notEmpty, -66, 'ENOTEMPTY is 66 on macOS, not the 39 fuse-native\'s constants would give');

  // read_only -> EROFS, straight out of the hive write policy (README §7)
  for (const target of ['/identity.md', '/cursor.json', '/inbox/forged.json', '/new-top-level.md']) {
    const rc = await fuse.simple(ops, 'unlink', [target]);
    assert.ok(rc < 0, `${target} must not be unlinkable`);
  }
  assert.equal(await fuse.simple(ops, 'mkdir', ['/newdir', 0o755]), E('EROFS'),
    'the agent root is default-deny');
  assert.equal(await fuse.simple(ops, 'rename', ['/memory.md', '/identity.md']), E('EROFS'),
    'a rename may not launder a writable file into a protected name');
  assert.ok(fs.existsSync(path.join(h.hive.agentDir, 'identity.md')));

  // A create the policy forbids fails AT CREATE, not silently at release — the
  // point of materialising an empty file immediately.
  const forged = await fuse.create(ops, '/inbox/forged.json');
  assert.equal(forged.rc, E('EROFS'), 'creating in inbox/ is the router\'s job (README §11)');
  assert.equal(fs.existsSync(path.join(h.hive.agentDir, 'inbox', 'forged.json')), false);

  // too_large -> EFBIG, caught at OPEN from the stat, before any read is
  // attempted (README §10).
  const before = h.mount.calls.length;
  assert.equal((await fuse.open(ops, '/outbox/huge.bin', 0)).rc, E('EFBIG'));
  assert.deepEqual(
    h.mount.since(before).filter((c) => c.startsWith('read')), [],
    'a too-large file must never be read — the stat already said how big it is'
  );

  // path_escape -> EACCES. Refused locally, so nothing reaches the wire at all.
  const beforeEscape = h.mount.calls.length;
  for (const attack of ['/../orion-x-evil/secret.txt', '/inbox/../../../outside-secret.txt',
    '/memory.md:ads', '/identity.md.']) {
    assert.equal((await fuse.getattr(ops, attack)).rc, E('EACCES'), `${attack} must be EACCES`);
  }
  assert.deepEqual(h.mount.since(beforeEscape), [],
    'README §6: a path this mount knows is unsafe must not travel');
  assert.equal(
    fs.readFileSync(path.join(h.hive.evilDir, 'secret.txt'), 'utf8'), 'SIBLING-AGENT-SECRET',
    'the sibling agent folder is untouched'
  );

  // unauthorized_agent -> EACCES, for a real agent folder we were not granted.
  const { FsMount } = require(path.join(DAEMON_SRC, 'fsproxy.js'));
  const evilOps = MOUNT.createFsOps({
    mount: new FsMount(h.server.fs, h.ws, 'orion-x-evil'),
    platform: 'darwin',
    attrTtlMs: 0,
    logger: recorder()
  });
  assert.equal((await fuse.getattr(evilOps, '/secret.txt')).rc, E('EACCES'));
  assert.equal((await fuse.readdir(evilOps, '/')).rc, E('EACCES'));
});

test('unsupported_op, timeout and disconnected each reach the syscall as their own errno',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { attrTtlMs: 0 });
  const { FsMount, FsProxy } = require(path.join(DAEMON_SRC, 'fsproxy.js'));
  const { RemoteDaemonClient } = loadTs('src/main/remoteDaemon.ts');
  const E = (name) => MOUNT.errno(name, 'darwin');

  // ── unsupported_op -> ENOSYS. A client that never called enableHiveFs()
  //    answers nothing at all, which is the default for every existing remote
  //    environment (README §2).
  const plain = new RemoteDaemonClient({
    host: '127.0.0.1', port: h.port, clientId: h.clientId, secret: h.secret
  });
  t.after(() => { try { plain.dispose(); } catch { /* already gone */ } });
  assert.equal(plain.isHiveFsEnabled, false);
  assert.equal((await plain.connect()).ok, true);
  const plainWs = [...h.server.connections.keys()].find((w) => w !== h.ws);
  assert.ok(plainWs, 'the daemon should see the second socket');
  const plainOps = MOUNT.createFsOps({
    mount: new FsMount(h.server.fs, plainWs, 'orion-x'),
    platform: 'darwin', attrTtlMs: 0, logger: recorder()
  });
  assert.equal((await fuse.getattr(plainOps, '/memory.md')).rc, E('ENOSYS'));
  assert.equal(-78, E('ENOSYS'), 'ENOSYS is 78 on macOS, not the 38 Linux uses');

  // ── timeout -> ETIMEDOUT. A second FsProxy sends on the real socket, the real
  //    client really answers — but the reply is routed to the SERVER's proxy,
  //    which has never heard of the reqId, so this one's deadline is what fires.
  //    Real code, real socket, real deadline; only the clock is impatient.
  const slowProxy = new FsProxy({ timeoutMs: 150, logger: recorder() });
  const slowOps = MOUNT.createFsOps({
    mount: new FsMount(slowProxy, h.ws, 'orion-x'),
    platform: 'darwin', attrTtlMs: 0, logger: recorder()
  });
  const timedOut = await fuse.getattr(slowOps, '/memory.md');
  assert.equal(timedOut.rc, E('ETIMEDOUT'), 'a deadline must become ETIMEDOUT, not a hang');
  assert.equal(timedOut.rc, -60, 'ETIMEDOUT is 60 on macOS');

  // ── disconnected -> ENOTCONN. README §11: fail the syscall, do not block.
  h.client.dispose();
  for (let i = 0; i < 100 && h.server.connections.has(h.ws); i += 1) await sleep(20);
  assert.equal(h.server.connections.has(h.ws), false, 'the daemon should have dropped the socket');

  const started = Date.now();
  const gone = await fuse.getattr(h.ops, '/memory.md');
  assert.equal(gone.rc, E('ENOTCONN'));
  assert.equal(gone.rc, -57, 'ENOTCONN is 57 on macOS');
  assert.ok(Date.now() - started < 2000, 'a dead link must fail immediately, not wait out the deadline');
  assert.equal((await fuse.readdir(h.ops, '/')).rc, E('ENOTCONN'));
  assert.equal(await fuse.simple(h.ops, 'unlink', ['/outbox/x.json']), E('ENOTCONN'));
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The whole-file buffer model (README §11)
// ───────────────────────────────────────────────────────────────────────────

test('there are no offsets on the wire: an edit is buffered and written exactly once',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { ops } = h;
  const file = '/outbox/doc.txt';
  const onDisk = path.join(h.hive.agentDir, 'outbox', 'doc.txt');

  const created = await fuse.create(ops, file);
  assert.equal(created.rc, 0);
  const fd = created.fd;

  // Three writes at three offsets, the way a real writer dribbles a file out.
  const before = h.mount.calls.length;
  assert.equal((await fuse.write(ops, file, fd, 'HELLO', 0)).n, 5);
  assert.equal((await fuse.write(ops, file, fd, ' WORLD', 5)).n, 6);
  assert.equal((await fuse.write(ops, file, fd, '!', 11)).n, 1);
  assert.deepEqual(h.mount.since(before), [], 'writes are buffered, not sent');
  assert.equal(fs.readFileSync(onDisk, 'utf8'), '', 'nothing has reached the GPD yet');

  // ...and exactly one `write` op when it is flushed.
  const beforeFlush = h.mount.calls.length;
  assert.equal(await fuse.simple(ops, 'flush', [file, fd]), 0);
  const flushed = h.mount.since(beforeFlush);
  assert.equal(flushed.length, 1, `one write per flush, got ${JSON.stringify(flushed)}`);
  assert.ok(flushed[0].startsWith('write '));
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'HELLO WORLD!');

  // A second flush with nothing dirty writes nothing at all — otherwise every
  // close(2) of an unmodified file would be a round trip.
  const beforeClean = h.mount.calls.length;
  assert.equal(await fuse.simple(ops, 'flush', [file, fd]), 0);
  assert.equal(await fuse.simple(ops, 'fsync', [file, false, fd]), 0);
  assert.equal(await fuse.simple(ops, 'release', [file, fd]), 0);
  assert.deepEqual(h.mount.since(beforeClean), [], 'a clean handle must not be rewritten');

  // A write past EOF grows the file and zero-fills the gap, like write(2) does.
  const reopened = await fuse.open(ops, file, 2 /* O_RDWR */);
  assert.equal(reopened.rc, 0);
  assert.equal((await fuse.write(ops, file, reopened.fd, 'X', 15)).n, 1);
  // fgetattr must see the buffer's length, not the length the GPD still has.
  const [fgRc, fgStat] = await callOp(ops, 'fgetattr', [file, reopened.fd]);
  assert.equal(fgRc, 0);
  assert.equal(fgStat.size, 16, 'fgetattr must report the in-flight size');
  assert.equal(await fuse.simple(ops, 'release', [file, reopened.fd]), 0);
  const grown = fs.readFileSync(onDisk);
  assert.equal(grown.length, 16);
  assert.equal(grown.subarray(0, 12).toString('utf8'), 'HELLO WORLD!');
  assert.deepEqual([...grown.subarray(12, 15)], [0, 0, 0], 'the gap must be zero-filled');
  assert.equal(grown[15], 0x58);

  // ftruncate with the file open is a buffer resize; the single write still
  // happens at flush, which is the `truncate(0) + write` model of README §11.
  const trunc = await fuse.open(ops, file, 2);
  assert.equal(await fuse.simple(ops, 'ftruncate', [file, trunc.fd, 5]), 0);
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'HELLO WORLD!' + '\0'.repeat(3) + 'X',
    'a resize is buffered, not written through');
  assert.equal(await fuse.simple(ops, 'release', [file, trunc.fd]), 0);
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'HELLO', 'and lands on release');

  // With NOTHING open, truncate(0) is a single empty write and no read at all —
  // there is nothing worth fetching just to throw it away.
  const beforeTrunc = h.mount.calls.length;
  assert.equal(await fuse.simple(ops, 'truncate', [file, 0]), 0);
  assert.deepEqual(h.mount.since(beforeTrunc).filter((c) => c.startsWith('read')), [],
    'truncate to zero needs no read');
  assert.equal(fs.readFileSync(onDisk, 'utf8'), '');

  // ...whereas a truncate to a NON-zero size with nothing open is a genuine
  // read-modify-write, because the protocol has no way to shorten a file in
  // place (README §12).
  const rw = await fuse.open(ops, file, 2);
  assert.equal((await fuse.write(ops, file, rw.fd, 'abcdefgh', 0)).n, 8);
  assert.equal(await fuse.simple(ops, 'release', [file, rw.fd]), 0);
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'abcdefgh');

  const beforeRmw = h.mount.calls.length;
  assert.equal(await fuse.simple(ops, 'truncate', [file, 3]), 0);
  const rmw = h.mount.since(beforeRmw);
  assert.equal(rmw.filter((c) => c.startsWith('read')).length, 1, 'one read...');
  assert.equal(rmw.filter((c) => c.startsWith('write')).length, 1, '...and one write');
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'abc');

  // A stale descriptor is EBADF, not a crash.
  assert.equal((await fuse.read(ops, file, 999999, 4, 0)).n, MOUNT.errno('EBADF', 'darwin'));
  assert.equal((await fuse.write(ops, file, 999999, 'x', 0)).n, MOUNT.errno('EBADF', 'darwin'));
});

test('a write that the GPD refuses fails the flush, and the handle stays dirty',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { ops } = h;

  // memory.md is writable, so the open succeeds and the buffer fills...
  const w = await fuse.open(ops, '/memory.md', 2);
  assert.equal(w.rc, 0);
  assert.equal((await fuse.write(ops, '/memory.md', w.fd, 'edited', 0)).n, 6);

  // ...and then the file is renamed out from under it on the GPD's disk, so the
  // flush's write lands on a path the policy now refuses. The syscall must
  // report that, not swallow it: flush(2) is where a save learns it failed.
  const agentDir = h.hive.agentDir;
  fs.renameSync(path.join(agentDir, 'memory.md'), path.join(agentDir, 'memory.md.bak'));
  fs.mkdirSync(path.join(agentDir, 'memory.md'));

  const rc = await fuse.simple(ops, 'flush', ['/memory.md', w.fd]);
  assert.ok(rc < 0, `a refused write must fail the flush, got ${rc}`);

  // The bytes are still in the buffer: a failed flush that cleared the dirty
  // flag would lose the user's edit at release() time without a word.
  fs.rmdirSync(path.join(agentDir, 'memory.md'));
  fs.renameSync(path.join(agentDir, 'memory.md.bak'), path.join(agentDir, 'memory.md'));
  assert.equal(await fuse.simple(ops, 'flush', ['/memory.md', w.fd]), 0,
    'the retry must still have the data to write');
  assert.equal(fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf8').slice(0, 6), 'edited');
});

// ───────────────────────────────────────────────────────────────────────────
// 5. stat.writable (README §5, §7, §11)
// ───────────────────────────────────────────────────────────────────────────

test('stat.writable becomes mode bits, and a write-open is refused locally',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { ops } = h;

  // README §5: writable === false -> 0o444 for files, 0o555 for directories.
  for (const readOnly of ['/identity.md', '/cursor.json']) {
    const st = await fuse.getattr(ops, readOnly);
    assert.equal(st.rc, 0, `${readOnly} must still be readable`);
    assert.equal(st.stat.mode & 0o777, 0o444, `${readOnly} should be reported 0444`);
  }
  for (const readOnlyDir of ['/inbox', '/outbox', '/inbox/.done']) {
    const st = await fuse.getattr(ops, readOnlyDir);
    assert.equal(st.stat.mode & 0o777, 0o555, `${readOnlyDir} should be reported 0555`);
  }
  // The agent's own half is reported writable.
  assert.equal((await fuse.getattr(ops, '/memory.md')).stat.mode & 0o777, 0o644);

  // README §5: "fail write opens with EACCES locally, instead of letting a write
  // travel to the GPD only to come back read_only."
  const before = h.mount.calls.length;
  for (const flags of [1 /* O_WRONLY */, 2 /* O_RDWR */]) {
    const res = await fuse.open(ops, '/identity.md', flags);
    assert.equal(res.rc, MOUNT.errno('EACCES', 'darwin'), 'a write-open of identity.md must be EACCES');
  }
  assert.deepEqual(
    h.mount.since(before).filter((c) => c.startsWith('write')), [],
    'no write may travel for a file the stat already said is read-only'
  );
  // ...and reading it is still fine, exactly as a local agent could.
  assert.equal((await fuse.open(ops, '/identity.md', 0)).rc, 0);

  // A cache entry primed by readdir has NO writable field, and must not be
  // allowed to authorise a write. The refresh is the whole point.
  const fresh = await harness(t, { attrTtlMs: 60_000 });
  await fuse.readdir(fresh.ops, '/');
  const primed = fresh.mount.calls.length;
  // getattr is answered from the listing: no round trip.
  const cached = await fuse.getattr(fresh.ops, '/identity.md');
  assert.equal(cached.rc, 0);
  assert.deepEqual(fresh.mount.since(primed), [], 'getattr should be served from the readdir');
  // ...but an open-for-write forces a real stat, and then refuses.
  const opened = await fuse.open(fresh.ops, '/identity.md', 1);
  assert.equal(opened.rc, MOUNT.errno('EACCES', 'darwin'),
    'a listing-primed entry must never authorise a write');
  assert.ok(
    fresh.mount.since(primed).some((c) => c.startsWith('stat')),
    'open-for-write must refresh the attribute rather than trust the listing'
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 6. The attribute cache (README §11)
// ───────────────────────────────────────────────────────────────────────────

test('getattr is cached for a TTL, primed by readdir, and invalidated by our own writes',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  let clock = 1_000_000;
  const h = await harness(t, { spy: true, attrTtlMs: 1000 });
  // Rebuild the ops with an injectable clock so the TTL can be tested without
  // sleeping through it.
  const ops = MOUNT.createFsOps({
    mount: h.mount, platform: 'darwin', attrTtlMs: 1000, now: () => clock, logger: recorder()
  });

  // First getattr is a miss, second is a hit.
  const a = h.mount.calls.length;
  assert.equal((await fuse.getattr(ops, '/memory.md')).rc, 0);
  assert.equal(h.mount.since(a).length, 1, 'the first getattr must ask');
  const b = h.mount.calls.length;
  assert.equal((await fuse.getattr(ops, '/memory.md')).rc, 0);
  assert.deepEqual(h.mount.since(b), [], 'a getattr inside the TTL must not ask again');

  // ...and a miss again once the TTL is past.
  clock += 1001;
  const c = h.mount.calls.length;
  assert.equal((await fuse.getattr(ops, '/memory.md')).rc, 0);
  assert.equal(h.mount.since(c).length, 1, 'the TTL must actually expire');

  // README §11: readdir's sizes and mtimes prime the cache, so `ls -l` is one
  // round trip and not one per entry.
  const d = h.mount.calls.length;
  const listing = await fuse.readdir(ops, '/inbox');
  assert.equal(listing.rc, 0);
  assert.equal(h.mount.since(d).length, 1, 'readdir is one call');
  const e = h.mount.calls.length;
  for (const name of ['msg-a.json', 'msg-b.json', '.done']) {
    assert.equal((await fuse.getattr(ops, `/inbox/${name}`)).rc, 0, `${name} should stat`);
  }
  assert.deepEqual(h.mount.since(e), [],
    'every getattr after a readdir must come from the listing');
  assert.equal(
    (await fuse.getattr(ops, '/inbox/msg-a.json')).stat.size,
    fs.statSync(path.join(h.hive.agentDir, 'inbox', 'msg-a.json')).size,
    'the primed size must be the real one'
  );

  // A negative answer is cached too — Finder asks about the same missing things
  // over and over — and one round trip is enough to establish it.
  const f = h.mount.calls.length;
  assert.equal((await fuse.getattr(ops, '/ghost.md')).rc, MOUNT.errno('ENOENT', 'darwin'));
  assert.equal(h.mount.since(f).length, 1);
  const g = h.mount.calls.length;
  assert.equal((await fuse.getattr(ops, '/ghost.md')).rc, MOUNT.errno('ENOENT', 'darwin'));
  assert.deepEqual(h.mount.since(g), [], 'a remembered absence must not be re-asked inside the TTL');

  // OUR OWN WRITES INVALIDATE. There is no change notification in this protocol
  // (README §12), so a stale size after a write we performed would be a bug we
  // caused, not one the GPD could tell us about.
  const created = await fuse.create(ops, '/outbox/fresh.json');
  assert.equal(created.rc, 0);
  assert.equal((await fuse.write(ops, '/outbox/fresh.json', created.fd, '{"n":1}', 0)).n, 7);
  assert.equal(await fuse.simple(ops, 'release', ['/outbox/fresh.json', created.fd]), 0);
  const after = await fuse.getattr(ops, '/outbox/fresh.json');
  assert.equal(after.rc, 0);
  assert.equal(after.stat.size, 7, 'a write must invalidate the size it just changed');

  // ...and an unlink invalidates the entry rather than leaving a ghost behind.
  assert.equal(await fuse.simple(ops, 'unlink', ['/outbox/fresh.json']), 0);
  assert.equal((await fuse.getattr(ops, '/outbox/fresh.json')).rc, MOUNT.errno('ENOENT', 'darwin'));

  // A rename invalidates both ends.
  assert.equal(await fuse.simple(ops, 'rename', ['/inbox/msg-b.json', '/inbox/.done/msg-b.json']), 0);
  assert.equal((await fuse.getattr(ops, '/inbox/msg-b.json')).rc, MOUNT.errno('ENOENT', 'darwin'));
  assert.equal((await fuse.getattr(ops, '/inbox/.done/msg-b.json')).rc, 0);

  // With the TTL off, nothing is remembered at all.
  const uncached = MOUNT.createFsOps({ mount: h.mount, platform: 'darwin', attrTtlMs: 0, logger: recorder() });
  const i = h.mount.calls.length;
  await fuse.getattr(uncached, '/memory.md');
  await fuse.getattr(uncached, '/memory.md');
  assert.equal(h.mount.since(i).length, 2, 'attrTtlMs: 0 must disable the cache');
});

// ───────────────────────────────────────────────────────────────────────────
// 7. Back-pressure, sidecars, and the guard rails
// ───────────────────────────────────────────────────────────────────────────

test('`busy` is retried with backoff rather than failed at the syscall (README §11)',
  { skip: skip || false, timeout: 60_000 }, async () => {
  const { FS_ERRORS } = PROTOCOL;

  // A hand-built FsMount-shaped object: this is the one place a real daemon
  // cannot be provoked into `busy` on demand without 64 concurrent requests.
  let attempts = 0;
  const flaky = {
    agentId: 'orion-x',
    read: async () => ({ ok: true, data: Buffer.alloc(0) }),
    write: async () => ({ ok: true }),
    readdir: async () => ({ ok: true, entries: [] }),
    mkdir: async () => ({ ok: true }),
    unlink: async () => ({ ok: true }),
    rmdir: async () => ({ ok: true }),
    rename: async () => ({ ok: true }),
    stat: async () => {
      attempts += 1;
      if (attempts <= 3) return { ok: false, error: FS_ERRORS.BUSY };
      return { ok: true, stat: { type: 'file', size: 4, mtimeMs: 1, ctimeMs: 1, birthtimeMs: 1, writable: true } };
    }
  };

  const ops = MOUNT.createFsOps({
    mount: flaky, platform: 'darwin', attrTtlMs: 0,
    busyRetries: 5, busyBaseDelayMs: 1, logger: recorder()
  });
  const started = Date.now();
  const res = await fuse.getattr(ops, '/memory.md');
  assert.equal(res.rc, 0, 'a transient busy must not reach the syscall');
  assert.equal(attempts, 4, 'three refusals, then the answer');
  assert.equal(ops._internals.stats.busyRetries, 3);
  // 1 + 2 + 4 ms of backoff, so it waited rather than spinning.
  assert.ok(Date.now() - started >= 6, 'the retries must actually back off');

  // ...and a permanent busy eventually gives up with EAGAIN rather than looping.
  attempts = -1000;
  const stubborn = MOUNT.createFsOps({
    mount: flaky, platform: 'darwin', attrTtlMs: 0,
    busyRetries: 2, busyBaseDelayMs: 1, logger: recorder()
  });
  const gaveUp = await fuse.getattr(stubborn, '/memory.md');
  assert.equal(gaveUp.rc, MOUNT.errno('EAGAIN', 'darwin'));
  assert.equal(gaveUp.rc, -35, 'EAGAIN is 35 on macOS, not the 11 Linux uses');
});

test('macOS sidecar probes are answered locally, without a frame on the wire',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { attrTtlMs: 0 });
  const { ops } = h;
  const E = (name) => MOUNT.errno(name, 'darwin');

  // FUSE-T creates these regardless of `noappledouble` (its issues #59, #81), so
  // suppressing them is this mount's job. Every one would otherwise be a round
  // trip ending in read_only against a default-deny agent root.
  const before = h.mount.calls.length;
  for (const junk of ['/.DS_Store', '/inbox/.DS_Store', '/._memory.md', '/.Spotlight-V100',
    '/.fseventsd', '/.Trashes', '/inbox/._msg-a.json', '/.localized']) {
    assert.equal((await fuse.getattr(ops, junk)).rc, E('ENOENT'), `${junk} should be absent`);
    assert.equal((await fuse.open(ops, junk, 0)).rc, E('ENOENT'));
  }
  // EPERM, not EACCES: Finder retries an EACCES .DS_Store and gives up on EPERM.
  assert.equal((await fuse.create(ops, '/.DS_Store')).rc, E('EPERM'));
  assert.equal(await fuse.simple(ops, 'mkdir', ['/.Trashes', 0o755]), E('EPERM'));
  assert.deepEqual(h.mount.since(before), [], 'not one sidecar probe may reach the GPD');
  assert.ok(ops._internals.stats.sidecarsFiltered > 0);

  // A real file whose name merely looks unusual is NOT filtered.
  assert.equal(MOUNT.isMacosSidecar('memory.md'), false);
  assert.equal(MOUNT.isMacosSidecar('.done'), false, '.done is a real hive directory');
  assert.equal(MOUNT.isMacosSidecar('.gitignore'), false);
  assert.equal(MOUNT.isMacosSidecar('.claude'), false);
  assert.equal(MOUNT.isMacosSidecar('.DS_Store'), true);
  assert.equal(MOUNT.isMacosSidecar('._x'), true);

  // The filter is removable, and then the probes do travel.
  const unfiltered = MOUNT.createFsOps({
    mount: h.mount, platform: 'darwin', attrTtlMs: 0, filterMacosSidecars: false, logger: recorder()
  });
  const beforeUnfiltered = h.mount.calls.length;
  await fuse.getattr(unfiltered, '/.DS_Store');
  assert.equal(h.mount.since(beforeUnfiltered).length, 1, '--no-sidecar-filter must really disable it');
});

test('--read-only refuses every mutation locally, and still reads',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t, { attrTtlMs: 0 });
  const ro = MOUNT.createFsOps({
    mount: h.mount, platform: 'darwin', attrTtlMs: 0, readOnly: true, logger: recorder()
  });
  const EROFS = MOUNT.errno('EROFS', 'darwin');

  // Reads are untouched — the point is inspection without risk.
  assert.equal((await fuse.getattr(ro, '/memory.md')).rc, 0);
  assert.equal((await fuse.readdir(ro, '/inbox')).rc, 0);
  const opened = await fuse.open(ro, '/memory.md', 0);
  assert.equal(opened.rc, 0, 'a read-only open must still work');
  assert.ok((await fuse.read(ro, '/memory.md', opened.fd, 4096, 0)).n > 0);
  assert.equal(await fuse.simple(ro, 'release', ['/memory.md', opened.fd]), 0);

  // ...and every mutation is refused before it can travel, including for paths
  // the GPD's own policy would happily allow.
  const before = h.mount.calls.length;
  assert.equal((await fuse.open(ro, '/memory.md', 2)).rc, EROFS, 'a write-open is refused');
  assert.equal((await fuse.create(ro, '/outbox/nope.json')).rc, EROFS);
  assert.equal(await fuse.simple(ro, 'mkdir', ['/outbox/nope', 0o755]), EROFS);
  assert.equal(await fuse.simple(ro, 'unlink', ['/outbox/huge.bin']), EROFS);
  assert.equal(await fuse.simple(ro, 'rmdir', ['/outbox/.sent']), EROFS);
  assert.equal(await fuse.simple(ro, 'rename', ['/inbox/msg-a.json', '/inbox/.done/msg-a.json']), EROFS);
  assert.equal(await fuse.simple(ro, 'truncate', ['/memory.md', 0]), EROFS);
  assert.deepEqual(h.mount.since(before), [], 'not one mutation may reach the GPD');

  // Nothing on disk moved.
  assert.ok(fs.existsSync(path.join(h.hive.agentDir, 'inbox', 'msg-a.json')));
  assert.ok(fs.existsSync(path.join(h.hive.agentDir, 'outbox', 'huge.bin')));
  assert.equal(fs.existsSync(path.join(h.hive.agentDir, 'outbox', 'nope.json')), false);
  assert.ok(fs.readFileSync(path.join(h.hive.agentDir, 'memory.md'), 'utf8').length > 0);

  // The same mount WITHOUT the flag can do all of it, so the test has teeth.
  assert.equal((await fuse.create(h.ops, '/outbox/yes.json')).rc, 0);
});

test('operations the protocol does not have fail honestly instead of lying',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);
  const { ops } = h;

  // README §12 lists chmod/chown as absent. Returning 0 would tell a user they
  // had changed the write policy — which lives on the GPD and did not move.
  assert.equal(await fuse.simple(ops, 'chmod', ['/memory.md', 0o777]), MOUNT.errno('ENOSYS', 'darwin'));
  assert.equal(await fuse.simple(ops, 'chown', ['/memory.md', 501, 20]), MOUNT.errno('ENOSYS', 'darwin'));

  // utimens is the deliberate exception: `touch` and every editor's atomic-save
  // dance call it, and failing it turns a good save into a visible error over
  // metadata nothing here depends on.
  assert.equal(await fuse.simple(ops, 'utimens', ['/memory.md', new Date(), new Date()]), 0);

  // statfs is synthesised locally — there is no statfs op (README §12) and a
  // volume that reports nothing looks broken in Finder.
  const before = h.mount.calls.length;
  const [rc, st] = await callOp(ops, 'statfs', ['/']);
  assert.equal(rc, 0);
  assert.ok(st.bsize > 0 && st.blocks > 0 && st.namemax >= 255);
  assert.deepEqual(h.mount.since(before), [], 'statfs must not go on the wire');
});

// ───────────────────────────────────────────────────────────────────────────
// 8. Wiring: capability -> ops -> binding
// ───────────────────────────────────────────────────────────────────────────

test('mountAgent hands the ops object to the binding and reports what happened',
  { skip: skip || false, timeout: 60_000 }, async (t) => {
  const h = await harness(t);

  const MockFuse = makeMockFuse();
  const mounted = await MOUNT.mountAgent({
    mount: h.mount,
    mountpoint: '/tmp/hive-orion-x',
    Fuse: MockFuse,
    platform: 'darwin',
    logger: recorder()
  });
  assert.equal(mounted.ok, true, `mountAgent failed: ${mounted.error}`);
  assert.equal(MockFuse.instances.length, 1);
  const instance = MockFuse.instances[0];
  assert.equal(instance.mnt, '/tmp/hive-orion-x');
  assert.equal(instance.mounted, true, 'mount(cb) must have been called and succeeded');
  // The options a wedged FUSE-T volume needs to be recoverable.
  assert.equal(instance.opts.force, true, 'a stale mountpoint must be forced');
  assert.equal(instance.opts.mkdir, true);
  assert.match(instance.opts.displayFolder, /orion-x/);
  assert.match(instance.opts.fsname, /orion-x/);

  // The ops handed to the binding are live against the real daemon.
  const st = await fuse.getattr(instance.ops, '/memory.md');
  assert.equal(st.rc, 0, 'the ops the binding received must really work');
  assert.equal(st.stat.size, fs.statSync(path.join(h.hive.agentDir, 'memory.md')).size);

  // A mount failure is returned, not thrown — the CLI has to print it.
  const failing = await MOUNT.mountAgent({
    mount: h.mount,
    mountpoint: '/tmp/hive-orion-x',
    Fuse: makeMockFuse({ failWith: 'fuse-t is not installed' }),
    logger: recorder()
  });
  assert.equal(failing.ok, false);
  assert.match(failing.error, /fuse-t is not installed/);
});

test('registerFsMount grants the capability the ops object then drives, and release revokes it',
  { skip: skip || ptyUnavailable() || false, timeout: 90_000 }, async (t) => {
  const h = await harness(t, { spy: false });
  const isWin = process.platform === 'win32';

  // The real authorization path (README §9): a mount may only address an agent
  // whose PTY session this connection's paired client spawned.
  const spawned = await h.client.spawn({
    id: 'remote-orion',
    command: isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    args: [], cols: 80, rows: 24
  });
  assert.equal(spawned.ok, true, `spawn failed: ${spawned.error}`);
  t.after(() => { try { h.client.kill('remote-orion'); } catch { /* already gone */ } });

  const granted = h.server.registerFsMount(h.ws, { agentId: 'orion-x', sessionId: 'remote-orion' });
  assert.equal(granted.ok, true, `mount refused: ${granted.error}`);

  const ops = MOUNT.createFsOps({ mount: granted.mount, platform: 'darwin', attrTtlMs: 0, logger: recorder() });
  const st = await fuse.getattr(ops, '/memory.md');
  assert.equal(st.rc, 0, 'a granted capability must drive a working filesystem');

  const opened = await fuse.open(ops, '/memory.md', 0);
  assert.equal(opened.rc, 0);
  const read = await fuse.read(ops, '/memory.md', opened.fd, 4096, 0);
  assert.match(read.buf.subarray(0, read.n).toString('utf8'), /seeded-memory-line/);
  assert.equal(await fuse.simple(ops, 'release', ['/memory.md', opened.fd]), 0);

  // Releasing the handle stops the filesystem, and it says EACCES rather than
  // hanging or pretending the files vanished.
  granted.mount.release();
  assert.equal((await fuse.getattr(ops, '/memory.md')).rc, MOUNT.errno('EACCES', 'darwin'));
  assert.equal((await fuse.readdir(ops, '/')).rc, MOUNT.errno('EACCES', 'darwin'));
});

// ───────────────────────────────────────────────────────────────────────────
// 9. The CLI
// ───────────────────────────────────────────────────────────────────────────

test('the CLI parses its arguments and refuses an incomplete invocation',
  { skip: skip || false }, () => {
  const { parseArgs } = MOUNT;

  const full = parseArgs([
    '--host', '100.64.0.2', '--port', '8722',
    '--client-id', 'client-abc', '--secret', 'deadbeef',
    '--agent-id', 'orion-x', '--session-id', 'remote-orion',
    '--mountpoint', '/Users/me/hive'
  ]);
  assert.equal(full.host, '100.64.0.2');
  assert.equal(full.port, 8722);
  assert.equal(full.clientId, 'client-abc');
  assert.equal(full.secret, 'deadbeef');
  assert.equal(full.agentId, 'orion-x');
  assert.equal(full.sessionId, 'remote-orion');
  assert.equal(full.mountpoint, '/Users/me/hive');
  assert.equal(full.sidecarFilter, true, 'the sidecar filter is on by default');
  assert.equal(full.waitSeconds, 120);

  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--print-impl']).printImpl, true);

  // Every required flag is required. --session-id included: registerFsMount will
  // not grant a capability without it (README §9), so a CLI that made it
  // optional could only ever fail later and less clearly.
  const required = ['--host', '--client-id', '--secret', '--agent-id', '--session-id', '--mountpoint'];
  const base = {
    '--host': '1.2.3.4', '--client-id': 'c', '--secret': 's',
    '--agent-id': 'a', '--session-id': 'sess', '--mountpoint': '/mnt'
  };
  for (const omit of required) {
    const argv = [];
    for (const [flag, value] of Object.entries(base)) if (flag !== omit) argv.push(flag, value);
    assert.throws(() => parseArgs(argv), new RegExp(omit), `${omit} must be required`);
  }

  assert.throws(() => parseArgs([...Object.entries(base).flat(), '--port', '0']), /invalid --port/);
  assert.throws(() => parseArgs([...Object.entries(base).flat(), '--port', 'eighty']), /invalid --port/);
  assert.throws(() => parseArgs(['--nonsense']), /unknown argument/);

  assert.equal(parseArgs([...Object.entries(base).flat(), '--no-sidecar-filter']).sidecarFilter, false);
  assert.equal(parseArgs([...Object.entries(base).flat(), '--read-only']).readOnly, true);
  assert.equal(parseArgs([...Object.entries(base).flat(), '--wait', '5']).waitSeconds, 5);
});

test('the module loads with no FUSE binding present, and says so precisely',
  { skip: skip || false }, () => {
  // The whole translation layer must be importable and testable on a machine
  // with no FUSE at all. If this ever regresses to a top-level require of the
  // native addon, every test above stops running on CI.
  const loaded = MOUNT.loadFuseBinding({ require: () => { throw new Error('Cannot find module'); } });
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /no FUSE binding could be loaded/);
  assert.deepEqual(loaded.tried.map((x) => x.module), [...MOUNT.BINDING_CANDIDATES]);

  // An injected binding is accepted, so a hand-built one can be dropped in.
  const MockFuse = makeMockFuse();
  const injected = MOUNT.loadFuseBinding({ module: 'my-binding', require: () => MockFuse });
  assert.equal(injected.ok, true);
  assert.equal(injected.Fuse, MockFuse);

  // ...including one exported as an ES default.
  const asDefault = MOUNT.loadFuseBinding({ module: 'esm-binding', require: () => ({ default: MockFuse }) });
  assert.equal(asDefault.ok, true);
  assert.equal(asDefault.Fuse, MockFuse);

  // Something that loads but is not a constructor is a miss, not a crash.
  const junk = MOUNT.loadFuseBinding({ module: 'junk', require: () => ({ nope: true }) });
  assert.equal(junk.ok, false);
  assert.match(junk.tried[0].error, /did not export a constructor/);

  // The implementation notes the CLI prints are present and honest about what
  // has not been verified.
  assert.equal(MOUNT.MOUNT_IMPL['fuse-t'].kext, false);
  assert.equal(MOUNT.MOUNT_IMPL.macfuse.kext, true);
  assert.match(MOUNT.MOUNT_IMPL['fuse-t'].unverified, /NOT been run on real hardware/);
});
