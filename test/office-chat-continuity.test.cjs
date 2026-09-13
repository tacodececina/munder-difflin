'use strict';

// Continuous café conversations, and the read-only work context that lets two
// agents talk shop (src/main/officeChat.ts, officeRel.ts, officeWork.ts).
//
// What this file exists to stop from regressing:
//   1. CONTINUITY — an exchange used to be an isolated quip. Every exchange the
//      director hands out must be APPENDED, attributed, to the pair's running
//      thread, and the next brew for that pair must carry it back so the model
//      can pick it up.
//   2. ATTRIBUTION — the relationship book is DIRECTIONAL and stores one
//      transcript on both edges. Without an explicit speaker per turn, whoever
//      sits down second is indistinguishable from whoever sat down first, and
//      the continuation gets put in the wrong mouth.
//   3. THE BOUNDARY — the prompt may carry task titles and statuses. It must
//      never carry a description, a result, an operator's answer, or a local
//      path, and nothing the director produces may reach the work.
//   4. SILENCE — with no brewed exchange the director returns null lines, which
//      the floor renders as two agents sitting quietly. There is no canned pool
//      to fall back on any more, so null must stay null.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const hidden = loadTs('src/main/hiddenClaude.ts');
const { OfficeChatDirector } = loadTs('src/main/officeChat.ts');
const { RelationshipBook } = loadTs('src/main/officeRel.ts');
const { projectWorkContext, scrubTitle } = loadTs('src/main/officeWork.ts');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-cont-'));

const persona = (id) => ({ id, name: id, character: 'Jim', role: 'dev', status: 'idle' });
const req = (a, b) => ({ a: persona(a), b: persona(b), mood: 'generic', spot: 'table' });

