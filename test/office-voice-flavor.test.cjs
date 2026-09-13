'use strict';

// OfficeVoiceDirector + the shared BrewSlot (src/main/officeVoice.ts,
// src/main/brewSlot.ts).
//
// What this file exists to hold still:
//   1. THE MESSAGE IS NEVER TOUCHED. The director takes a SUBJECT line and a
//      soul and hands back a separate aside string keyed by message id. A body
//      must not reach the prompt even if a caller puts one in the payload.
//   2. ONE HIDDEN SESSION, EVER. The café director and the voice director share
//      a single BrewSlot, so a brew in flight for one blocks the other. Two
//      private budgets would have meant two concurrent hidden Claude sessions.
//   3. COST. The expensive model establishes an agent's voice once; every later
//      message from that agent is routine.
//   4. NO RETRY STORM. A message whose brew came back empty is marked and never
//      brewed again — a newer message always deserves the slot more.
//   5. THE FLAG. Everything is inert with officeChatterEnabled off.
//
// The hidden Claude session is stubbed by swapping the loaded module's export;
// brewSlot calls it through the module object, so the swap is seen.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const hidden = loadTs('src/main/hiddenClaude.ts');
const { BrewSlot } = loadTs('src/main/brewSlot.ts');
const { OfficeVoiceDirector, parseAside, buildAsidePrompt } = loadTs('src/main/officeVoice.ts');
const { OfficeChatDirector } = loadTs('src/main/officeChat.ts');
const { RelationshipBook } = loadTs('src/main/officeRel.ts');

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-voice-'));

const soul = (id) => ({ id, name: id, character: 'Dwight', role: 'beet farmer', status: 'working' });
const item = (id, from, subject) => ({ id, act: 'request', subject, soul: soul(from) });

const waitFor = async (cond, label, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A voice director on a throwaway home, plus a stub hidden session. Optionally
 *  shares its slot with a café director so the two can be raced. */
function harness(reply, opts = {}) {
  const home = tmpHome();
  const calls = [];
  let enabled = true;
  hidden.runHiddenClaude = async (prompt, o) => {
    calls.push({ prompt, ...o });
    return reply(calls.length);
  };
  const slot = new BrewSlot({ getHome: () => home, getCommand: () => 'claude' });
  const director = new OfficeVoiceDirector({
    getHome: () => home,
    getCommand: () => 'claude',
    getModel: (tier) => (tier === 'milestone' ? 'MODEL-MILESTONE' : 'MODEL-ROUTINE'),
    // The app's UI language (harness config `language`); `opts.language`
    // omitted = unset, i.e. the English default every untouched install has.
    getLanguage: () => opts.language,
    isEnabled: () => enabled,
    slot
  });
  const out = { home, calls, director, slot, setEnabled: (v) => { enabled = v; } };
  if (opts.withCafe) {
    out.book = new RelationshipBook(() => home);
    out.chat = new OfficeChatDirector({
      getHome: () => home,
      getCommand: () => 'claude',
      getModel: () => 'MODEL-CAFE',
      isEnabled: () => enabled,
      rel: out.book,
      slot
    });
  }
  return out;
}

const OK = (line) => () => ({ ok: true, text: JSON.stringify([line]) });

test('an aside is brewed in the background and returned on a later poll', async () => {
  const { calls, director } = harness(OK('fine. sending it.'));

  // First poll is instant and empty — nothing has been written yet.
  assert.deepStrictEqual(director.request({ items: [item('m1', 'dwight', 'schrute farms deploy')] }).asides, {});
  assert.strictEqual(calls.length, 1, 'the first bare message should start ONE brew');

  await waitFor(() => director.request({ items: [item('m1', 'dwight', 'schrute farms deploy')] }).asides.m1,
    'the brewed aside');
  const res = director.request({ items: [item('m1', 'dwight', 'schrute farms deploy')] });
  assert.strictEqual(res.asides.m1, 'fine. sending it.');
  assert.strictEqual(calls.length, 1, 'a message that already has an aside must not be brewed again');
});

test('the prompt carries the SUBJECT and the soul — never a body', async () => {
  const { calls, director } = harness(OK('mm.'));
  director.request({
    items: [{
      id: 'm1',
      act: 'request',
      subject: 'rerun the flaky suite',
      // A caller that wrongly stuffs a body in must not leak it into the prompt.
      body: 'AWS_SECRET=hunter2 and the stack trace at src/main/index.ts:4012',
      soul: soul('dwight')
    }]
  });
  assert.strictEqual(calls.length, 1);
  const { prompt } = calls[0];
  assert.ok(prompt.includes('rerun the flaky suite'), 'the subject is what the aside reacts to');
  assert.ok(prompt.includes('Dwight'), 'the soul fronting the agent has to be in the prompt');
  assert.ok(prompt.includes('beet farmer'), 'and its real job');
  assert.ok(!prompt.includes('hunter2'), 'a body must never reach the flavour prompt');
  assert.ok(!prompt.includes('AWS_SECRET'), 'a body must never reach the flavour prompt');
});

test('the expensive model establishes an agent\'s voice exactly once', () => {
  const { director } = harness(OK('ok'));
  assert.strictEqual(director.tierFor('dwight'), 'milestone',
    'the first message from an agent is where the good model earns its price');
  assert.strictEqual(director.tierFor('dwight'), 'routine');
  assert.strictEqual(director.tierFor('dwight'), 'routine');
  assert.strictEqual(director.tierFor('jim'), 'milestone', 'a different soul is its own first time');
});

test('the first brew for an agent uses the milestone model', () => {
  const { calls, director } = harness(OK('ok'));
  director.request({ items: [item('m1', 'dwight', 'subject')] });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].model, 'MODEL-MILESTONE');
});

