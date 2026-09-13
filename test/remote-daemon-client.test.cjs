'use strict';
/**
 * remote-daemon-client.test.cjs — the main-process remote PTY client, driven
 * against the REAL daemon.
 *
 * This is deliberately not a unit test with a fake socket. The failure mode this
 * whole layer is exposed to is a handshake that is subtly wrong on the wire —
 * an HMAC over a payload assembled in a slightly different order, `input` sent as
 * a plain string where the daemon demands base64, output used without decoding —
 * and every one of those compiles, type-checks, and passes against a mock. So the
 * test starts `remote-daemon/daemon.js` as a real child process on 127.0.0.1,
 * reads the pairing code off its stdout the way an operator would, and then makes
 * `src/main/remoteDaemon.ts` — the actual shipped client, loaded through the same
 * `load-ts` transpiler the other tests use — pair, authenticate, spawn a real
 * command, receive its output, write into it, and watch it exit.
 *
 * `remoteDaemon.ts` is import-type-only on electron precisely so this is possible
 * under plain Node.
 *
 * SKIPPED (not failed) when `remote-daemon/` is absent or its node-pty binary
 * will not load for the running Node ABI: the daemon is a standalone,
 * separately-installed component, and a checkout without it is not broken.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const DAEMON = path.join(REPO, 'remote-daemon', 'daemon.js');
const MARKER = 'remote-daemon-client-works';
const WRITE_MARKER = 'remote-daemon-write-works';
const isWin = process.platform === 'win32';

/** Why this file cannot run here, or null when it can. */
function unavailable() {
  if (!fs.existsSync(DAEMON)) return 'remote-daemon/ is not present in this checkout';
  try {
    require(path.join(REPO, 'remote-daemon', 'node_modules', 'node-pty'));
  } catch (err) {
    return `remote-daemon node-pty will not load (${err && err.message})`;
  }
  return null;
}

/** An ephemeral port the OS just told us is free. */
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

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    })
  ]);
}

/**
 * Start the daemon bound to loopback with a throwaway state dir, and resolve
 * once it has printed BOTH "listening on" and a pairing code — the same two
 * lines an operator reads off the console.
 */
function startDaemon(port, stateDir) {
  const child = spawn(process.execPath, [
    DAEMON, '--bind', '127.0.0.1', '--port', String(port), '--pair', '--state-dir', stateDir
  ], { cwd: path.join(REPO, 'remote-daemon'), stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  let err = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const code = /PAIRING CODE:\s*([A-Z0-9]{6})/.exec(out);
      if (code && out.includes('listening on')) resolve({ code: code[1] });
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('exit', (exitCode) => {
      reject(new Error(`daemon exited early (code ${exitCode})\nstdout:\n${out}\nstderr:\n${err}`));
    });
    child.once('error', reject);
  });

  return { child, ready, stdout: () => out, stderr: () => err };
}

const skip = unavailable();