const waitFor = async (cond, label, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A director over a real book in a throwaway home, with the hidden session
 *  stubbed. `opts.work` supplies the read-only work context, when the test
 *  wants one. */
function harness(reply, opts = {}) {
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  const calls = [];
  hidden.runHiddenClaude = async (prompt, o) => {
    calls.push({ prompt, ...o });
    return reply(calls.length);
  };
  const director = new OfficeChatDirector({
    getHome: () => home,
    getCommand: () => 'claude',
    getModel: () => 'MODEL',
    getWork: opts.work,
    isEnabled: () => true,
    rel: book
  });
  return { director, book, calls, home };
}

const reply = (lines) => ({ ok: true, text: JSON.stringify(lines) });

// ─── 1 + 2: the thread, attributed ──────────────────────────────────────────

test('an exchange is appended to the pair\'s thread, attributed to its speakers', async () => {
  const { director, book } = harness(() => reply(['so about the parser', 'not again', 'it IS again']));
  director.request(req('jim', 'dwight'));            // first sitting: brews, says nothing
  await waitFor(() => director.request(req('jim', 'dwight')).lines, 'a brewed exchange');

  const turns = book.lastTurns('jim', 'dwight');
  assert.deepStrictEqual(turns.map((t) => t.by), ['jim', 'dwight', 'jim'],
    'beats alternate starting with the opener');
  assert.deepStrictEqual(turns.map((t) => t.text),
    ['so about the parser', 'not again', 'it IS again']);
  assert.ok(turns.every((t) => typeof t.at === 'number' && t.at > 0), 'every turn is stamped');

  // The same transcript is readable from BOTH directions — that is why `by`
  // has to be explicit rather than positional.
  assert.deepStrictEqual(book.lastTurns('dwight', 'jim'), turns);
});

test('the thread is APPENDED across sittings, and capped', () => {
  // Straight at the book: the director can only brew for a pair every few
  // minutes, so the append/cap semantics are exercised where they live.
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  for (let n = 1; n <= 5; n++) book.noteTurns('jim', 'dwight', [`line ${n}a`, `line ${n}b`]);
  const turns = book.lastTurns('jim', 'dwight');
  assert.strictEqual(turns.length, 6, 'the window is capped at MAX_TURNS');
  assert.strictEqual(turns[turns.length - 1].text, 'line 5b', 'the newest turn is last');
  assert.ok(!turns.some((t) => t.text === 'line 1a'), 'the oldest turns aged out');
  // Attribution survives the append: the opener is always the first argument.
  assert.deepStrictEqual([...new Set(turns.map((t) => t.by))], ['jim', 'dwight']);
});

test('the next brew\'s prompt carries the thread back, with speaker labels', async () => {
  const { director, book, home, calls } = harness(() => reply(['did you look at it', 'i looked at it']));
  director.request(req('jim', 'dwight'));
  await waitFor(() => calls.length >= 1, 'the first brew');
  await waitFor(() => director.request(req('jim', 'dwight')).lines, 'the first exchange');
  book.flush();   // the save is debounced; a restart reads the file, not memory

  // Second brew for the same pair. The per-pair cooldown blocks a re-brew on
  // this director, so build a fresh one over a fresh book on the SAME home —
  // exactly what a restart looks like, and proof that the continuity lives in
  // the persisted relationship book rather than in this process's memory.
  const book2 = new RelationshipBook(() => home);
  assert.strictEqual(book2.lastTurns('jim', 'dwight').length, 2, 'the thread reached disk');
  const seen = [];
  hidden.runHiddenClaude = async (prompt) => { seen.push(prompt); return reply(['a', 'b']); };
  const d2 = new OfficeChatDirector({
    getHome: () => home, getCommand: () => 'claude', getModel: () => 'M',
    isEnabled: () => true, rel: book2
  });
  d2.request(req('jim', 'dwight'));
  await waitFor(() => seen.length >= 1, 'the second brew');

  const prompt = seen[0];
  assert.match(prompt, /What they last said to each other/);
  assert.match(prompt, /A: "did you look at it"/);
  assert.match(prompt, /B: "i looked at it"/);
  assert.match(prompt, /picking it straight back up/i,
    'a recent thread is written as a continuation, not a fresh subject');
});

test('the FIRST conversation of a pair is not written as a continuation', async () => {
  const { director, calls } = harness(() => reply(['hi', 'hi']));
  director.request(req('creed', 'toby'));
  await waitFor(() => calls.length >= 1, 'the brew');
  assert.match(calls[0].prompt, /no conversation on record yet/i);
  assert.doesNotMatch(calls[0].prompt, /What they last said to each other/);
});

test('the prompt asks for a variable-length exchange, not a fixed two beats', async () => {
  const { director, calls } = harness(() => reply(['a', 'b']));
  director.request(req('jim', 'pam'));
  await waitFor(() => calls.length >= 1, 'the brew');
  assert.match(calls[0].prompt, /Write a 2–6 line exchange/);
  assert.match(calls[0].prompt, /Choose the LENGTH from the situation/);
});

test('an exchange longer than two beats survives parsing', async () => {
  const { director } = harness(() => reply(['one', 'two', 'three', 'four', 'five', 'six', 'seven']));
  director.request(req('jim', 'pam'));
  let lines = null;
  await waitFor(() => (lines = director.request(req('jim', 'pam')).lines), 'the exchange');
  assert.strictEqual(lines.length, 6, 'up to six beats are kept, the rest dropped');
});

// ─── 3: the work context, and the boundary around it ────────────────────────

test('the prompt carries task TITLES and STATUSES — never bodies or paths', async () => {
  const ledger = {
    tasks: [
      {
        id: 't1', status: 'blocked', assignee: 'jim',
        title: 'flaky login test',
        // None of the following may appear in a prompt, ever.
        description: 'repro: run C:\\Users\\alex\\secrets\\prod.pem then curl -H "Authorization: Bearer sk-live-9f2"',
        result: 'fixed by rotating the prod key',
        humanQA: [{ q: 'which env?', a: 'the prod one, password hunter2' }],
        slack: { channel: 'C123', thread_ts: '1.2' },
        webhook: { tokenHash: 'deadbeefdeadbeefdeadbeef' }
      },
      { id: 't2', status: 'doing', assignee: 'dwight', title: 'beet inventory sync' }
    ]
  };
  const { director, calls } = harness(() => reply(['a', 'b']), {
    work: (a, b) => projectWorkContext(ledger, a, b)
  });
  director.request(req('jim', 'dwight'));
  await waitFor(() => calls.length >= 1, 'the brew');
  const prompt = calls[0].prompt;

  assert.match(prompt, /flaky login test/, 'titles cross');
  assert.match(prompt, /\[blocked\]/, 'statuses cross');
  assert.match(prompt, /A's card/, 'ownership is expressed relative to the two speakers');

  for (const leak of ['prod.pem', 'sk-live', 'hunter2', 'rotating the prod key',
    'which env', 'C123', 'deadbeef', 'C:\\\\Users']) {
    assert.ok(!prompt.includes(leak), `the prompt leaked ${leak}`);
  }
});

test('the work rule tells the model it is conversation, never control', async () => {
  const { director, calls } = harness(() => reply(['a', 'b']), {
    work: () => projectWorkContext({ tasks: [{ id: 'x', status: 'todo', title: 'ship the thing' }] }, 'a', 'b')
  });
  director.request(req('jim', 'dwight'));
  await waitFor(() => calls.length >= 1, 'the brew');
  assert.match(calls[0].prompt, /never a decision, an assignment, a status/i);
  assert.match(calls[0].prompt, /nothing here reaches the real board/i);
});

test('no work context leaves the prompt exactly as it was', async () => {
  const { director, calls } = harness(() => reply(['a', 'b']));  // no getWork at all
  director.request(req('jim', 'dwight'));
  await waitFor(() => calls.length >= 1, 'the brew');
  assert.doesNotMatch(calls[0].prompt, /READ-ONLY context/);
});

test('scrubTitle strips paths, urls and token-shaped runs out of a title', () => {
  assert.ok(!scrubTitle('fix C:\\Users\\alex\\keys\\prod.pem').includes('prod.pem'));
  assert.ok(!scrubTitle('patch /etc/nginx/nginx.conf').includes('nginx.conf'));
  assert.ok(!scrubTitle('see https://internal.corp/x?token=abc').includes('internal.corp'));
  // Assembled at runtime, never written out as one literal: spelled in full it
  // matches Stripe's live-key pattern well enough that GitHub push protection
  // blocks the commit. The value is fake, but teaching the repo to accept that
  // shape would disarm a check that is doing its job.
  const stripeShaped = ['sk', 'live', '51H' + 'x'.repeat(22) + 'YY'].join('_');
  assert.ok(!scrubTitle(`key ${stripeShaped}`).includes(stripeShaped));
  assert.ok(!scrubTitle('set API_TOKEN=hunter2hunter2').includes('hunter2'));
  // A plain title survives untouched — scrubbing must not eat normal work.
  assert.strictEqual(scrubTitle('fix the flaky login test'), 'fix the flaky login test');
});

test('a path with ONE separator is a path too — root of a drive, or ~-relative', () => {
  // The rule used to demand two separators, so everything in this list reached
  // the (often third-party) chatter endpoint verbatim. A filename sitting at the
  // root of a drive is exactly the substring scrubTitle promises to replace.
  for (const [title, leak] of [
    ['fix C:\\secrets.pem', 'secrets.pem'],
    ['restore D:\\dump.sql', 'dump.sql'],
    ['read C:/secrets.pem', 'secrets.pem'],
    ['copy \\\\build01\\drops', 'build01'],
    ['rotate ~/prod.pem', 'prod.pem'],
    ['load /dump.sql', 'dump.sql']
  ]) {
    assert.ok(!scrubTitle(title).includes(leak), `${JSON.stringify(title)} still leaks ${leak}`);
  }
  // …and prose that merely CONTAINS a separator is still left alone: a title
  // scrubbed into uselessness tells the model nothing true about the work.
  assert.strictEqual(scrubTitle('support and/or docs'), 'support and/or docs');
  assert.strictEqual(scrubTitle('on-call 24/7.5 rotation'), 'on-call 24/7.5 rotation');
});

test('a SPOKEN line is scrubbed before it reaches the relationship book', () => {
  // The chatter log (officeChatLog.cleanText) already ran scrubTitle over these
  // same lines on their way to office-chatter.jsonl. `lastTurns` is the OTHER
  // copy of them: persisted to office-relationships.json AND fed straight back
  // into the next brew's prompt. Scrubbing one destination and not the other
  // kept a path out of the record a human reads and left it in the file that
  // talks to the model — the worse half to miss.
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  book.noteTurns('jim', 'dwight', [
    'did you see C:\\Users\\alex\\keys\\prod.pem',
    'yes, and https://internal.corp/x?token=abcdef'
  ]);
  const leaks = ['prod.pem', 'C:\\Users', 'internal.corp', 'token=abcdef'];
  for (const turn of book.lastTurns('jim', 'dwight')) {
    for (const leak of leaks) {
      assert.ok(!turn.text.includes(leak), `a turn leaked ${leak}: ${turn.text}`);
    }
  }
  // Both edges hold the same transcript, so both have to be clean.
  for (const turn of book.lastTurns('dwight', 'jim')) {
    for (const leak of leaks) assert.ok(!turn.text.includes(leak), `the reverse edge leaked ${leak}`);
  }
  book.flush();   // the save is debounced; the point is what lands on DISK
  const onDisk = fs.readFileSync(path.join(home, 'office-relationships.json'), 'utf8');
  for (const leak of leaks) {
    assert.ok(!onDisk.includes(leak), `office-relationships.json leaked ${leak}`);
  }
  // …and ordinary shop talk is untouched: a thread scrubbed into uselessness
  // cannot resume anything.
  book.noteTurns('jim', 'dwight', ['the parser is still flaky']);
  assert.ok(book.lastTurns('jim', 'dwight').some((t) => t.text === 'the parser is still flaky'));
});

test('a save file written before the scrub is cleaned on the way back in', () => {
  // The fix lives in sanitizeTurns rather than in noteTurns precisely so it
  // covers the LOAD path: an already-persisted line must not survive an upgrade
  // and keep feeding prompts forever.
  const home = tmpHome();
  const now = Date.now();
  fs.writeFileSync(path.join(home, 'office-relationships.json'), JSON.stringify({
    version: 3,
    edges: [{
      from: 'jim', to: 'dwight',
      warmth: 0.2, tension: 0, familiarity: 0.4, interactions: 3, lastAt: now, recent: [],
      lastTurns: [{ by: 'jim', text: 'open C:\\Users\\alex\\keys\\prod.pem', at: now }]
    }]
  }));
  const book = new RelationshipBook(() => home);
  const [turn] = book.lastTurns('jim', 'dwight');
  assert.ok(turn, 'the legacy turn still loads — scrubbing is not dropping');
  assert.ok(!turn.text.includes('prod.pem'), `the load path leaked: ${turn.text}`);
  assert.strictEqual(turn.by, 'jim', 'attribution survives the scrub');
});

test('the hidden brew session is given NO tools at all, reads and network included', async () => {
  // A title is free text an agent, a Slack relay or a webhook can author, and it
  // now travels in this prompt. The session runs with bypassPermissions, so any
  // tool NOT disallowed runs unprompted: with Read/Grep/Glob open an injected
  // title could open the disk, and with WebFetch/WebSearch open it could carry
  // what it found back out. The chatter writes two sentences; it needs none.
  const { director, calls } = harness(() => reply(['a', 'b']));
  director.request(req('jim', 'dwight'));
  await waitFor(() => calls.length >= 1, 'the brew');
  const denied = calls[0].disallowedTools;
  for (const tool of [
    'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
    'Bash', 'Task', 'Edit', 'Write', 'NotebookEdit', 'SlashCommand'
  ]) {
    assert.ok(denied.includes(tool), `${tool} must be disallowed for a chatter brew`);
  }
});

test('the projection only ever reads title, status and assignee', () => {
  const work = projectWorkContext({
    tasks: [{ id: 'x', status: 'doing', assignee: 'jim', title: 'a card', description: 'secret', result: 'secret' }]
  }, 'jim', 'dwight');
  assert.deepStrictEqual(work.notes, [{ title: 'a card', status: 'doing', owner: 'a' }]);
  assert.ok(Object.isFrozen(work), 'the context is handed out frozen');
});

test('a garbage ledger degrades to an empty context instead of throwing', () => {
  for (const bad of [null, undefined, 'nope', {}, { tasks: 'no' }, { tasks: [null, 7, {}] }]) {
    const work = projectWorkContext(bad, 'a', 'b');
    assert.deepStrictEqual(work.notes, []);
  }
});

// ─── 4: silence ─────────────────────────────────────────────────────────────

test('with nothing brewed the pair says nothing — there is no canned fallback', () => {
  const { director } = harness(() => ({ ok: false }));
  const res = director.request(req('jim', 'dwight'));
  assert.strictEqual(res.lines, null, 'null lines mean the break room stays quiet');
});

test('a failed brew leaves the thread untouched', async () => {
  const { director, book, calls } = harness(() => ({ ok: false }));
  director.request(req('jim', 'dwight'));
  await waitFor(() => calls.length >= 2, 'the attempt and its one retry');
  assert.deepStrictEqual(book.lastTurns('jim', 'dwight'), [],
    'nothing was said, so nothing was recorded');
});