test('a message whose brew comes up empty is never brewed again', async () => {
  const { calls, director } = harness(() => ({ ok: false, error: 'boom' }));
  director.request({ items: [item('m1', 'dwight', 'subject')] });
  await waitFor(() => calls.length === 2, 'the attempt and its one retry');
  await waitFor(() => director.spent.has('m1'), 'the message being written off');
  assert.strictEqual(director.request({ items: [item('m1', 'dwight', 'subject')] }).asides.m1, undefined,
    'and it simply shows without flavour');
});

test('a milestone brew that fails hands the agent\'s voice back', async () => {
  const { calls, director } = harness(() => ({ ok: false, error: 'boom' }));
  director.request({ items: [item('m1', 'dwight', 'subject')] });
  await waitFor(() => director.spent.has('m1'), 'the first message being written off');
  assert.strictEqual(calls[0].model, 'MODEL-MILESTONE');
  // Nothing was ever written for dwight, so nothing established his voice: the
  // next message from him must still get the establishing model rather than
  // being demoted to routine for the rest of the session.
  assert.strictEqual(director.tierFor('dwight'), 'milestone',
    'a failed attempt must not consume the agent\'s one milestone');
});

test('a milestone brew that succeeds keeps the voice claimed', async () => {
  const { director } = harness(OK('sure.'));
  director.request({ items: [item('m1', 'dwight', 'subject')] });
  await waitFor(() => director.request({ items: [item('m1', 'dwight', 'subject')] }).asides.m1,
    'the brewed aside');
  assert.strictEqual(director.tierFor('dwight'), 'routine',
    'the voice is established, so everything after copies it');
});

test('pruning write-offs drops the OLDEST, never the whole set', () => {
  const { director } = harness(OK('x'));
  // Far past the cap, oldest first — a Set keeps insertion order.
  for (let i = 0; i < 500; i++) director.spent.add(`old-${i}`);
  director.spent.add('still-on-screen');
  // sweep() runs on every request.
  director.request({ items: [item('fresh', 'dwight', 'subject')] });

  assert.ok(director.spent.size <= 400, `spent should be pruned, got ${director.spent.size}`);
  assert.ok(director.spent.size > 0, 'a wholesale clear would let old messages be brewed again');
  assert.ok(director.spent.has('still-on-screen'),
    'the most recent write-off must survive — one attempt per message, ever');
  assert.ok(!director.spent.has('old-0'), 'the oldest write-off is the one that retires');
});

test('the café and the work-message flavour share ONE hidden session slot', async () => {
  let release;
  const hang = new Promise((r) => { release = r; });
  const { calls, director, chat } = harness(async () => { await hang; return { ok: true, text: '["a","b"]' }; },
    { withCafe: true });

  chat.request({
    a: { id: 'jim', name: 'jim', character: 'Jim', role: 'dev', status: 'idle' },
    b: { id: 'pam', name: 'pam', character: 'Pam', role: 'design', status: 'idle' },
    mood: 'generic', spot: 'table'
  });
  assert.strictEqual(calls.length, 1, 'the café brew took the slot');

  director.request({ items: [item('m1', 'dwight', 'subject')] });
  assert.strictEqual(calls.length, 1,
    'a second hidden session must not start while one is in flight');

  release();
  await waitFor(() => !chat.slot.busy, 'the café brew to settle');
});

// ─── Language ───────────────────────────────────────────────────────────────
// An aside is muttered BESIDE a message in the user's own app. It has to be in
// the language that app is speaking — which the prompt never used to say, so it
// was always English. Derived from the UI language, never hardcoded.

test('a Spanish UI gets its aside in LATIN-AMERICAN Spanish', () => {
  const { calls, director } = harness(OK('ahi te va.'), { language: 'es' });
  director.request({ items: [item('m1', 'dwight', 'subject')] });
  assert.strictEqual(calls.length, 1);
  const { prompt } = calls[0];
  assert.ok(/ESPAÑOL LATINOAMERICANO/.test(prompt), 'the prompt must name the variety');
  assert.ok(prompt.includes('vosotros') && prompt.includes('ordenador'),
    'the peninsular forms must be named as things to avoid');
  assert.ok(prompt.includes('computadora') && prompt.includes('celular'),
    'and the LatAm forms as the ones to prefer');
});

