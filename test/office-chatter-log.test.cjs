'use strict';

// The durable break-room transcript (src/main/officeChatLog.ts).
//
// `officeRel` keeps a pair's last six turns as PROMPT INPUT and overwrites them
// in place, so before this file existed no conversation survived the pair's next
// sitting. What these tests pin is everything that makes a 24/7 append-only file
// safe to add:
//
//   • it actually records who spoke to whom, what, when, and whether a model
//     wrote it — and nothing else (no paths);
//   • retention by AGE, so the record stays a week and not a year;
//   • retention by SIZE, because an age bound is not a size bound and this app
//     runs for weeks at a time;
//   • total INERTIA with `officeChatterEnabled` off — the flag-leak bug Phases
//     2, 3 and 4 each had to fix once. Nothing is written, and no file is even
//     created;
//   • per-line tolerance: a garbled line never costs the file, and an unreadable
//     file is never rewritten (the Phase 5 never-clobber rule, applied at the
//     only point where this format puts it at stake).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  OfficeChatterLog, CHATTER_LOG_FILE_NAME, DEFAULT_CHATTER_LOG_DAYS
} = loadTs('src/main/officeChatLog.ts');

const DAY_MS = 24 * 3_600_000;

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'office-chatter-'));
}

/** A log over a fresh home. `enabled` defaults to ON — the OFF case is the
 *  point of its own test below. */
function makeLog(home, opts = {}) {
  return new OfficeChatterLog({
    getHome: () => home,
    isEnabled: () => opts.enabled !== false,
    getRetentionDays: () => opts.days,
    getMaxKb: () => opts.maxKb
  });
}

