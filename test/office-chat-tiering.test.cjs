'use strict';

// OfficeChatDirector: model tiering, brew reliability, and late-arrival reuse
// (src/main/officeChat.ts).
//
// Three regressions this file exists to catch:
//   1. COST — every routine break-room line used to be brewed with Fable. Routine
//      chatter must resolve to the cheap tier; only a pair's first encounter or a
//      relationship BAND crossing may reach for the expensive one.
//   2. RELIABILITY — a wedged hidden session used to hold the single brew slot for
//      120s and then yield nothing. It must give up fast and retry once.
//   3. WASTE — an exchange that arrived after the chat's opening beat used to be
//      dropped. It must be replayable at the pair's next meeting, same direction.
//
// The hidden Claude session is stubbed by swapping the loaded module's export;
// the director calls it through the module object, so the swap is seen.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const hidden = loadTs('src/main/hiddenClaude.ts');
const { OfficeChatDirector } = loadTs('src/main/officeChat.ts');
const { RelationshipBook } = loadTs('src/main/officeRel.ts');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-chat-'));

const persona = (id) => ({ id, name: id, character: 'Jim', role: 'dev', status: 'idle' });
const req = (a, b) => ({ a: persona(a), b: persona(b), mood: 'generic', spot: 'table' });

const waitFor = async (cond, label, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A director wired to a real RelationshipBook in a throwaway home, plus a stub
 *  hidden session whose behavior each test supplies. `opts.language` is the UI
 *  language the app is running in (the harness config's `language`); omitted =
 *  unset, which is what every install that never touched the picker has. */
function harness(reply, opts = {}) {
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  const calls = [];
  let enabled = true;
  hidden.runHiddenClaude = async (prompt, o) => {
    calls.push({ prompt, ...o });
    return reply(calls.length);
  };
  const director = new OfficeChatDirector({
    getHome: () => home,
    getCommand: () => 'claude',
    getModel: (tier) => (tier === 'milestone' ? 'MODEL-MILESTONE' : 'MODEL-ROUTINE'),
    getLanguage: () => opts.language,
    isEnabled: () => enabled,
    rel: book
  });
  return { home, book, calls, director, setEnabled: (v) => { enabled = v; } };
}

const OK = () => ({ ok: true, text: '["morning","morning"]' });

test('a pair\'s FIRST encounter is brewed with the milestone model', () => {
  const { calls, director } = harness(OK);
  director.request(req('jim', 'pam'));
  assert.strictEqual(calls.length, 1, 'the first meeting should start a brew');
  assert.strictEqual(calls[0].model, 'MODEL-MILESTONE');
});

test('a pair with history gets the cheap model for ordinary chatter', () => {
  const { calls, director, book } = harness(OK);
  book.note('jim', 'pam', 'handoff');
  director.request(req('jim', 'pam'));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].model, 'MODEL-ROUTINE',
    'routine chatter must not reach for the expensive model');
});

test('crossing a relationship band promotes the NEXT brew back to milestone', () => {
  const { director, book } = harness(OK);
  const r = req('jim', 'pam');

  // Nothing between them yet → the establishing exchange is worth the good model.
  assert.strictEqual(director.tierFor(r), 'milestone');

  // A little shared history. The bands are now seeded, so the next look is cheap.
  book.note('jim', 'pam', 'handoff');
  assert.strictEqual(director.tierFor(r), 'routine');
  assert.strictEqual(director.tierFor(r), 'routine', 'drift within a band stays cheap');

  // Enough shared coffee to move warmth and familiarity into new bands.
  for (let i = 0; i < 10; i++) book.note('jim', 'pam', 'cafe');
  assert.strictEqual(director.tierFor(r), 'milestone',
    'an axis crossing a threshold is exactly what the expensive model is for');
  assert.strictEqual(director.tierFor(r), 'routine',
    'the crossing is a moment, not a new permanent tier');
});

test('a one-sided souring promotes the brew even though the other side is unchanged', () => {
  const { director, book } = harness(OK);
  const r = req('dwight', 'jim');
  book.note('dwight', 'jim', 'handoff');
  assert.strictEqual(director.tierFor(r), 'routine'); // seeds both directions

  // Dwight keeps refusing Jim: the sting lands on JIM's edge, so it is the
  // reverse direction that crosses. Either side counts.
  for (let i = 0; i < 6; i++) book.note('dwight', 'jim', 'refusal');
  assert.strictEqual(director.tierFor(r), 'milestone');
});

test('a wedged hidden session is cut off fast and retried once', async () => {
  const { calls, director } = harness((n) => {
    if (n === 1) throw new Error('pty wedged');
    return { ok: true, text: '["did you get my message","no"]' };
  });
  director.request(req('jim', 'pam'));
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].timeoutMs <= 30_000,
    `first attempt must give up well before 120s, got ${calls[0].timeoutMs}ms`);
  assert.ok(calls[0].timeoutMs >= 20_000, 'but still leave a real session room to answer');

  await waitFor(() => calls.length === 2, 'the retry');
  assert.ok(calls[1].timeoutMs <= calls[0].timeoutMs, 'the retry should not be looser');

  // And the retry's exchange is what the pair actually gets next time.
  await waitFor(() => director.request(req('jim', 'pam')).lines !== null, 'the brewed exchange');
});