test('RemoteDaemonClient pairs, authenticates and drives a real remote PTY', { skip: skip || false, timeout: 90_000 }, async (t) => {
  const { RemoteDaemonClient, pairWithRemoteDaemon } = loadTs('src/main/remoteDaemon.ts');

  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-daemon-test-'));
  const daemon = startDaemon(port, stateDir);
  let client = null;

  t.after(() => {
    try { client?.dispose(); } catch { /* already gone */ }
    try { daemon.child.kill(); } catch { /* already gone */ }
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const { code } = await withTimeout(daemon.ready, 30_000, 'the daemon to print a pairing code');
  assert.match(code, /^[A-Z0-9]{6}$/, 'the daemon should print a 6-character pairing code');

  // ── 1. Pairing ────────────────────────────────────────────────────────────
  const paired = await pairWithRemoteDaemon({
    host: '127.0.0.1', port, code, name: 'remote-daemon-client-test'
  });
  assert.equal(paired.ok, true, `pairing failed: ${paired.ok ? '' : paired.error}`);
  assert.match(paired.clientId, /^client-[0-9a-f]{16}$/, 'the daemon should mint a client id');
  assert.match(paired.secret, /^[0-9a-f]{64}$/, 'the shared secret should be 32 hex-encoded bytes');
  assert.ok(Number.isFinite(paired.pairedAt));
  // The one credential the daemon prints is the CODE; the secret must never
  // appear in any console output.
  assert.ok(!daemon.stdout().includes(paired.secret), 'the daemon must never log the pairing secret');

  // A used pairing code is single-use — the window closes on success.
  const replay = await pairWithRemoteDaemon({ host: '127.0.0.1', port, code, name: 'replay' });
  assert.equal(replay.ok, false, 'a pairing code must not be reusable');

  // ── 2. Authenticated connection (the HMAC handshake) ──────────────────────
  client = new RemoteDaemonClient({
    host: '127.0.0.1', port, clientId: paired.clientId, secret: paired.secret
  });
  const outputs = [];
  const exits = [];
  client.on('data', (evt) => outputs.push(evt));
  client.on('exit', (evt) => exits.push(evt));
  client.on('error', () => { /* surfaced through the assertions below */ });

  const connected = await withTimeout(client.connect(), 20_000, 'the auth handshake');
  assert.equal(connected.ok, true, `auth failed: ${connected.error}`);
  assert.equal(client.isConnected, true);

  // A WRONG secret must be refused — proof the handshake is actually checked and
  // not merely tolerated by a daemon that would accept anything.
  const impostor = new RemoteDaemonClient({
    host: '127.0.0.1', port, clientId: paired.clientId, secret: 'f'.repeat(64)
  });
  const refused = await withTimeout(impostor.connect(), 20_000, 'the bad-secret handshake');
  assert.equal(refused.ok, false, 'a bad HMAC must not authenticate');
  impostor.dispose();

  // ── 3. Spawn a real short-lived command ON THE DAEMON ─────────────────────
  const echoId = 'remote-test-echo';
  const spawned = await withTimeout(client.spawn({
    id: echoId,
    command: isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    args: isWin ? ['/c', `echo ${MARKER}`] : ['-c', `echo ${MARKER}`],
    cwd: REPO,
    cols: 80,
    rows: 24
  }), 25_000, 'the remote spawn');
  assert.equal(spawned.ok, true, `remote spawn failed: ${spawned.error}`);
  assert.ok(Number.isInteger(spawned.pid) && spawned.pid > 0, 'the daemon should report a real remote pid');

  const echoExit = await withTimeout(
    new Promise((resolve) => {
      const seen = exits.find((e) => e.id === echoId);
      if (seen) return resolve(seen);
      client.on('exit', function onExit(evt) {
        if (evt.id !== echoId) return;
        client.off('exit', onExit);
        resolve(evt);
      });
    }),
    30_000,
    'the remote command to exit'
  );

  const echoText = outputs.filter((o) => o.id === echoId).map((o) => o.data).join('');
  assert.ok(
    echoText.includes(MARKER),
    `expected the remote output to contain "${MARKER}"; got:\n${JSON.stringify(echoText)}`
  );
  assert.equal(echoExit.exitCode, 0, 'the remote command should exit cleanly');

  // ── 4. Write into a live remote PTY, then kill it ─────────────────────────
  // The only route from here to the remote shell is `{type:'input', data:<base64>}`
  // — the daemon rejects a non-base64 payload outright — so seeing the marker
  // come back proves the write encoding is right, not just that a socket is open.
  const shellId = 'remote-test-shell';
  const shellSpawn = await withTimeout(client.spawn({
    id: shellId,
    command: isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    args: [],
    cwd: REPO,
    cols: 80,
    rows: 24
  }), 25_000, 'the remote shell spawn');
  assert.equal(shellSpawn.ok, true, `remote shell spawn failed: ${shellSpawn.error}`);

  const sawWriteMarker = new Promise((resolve) => {
    let acc = '';
    client.on('data', function onData(evt) {
      if (evt.id !== shellId) return;
      acc += evt.data;
      if (acc.includes(WRITE_MARKER)) {
        client.off('data', onData);
        resolve(acc);
      }
    });
  });
  // Give the shell a beat to print its prompt before typing into it.
  await new Promise((r) => setTimeout(r, 750));
  assert.deepEqual(client.write(shellId, `echo ${WRITE_MARKER}\r`), { ok: true });
  assert.deepEqual(client.resize(shellId, 120, 40), { ok: true });
  await withTimeout(sawWriteMarker, 30_000, 'the remote shell to echo what we typed');

  const sessions = await withTimeout(client.list(), 15_000, 'the session list');
  assert.ok(sessions.some((s) => s.id === shellId), 'the daemon should list the live remote session');

  assert.deepEqual(client.kill(shellId), { ok: true });
  await withTimeout(
    new Promise((resolve) => {
      const seen = exits.find((e) => e.id === shellId);
      if (seen) return resolve(seen);
      client.on('exit', function onExit(evt) {
        if (evt.id !== shellId) return;
        client.off('exit', onExit);
        resolve(evt);
      });
    }),
    30_000,
    'the killed remote shell to exit'
  );

  // Nothing in this whole exchange may have leaked the secret to the console.
  assert.ok(!daemon.stdout().includes(paired.secret));
  assert.ok(!daemon.stderr().includes(paired.secret));
});

test('a remote environment record has no field a secret could live in', () => {
  const { toRemoteEnvironmentView, remoteSecretRefFor, isValidRemoteHost, isValidRemotePort } =
    loadTs('src/shared/remoteEnvironment.ts');

  const view = toRemoteEnvironmentView({
    id: 'remote-1', name: 'studio', host: '100.1.2.3', port: 8722,
    clientId: 'client-abc', pairedAt: 1,
    // A caller that tries to smuggle one through is stripped, not trusted.
    secret: 'nope'
  });
  assert.deepEqual(Object.keys(view).sort(), ['clientId', 'host', 'id', 'name', 'pairedAt', 'port']);
  assert.equal(view.secret, undefined);

  assert.equal(remoteSecretRefFor('remote-1'), 'remote:remote-1');
  // Namespaced apart from integration secrets, so the two can never collide.
  assert.notEqual(remoteSecretRefFor('x'), 'int:x');

  assert.equal(isValidRemoteHost('100.64.0.1'), true);
  assert.equal(isValidRemoteHost('box.tail1234.ts.net'), true);
  assert.equal(isValidRemoteHost('[fd7a::1]'), true);
  // Anything that could smuggle a second URL component past `ws://${host}:${port}`.
  assert.equal(isValidRemoteHost('evil.com/path'), false);
  assert.equal(isValidRemoteHost('user@evil.com'), false);
  assert.equal(isValidRemoteHost('a b'), false);
  assert.equal(isValidRemoteHost(''), false);

  assert.equal(isValidRemotePort(8722), true);
  assert.equal(isValidRemotePort(0), false);
  assert.equal(isValidRemotePort(70000), false);
  assert.equal(isValidRemotePort('8722'), false);
});