const logPath = (home) => path.join(home, CHATTER_LOG_FILE_NAME);
const rowsOnDisk = (home) => fs.readFileSync(logPath(home), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ─── writing ────────────────────────────────────────────────────────────────

test('an exchange is recorded one row per line, attributed and stamped', () => {
  const home = tmpHome();
  const log = makeLog(home);
  const written = log.record('jim', 'dwight', ['bears.', 'beets.', 'battlestar.']);

  assert.strictEqual(written, 3);
  const rows = rowsOnDisk(home);
  assert.strictEqual(rows.length, 3);
  // Lines alternate starting with the OPENER — the same contract the floor
  // plays them on and noteTurns derives attribution from.
  assert.deepStrictEqual(rows.map((r) => r.by), ['jim', 'dwight', 'jim']);
  assert.deepStrictEqual(rows.map((r) => r.text), ['bears.', 'beets.', 'battlestar.']);
  for (const r of rows) {
    assert.strictEqual(r.from, 'jim');
    assert.strictEqual(r.to, 'dwight');
    assert.ok(Number.isFinite(r.ts) && r.ts > 0, 'every line is stamped');
    assert.strictEqual(r.gen, true, 'everything the floor speaks today is model-written');
  }
  // One exchange = one conversation id, so a panel can group the lines back.
  assert.strictEqual(new Set(rows.map((r) => r.conv)).size, 1);
});

test('a second sitting APPENDS instead of replacing — this is the whole point', () => {
  const home = tmpHome();
  const log = makeLog(home);
  log.record('pam', 'jim', ['one', 'two']);
  log.record('pam', 'jim', ['three', 'four']);

  const rows = rowsOnDisk(home);
  assert.deepStrictEqual(rows.map((r) => r.text), ['one', 'two', 'three', 'four']);
  // Two sittings, two conversations.
  assert.strictEqual(new Set(rows.map((r) => r.conv)).size, 2);
});

test('a non-generated line is recorded as such', () => {
  const home = tmpHome();
  const log = makeLog(home);
  log.record('kevin', 'oscar', ['a', 'b'], { generated: false });
  assert.deepStrictEqual(rowsOnDisk(home).map((r) => r.gen), [false, false]);
});

test('local paths and credentials never reach the transcript', () => {
  const home = tmpHome();
  const log = makeLog(home);
  log.record('angela', 'kevin', [
    'check C:\\Users\\alex\\keys\\prod.pem',
    'it is in ~/secrets/id_rsa'
  ]);
  const texts = rowsOnDisk(home).map((r) => r.text);
  for (const t of texts) {
    assert.ok(!/prod\.pem|id_rsa|Users/.test(t), `path leaked into the log: ${t}`);
  }
});

test('nonsense input writes nothing at all', () => {
  const home = tmpHome();
  const log = makeLog(home);
  assert.strictEqual(log.record('jim', 'jim', ['hi', 'hi']), 0, 'nobody chats with themselves');
  assert.strictEqual(log.record('', 'dwight', ['hi']), 0);
  assert.strictEqual(log.record('jim', 'dwight', []), 0);
  assert.strictEqual(log.record('jim', 'dwight', ['   ', '']), 0, 'blank lines are not lines');
  assert.strictEqual(fs.existsSync(logPath(home)), false, 'no file was created');
});

// ─── INERTIA with the flag off ──────────────────────────────────────────────

test('with officeChatterEnabled off NOTHING is written and no file is created', () => {
  const home = tmpHome();
  const log = makeLog(home, { enabled: false });

  assert.strictEqual(log.record('jim', 'dwight', ['bears.', 'beets.']), 0);
  assert.strictEqual(fs.existsSync(logPath(home)), false, 'the flag must not leak a file');
  // Not even an empty directory entry, and nothing anywhere else in the home.
  assert.deepStrictEqual(fs.readdirSync(home), []);
});

test('a log that already exists is not touched while the flag is off', () => {
  const home = tmpHome();
  // A user who turns the experiment on, then off, keeps what was recorded — but
  // nothing new lands and the bytes are not rewritten.
  makeLog(home).record('jim', 'dwight', ['one', 'two']);
  const before = fs.readFileSync(logPath(home), 'utf8');
  const beforeMtime = fs.statSync(logPath(home)).mtimeMs;

  const off = makeLog(home, { enabled: false });
  assert.strictEqual(off.record('jim', 'dwight', ['three', 'four']), 0);

  assert.strictEqual(fs.readFileSync(logPath(home), 'utf8'), before);
  assert.strictEqual(fs.statSync(logPath(home)).mtimeMs, beforeMtime);
});

// ─── retention: age ─────────────────────────────────────────────────────────

test('prune drops lines older than the retention window and keeps the rest', () => {
  const home = tmpHome();
  const log = makeLog(home);           // default 7 days
  const now = Date.now();
  log.record('jim', 'dwight', ['ancient'], { at: now - 30 * DAY_MS });
  log.record('jim', 'dwight', ['old'], { at: now - (DEFAULT_CHATTER_LOG_DAYS + 1) * DAY_MS });
  log.record('jim', 'dwight', ['recent'], { at: now - 2 * DAY_MS });
  log.record('jim', 'dwight', ['today'], { at: now });

  log.prune(now);

  assert.deepStrictEqual(rowsOnDisk(home).map((r) => r.text), ['recent', 'today']);
});

test('the retention window is configurable, and clamped so it cannot be turned off', () => {
  const now = Date.now();

  const short = tmpHome();
  const shortLog = makeLog(short, { days: 2 });
  shortLog.record('a', 'b', ['three days ago'], { at: now - 3 * DAY_MS });
  shortLog.record('a', 'b', ['yesterday'], { at: now - 1 * DAY_MS });
  shortLog.prune(now);
  assert.deepStrictEqual(rowsOnDisk(short).map((r) => r.text), ['yesterday']);

  // 0 / negative / garbage must not mean "keep forever" — the floor of the
  // clamp is a real day, so an unbounded log is not reachable from config.json.
  for (const days of [0, -5, Number.NaN, 'forever']) {
    const home = tmpHome();
    const log = makeLog(home, { days });
    log.record('a', 'b', ['stale'], { at: now - 400 * DAY_MS });
    log.record('a', 'b', ['fresh'], { at: now });
    log.prune(now);
    assert.deepStrictEqual(rowsOnDisk(home).map((r) => r.text), ['fresh'],
      `days=${String(days)} must still enforce a bound`);
  }
});

test('a row with no usable timestamp is dropped rather than living forever', () => {
  const home = tmpHome();
  fs.writeFileSync(logPath(home), [
    JSON.stringify({ conv: 'x', from: 'a', to: 'b', by: 'a', text: 'undatable', gen: true }),
    JSON.stringify({ ts: Date.now(), conv: 'y', from: 'a', to: 'b', by: 'a', text: 'datable', gen: true })
  ].join('\n') + '\n', 'utf8');

  makeLog(home).prune(Date.now());
  assert.deepStrictEqual(rowsOnDisk(home).map((r) => r.text), ['datable']);
});

// ─── retention: size ────────────────────────────────────────────────────────

test('prune enforces the SIZE ceiling too, keeping the newest lines', () => {
  const home = tmpHome();
  // Everything below is well inside the age window, so only the size bound can
  // be doing the work here — which is the property under test.
  const log = makeLog(home, { maxKb: 64 });   // 64 KB = the clamp floor
  const now = Date.now();
  for (let i = 0; i < 900; i++) {
    log.record('jim', 'dwight', [`line ${i} ${'x'.repeat(50)}`], { at: now - (900 - i) * 1_000 });
  }
  const grown = fs.statSync(logPath(home)).size;
  assert.ok(grown > 64 * 1024, `test needs to overflow the ceiling, got ${grown} bytes`);

  log.prune(now);

  const after = fs.statSync(logPath(home)).size;
  assert.ok(after <= 64 * 1024, `file still over the ceiling: ${after} bytes`);
  const rows = rowsOnDisk(home);
  assert.ok(rows.length > 0, 'the bound trims, it does not empty the file');
  // The NEWEST lines are the ones kept, in order.
  assert.strictEqual(rows[rows.length - 1].text.startsWith('line 899'), true);
  assert.ok(!rows.some((r) => r.text.startsWith('line 0 ')), 'oldest lines are the ones dropped');
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].ts >= rows[i - 1].ts, 'order preserved');
});