test('a failed brew still releases the slot instead of blocking forever', async () => {
  const { calls, director } = harness(() => ({ ok: false, error: 'boom' }));
  director.request(req('jim', 'pam'));
  await waitFor(() => calls.length === 2, 'both attempts');
  // Both attempts done → nothing in flight, and the floor just plays canned lines.
  assert.strictEqual(director.request(req('jim', 'pam')).lines, null);
});

test('a late exchange handed back is replayed at the pair\'s next meeting', () => {
  const { director } = harness(() => ({ ok: false }));
  director.stash('jim', 'pam', ['you left your mug again', 'i know']);

  // Wrong direction: these lines open with Jim, so Pam opening gets nothing.
  assert.strictEqual(director.request(req('pam', 'jim')).lines, null);

  const back = director.request(req('jim', 'pam'));
  assert.deepStrictEqual(back.lines, ['you left your mug again', 'i know']);
  // Consumed exactly once.
  assert.strictEqual(director.request(req('jim', 'pam')).lines, null);
});

test('an owed exchange suppresses a fresh brew for that pair', () => {
  const { calls, director } = harness(OK);
  director.stash('jim', 'pam', ['one', 'two']);
  // Pam opens, so the stashed Jim-first exchange is not consumed — but the pair
  // is still owed one, and paying for a second would be waste.
  director.request(req('pam', 'jim'));
  assert.strictEqual(calls.length, 0,
    'no point paying for a new exchange while one is already owed');

  // Once it has actually been spoken, the pair is back in the normal rotation.
  assert.deepStrictEqual(director.request(req('jim', 'pam')).lines, ['one', 'two']);
  assert.strictEqual(calls.length, 1);
});

// ─── Language ───────────────────────────────────────────────────────────────
// The prompt is written in English and used to say nothing about which language
// to ANSWER in, so every brewed exchange came back in English — playing beside
// the canned break-room pools, which ARE translated. The directive is derived
// from the UI language the user already picked, never hardcoded.

test('a Spanish UI asks for LATIN-AMERICAN Spanish, not Spain Spanish', () => {
  const { calls, director } = harness(OK, { language: 'es' });
  director.request(req('jim', 'pam'));
  assert.strictEqual(calls.length, 1);
  const { prompt } = calls[0];
  assert.ok(/ESPAÑOL LATINOAMERICANO/.test(prompt), 'the prompt must name the variety');
  for (const banned of ['vosotros', 'vale', 'ordenador', 'móvil']) {
    assert.ok(prompt.includes(banned),
      `the peninsular form "${banned}" must be named as something to avoid`);
  }
  for (const wanted of ['ustedes', 'computadora', 'celular']) {
    assert.ok(prompt.includes(wanted), `"${wanted}" is the LatAm form to prefer`);
  }
});

test('a regional Spanish tag still lands on the same directive', () => {
  const { calls, director } = harness(OK, { language: 'es-MX' });
  director.request(req('jim', 'pam'));
  assert.ok(/ESPAÑOL LATINOAMERICANO/.test(calls[0].prompt),
    'a region subtag must not fall through to English');
});

test('English — and anything unrecognised — leaves the prompt untouched', () => {
  const en = harness(OK, { language: 'en' });
  en.director.request(req('jim', 'pam'));
  assert.ok(!/IDIOMA/.test(en.calls[0].prompt), 'no language directive in English');

  // The overwhelmingly common case: an install that never opened the picker.
  const unset = harness(OK);
  unset.director.request(req('jim', 'pam'));
  assert.strictEqual(unset.calls[0].prompt, en.calls[0].prompt,
    'an unset language must be byte-for-byte the pre-existing English prompt');

  const other = harness(OK, { language: 'qq-ZZ' });
  other.director.request(req('jim', 'pam'));
  assert.strictEqual(other.calls[0].prompt, en.calls[0].prompt,
    'a locale with no directive behaves exactly like English');
});

test('everything stays inert while the feature flag is off', () => {
  const { calls, director, setEnabled, home } = harness(OK);
  setEnabled(false);

  const res = director.request(req('jim', 'pam'));
  assert.strictEqual(res.lines, null);
  assert.strictEqual(res.rel.flavor, '');
  assert.strictEqual(calls.length, 0, 'no hidden session may spawn with the flag off');

  director.stash('jim', 'pam', ['a', 'b']);
  setEnabled(true);
  assert.strictEqual(director.request(req('jim', 'pam')).lines, null,
    'a stash taken while the flag was off must not be kept');
  assert.ok(!fs.existsSync(path.join(home, 'office-relationships.json')),
    'the relationship file must not be written by a disabled request');
});