test('every language the app ships gets a directive, not just Spanish', () => {
  // Arabic and Chinese used to fall through to English. That was survivable
  // while a TRANSLATED canned pool alternated with the brewed lines; with the
  // pools deleted it means the whole break room speaks English at a user who
  // picked another language — a net regression, so the table covers all of them.
  const ar = harness(OK('تمام.'), { language: 'ar' });
  ar.director.request({ items: [item('m1', 'dwight', 'subject')] });
  assert.ok(/العربية الفصحى/.test(ar.calls[0].prompt), 'Arabic must name the variety wanted');

  const zh = harness(OK('好。'), { language: 'zh-CN' });
  zh.director.request({ items: [item('m1', 'dwight', 'subject')] });
  assert.ok(/简体中文/.test(zh.calls[0].prompt), 'Chinese must name the script wanted');

  // Three different languages, three different prompts — no accidental sharing.
  const es = harness(OK('va.'), { language: 'es' });
  es.director.request({ items: [item('m1', 'dwight', 'subject')] });
  const prompts = [ar.calls[0].prompt, zh.calls[0].prompt, es.calls[0].prompt];
  assert.strictEqual(new Set(prompts).size, 3);
});

test('a region tag still resolves to its language (zh-CN, es-MX, ar-EG)', () => {
  // The UI persists a full tag; the directive table is keyed on the base subtag.
  for (const [language, marker] of [['zh-CN', /简体中文/], ['es-MX', /ESPAÑOL LATINOAMERICANO/], ['ar-EG', /العربية الفصحى/]]) {
    const h = harness(OK('ok.'), { language });
    h.director.request({ items: [item('m1', 'dwight', 'subject')] });
    assert.ok(marker.test(h.calls[0].prompt), `${language} must resolve to its directive`);
  }
});

test('English — and an unset language — leave the aside prompt untouched', () => {
  const en = harness(OK('fine.'), { language: 'en' });
  en.director.request({ items: [item('m1', 'dwight', 'subject')] });
  assert.ok(!/IDIOMA/.test(en.calls[0].prompt), 'no language directive in English');

  const unset = harness(OK('fine.'));
  unset.director.request({ items: [item('m1', 'dwight', 'subject')] });
  assert.strictEqual(unset.calls[0].prompt, en.calls[0].prompt,
    'an unset language must be byte-for-byte the pre-existing English prompt');
});

test('buildAsidePrompt is the same function the director uses', () => {
  // The exported builder and the director must not drift on the language rule:
  // a prompt built by hand for 'es' is the prompt the director would have sent.
  const { calls, director } = harness(OK('va.'), { language: 'es' });
  const it = item('m1', 'dwight', 'subject');
  director.request({ items: [it] });
  assert.strictEqual(calls[0].prompt, buildAsidePrompt(it, 'es'));
  assert.notStrictEqual(buildAsidePrompt(it, 'es'), buildAsidePrompt(it, 'en'));
});

test('everything stays inert while the feature flag is off', () => {
  const { calls, director, setEnabled } = harness(OK('nope'));
  setEnabled(false);
  const res = director.request({ items: [item('m1', 'dwight', 'subject')] });
  assert.deepStrictEqual(res.asides, {});
  assert.strictEqual(calls.length, 0, 'no hidden session may spawn with the flag off');
});

test('a malformed payload is dropped rather than repaired', () => {
  const { calls, director } = harness(OK('x'));
  assert.deepStrictEqual(director.request({ items: 'not an array' }).asides, {});
  assert.deepStrictEqual(director.request({ items: [{ id: 'm1' }] }).asides, {}, 'no soul → no flavour');
  assert.deepStrictEqual(director.request({ items: [{ soul: soul('dwight') }] }).asides, {}, 'no id → no flavour');
  assert.strictEqual(calls.length, 0);
});

test('parseAside survives the shapes a cheap model actually returns', () => {
  assert.strictEqual(parseAside('["fine."]'), 'fine.');
  assert.strictEqual(parseAside('  fine.  '), 'fine.', 'a bare line still works');
  assert.strictEqual(parseAside('"fine."'), 'fine.', 'stray quotes are stripped');
  assert.strictEqual(parseAside('- fine.'), 'fine.', 'so is a bullet');
  assert.strictEqual(parseAside(''), null);
  assert.strictEqual(parseAside('[]'), null);
  const long = parseAside(JSON.stringify(['x'.repeat(300)]));
  assert.ok(long.length <= 60, `an aside is a garnish, got ${long.length} chars`);
});