test('the size ceiling is enforced without anyone calling prune', () => {
  const home = tmpHome();
  // Nothing here calls prune(): `record` triggers it once enough bytes have
  // landed, which is what keeps the file bounded on a machine that never
  // restarts and where the pair chats for weeks.
  const log = makeLog(home, { maxKb: 64 });
  for (let i = 0; i < 1_200; i++) log.record('jim', 'dwight', [`line ${i} ${'x'.repeat(50)}`]);

  const size = fs.statSync(logPath(home)).size;
  assert.ok(size <= 64 * 1024 + 8 * 1024,
    `unattended growth escaped the ceiling: ${size} bytes`);
});

// ─── resilience ─────────────────────────────────────────────────────────────

test('a garbled line costs one line, not the file', () => {
  const home = tmpHome();
  const log = makeLog(home);
  const now = Date.now();
  log.record('jim', 'dwight', ['before'], { at: now });
  // Exactly what a crash mid-append leaves behind: a truncated final line.
  fs.appendFileSync(logPath(home), '{"ts":' + now + ',"from":"jim","to":"dw', 'utf8');
  log.record('jim', 'dwight', ['after'], { at: now });

  assert.deepStrictEqual(log.read().map((r) => r.text), ['before', 'after'],
    'the reader skips the damaged line');
  log.prune(now);
  assert.deepStrictEqual(rowsOnDisk(home).map((r) => r.text), ['before', 'after']);
});

test('an unreadable log is never rewritten', () => {
  const home = tmpHome();
  // A DIRECTORY where the file should be is the portable stand-in for "present
  // but cannot be read" (EACCES is not reproducible as a non-root user on
  // Windows). The pruner must skip, not replace it with a fresh file.
  fs.mkdirSync(logPath(home));
  const log = makeLog(home);

  assert.strictEqual(log.prune(Date.now()), false);
  assert.strictEqual(log.read().length, 0);
  assert.ok(fs.statSync(logPath(home)).isDirectory(), 'the pruner clobbered unreadable bytes');
});

test('purge erases the transcript', () => {
  const home = tmpHome();
  const log = makeLog(home);
  log.record('jim', 'dwight', ['one', 'two']);
  assert.ok(fs.existsSync(logPath(home)));

  log.purge();
  assert.strictEqual(fs.existsSync(logPath(home)), false);
  assert.deepStrictEqual(log.read(), []);
});

// ─── wired through the dialogue director ────────────────────────────────────
//
// The two tests above prove the LOG is inert with the flag off. These prove the
// same thing one level up, where the flag actually lives: the director is the
// only caller, and with the chatter off it must never reach the log at all.

const hidden = loadTs('src/main/hiddenClaude.ts');
const { OfficeChatDirector } = loadTs('src/main/officeChat.ts');
const { RelationshipBook } = loadTs('src/main/officeRel.ts');

const persona = (id) => ({ id, name: id, character: 'Jim', role: 'dev', status: 'idle' });
const chatReq = (a, b) => ({ a: persona(a), b: persona(b), mood: 'generic', spot: 'table' });

function director(home, enabled, lines) {
  hidden.runHiddenClaude = async () => ({ ok: true, text: JSON.stringify(lines) });
  const log = makeLog(home, { enabled });
  return new OfficeChatDirector({
    getHome: () => home,
    getCommand: () => 'claude',
    getModel: () => 'MODEL',
    isEnabled: () => enabled,
    rel: new RelationshipBook(() => home),
    log: (from, to, spoken) => log.record(from, to, spoken)
  });
}

const waitFor = async (cond, label, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('every exchange the director hands to the floor lands in the transcript', async () => {
  const home = tmpHome();
  const d = director(home, true, ['so about the parser', 'not again']);
  d.request(chatReq('jim', 'dwight'));   // first sitting brews, says nothing
  await waitFor(() => d.request(chatReq('jim', 'dwight')).lines, 'a brewed exchange');

  const rows = rowsOnDisk(home);
  assert.deepStrictEqual(rows.map((r) => r.text), ['so about the parser', 'not again']);
  assert.deepStrictEqual(rows.map((r) => r.by), ['jim', 'dwight']);
});

test('with the chatter flag off the director never writes a transcript', async () => {
  const home = tmpHome();
  const d = director(home, false, ['this should never exist', 'nor this']);
  for (let i = 0; i < 5; i++) assert.strictEqual(d.request(chatReq('jim', 'dwight')).lines, null);
  // Give any (wrongly) started background brew a chance to land and write.
  await new Promise((r) => setTimeout(r, 100));

  assert.strictEqual(fs.existsSync(logPath(home)), false, 'the flag leaked a transcript');
  assert.deepStrictEqual(fs.readdirSync(home), [], 'the flag leaked a file into the home');
});

test('with no home open nothing is written anywhere', () => {
  const log = new OfficeChatterLog({ getHome: () => null, isEnabled: () => true });
  assert.strictEqual(log.filePath(), null);
  assert.strictEqual(log.record('jim', 'dwight', ['hi', 'there']), 0);
  assert.deepStrictEqual(log.read(), []);
});
