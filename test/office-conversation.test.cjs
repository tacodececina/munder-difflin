'use strict';

// THE CONVERSATION TAB — traits by rules, summaries without a model, and an
// appearance proposal that cannot apply itself.
//
// Three properties are worth protecting here, and every test below is one of
// them wearing a different hat:
//
//   1. NOTHING IS INVENTED. Every trait is a ratio of things that happened and
//      carries the two numbers it came from; every conversation summary is a
//      count. No model is asked anything, anywhere on this tab.
//   2. DIRECTION IS NEVER FLATTENED. What A feels about B and what B feels
//      about A stay two separate readings all the way to the screen.
//   3. A PROPOSAL IS NOT A CHANGE. Generating, storing, listing and rejecting an
//      appearance proposal must touch neither the character registry nor the
//      agent. Only an explicit approval writes, and it is reversible.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  TraitBook, deriveTraits, traitProse, TRAITS_FILE_NAME, MIN_LINES_FOR_TRAITS
} = loadTs('src/main/officeTraits.ts');
const { routeEventKind, routeIsNotable } = loadTs('src/main/officeRel.ts');
const {
  buildConversations, summarizeConversation, pairVolumes, RESUME_WINDOW_MS
} = loadTs('src/renderer/src/store/chatterSummary.ts');
const { buildRelPairs, edgeToneKey } = loadTs('src/renderer/src/store/relView.ts');
const {
  proposeLook, applyLookPatch, approveLookProposal, rejectLookProposal,
  patchIsSatisfied, clearDismissals, wasDismissed, MIN_STRENGTH_TO_PROPOSE
} = loadTs('src/renderer/src/store/lookProposal.ts');

const LOCALES = ['en', 'es', 'ar', 'zh-CN'];
const locale = (name) => loadTs(`src/renderer/src/i18n/locales/${name}.json`);

// A counters row with sane defaults, so each test only states what it is about.
const counters = (over) => ({
  id: 'a', lines: 0, chars: 0, questions: 0, exchanges: 0, opened: 0,
  partners: {}, acted: {}, received: {}, lifetimeLines: 0, firstAt: 1, lastAt: 2,
  ...over
});

const traitIds = (reading) => reading.traits.map((t) => t.id);

function tmpHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cth-${label}-`));
}

// ─── 1. Traits are derived, not asserted ─────────────────────────────────────

test('a thin sample earns NO traits at all — silence is the honest answer', () => {
  // Every ratio below would scream "curious" if it were allowed to: 5 of 5 lines
  // are questions. Under the sample floor it says nothing instead, because a
  // personality read off five sentences is noise wearing a label.
  const rows = deriveTraits([counters({ lines: 5, chars: 100, questions: 5, exchanges: 2, opened: 2 })]);
  assert.equal(rows.length, 1);
  assert.deepEqual(traitIds(rows[0]), []);
  assert.ok(MIN_LINES_FOR_TRAITS > 5);
});

test('the one who asks: a question ratio becomes `curious`, carrying its arithmetic', () => {
  const rows = deriveTraits([counters({ lines: 40, chars: 1400, questions: 16, exchanges: 10, opened: 5 })]);
  const curious = rows[0].traits.find((t) => t.id === 'curious');
  assert.ok(curious, 'expected a curious trait');
  // The panel prints these two numbers, so the claim can be audited rather than
  // believed. 16 of 40 is what actually happened.
  assert.deepEqual(curious.evidence, { a: 16, b: 40 });
  assert.ok(curious.strength > 0 && curious.strength <= 1);
});

test('terse and expansive are opposite ends of one measurement and never co-occur', () => {
  const short = deriveTraits([counters({ id: 'stanley', lines: 30, chars: 450, exchanges: 8, opened: 3 })]);
  const long = deriveTraits([counters({ id: 'michael', lines: 30, chars: 1800, exchanges: 8, opened: 3 })]);
  assert.ok(traitIds(short[0]).includes('terse'));
  assert.ok(!traitIds(short[0]).includes('expansive'));
  assert.ok(traitIds(long[0]).includes('expansive'));
  assert.ok(!traitIds(long[0]).includes('terse'));
});

test('who opens a conversation is its own trait, in both directions', () => {
  const starter = deriveTraits([counters({ id: 'kelly', lines: 40, chars: 1400, exchanges: 10, opened: 9 })]);
  const waiter = deriveTraits([counters({ id: 'toby', lines: 40, chars: 1400, exchanges: 10, opened: 1 })]);
  assert.ok(traitIds(starter[0]).includes('opener'));
  assert.ok(traitIds(waiter[0]).includes('listener'));
});

test('"checks if you are okay" comes from what they DID, not from what they said', () => {
  // This agent barely speaks — under the line floor, so no spoken trait can
  // fire. The evidence for who they are is entirely in the interactions they
  // INITIATED, which is the whole reason the tally is kept separately.
  const rows = deriveTraits([counters({
    id: 'pam', lines: 3, chars: 60,
    acted: { checkin: 6, handoff: 4, reply: 2 }
  })]);
  const caretaker = rows[0].traits.find((t) => t.id === 'caretaker');
  assert.ok(caretaker, 'expected a caretaker trait from check-ins alone');
  assert.deepEqual(caretaker.evidence, { a: 6, b: 12 });
  assert.ok(!traitIds(rows[0]).includes('curious'));
});

test('refusals make a contrarian — and only the ones they INITIATED count', () => {
  const pusher = deriveTraits([counters({ id: 'dwight', acted: { refusal: 4, handoff: 6 } })]);
  // Being refused four times says something about the floor, not about you.
  const refused = deriveTraits([counters({ id: 'jim', acted: { handoff: 10 }, received: { refusal: 4 } })]);
  assert.ok(traitIds(pusher[0]).includes('contrarian'));
  assert.ok(!traitIds(refused[0]).includes('contrarian'));
});

test('reputation is read off INCOMING edges — how others see you, not how you see them', () => {
  // `angela` reads everyone coldly and tensely; everyone reads HER warmly. The
  // traits she earns must describe the second fact, not the first: being
  // disliked and disliking are different things about a person.
  const edges = [
    { from: 'angela', to: 'jim', warmth: -0.5, tension: 0.8, familiarity: 0.6 },
    { from: 'angela', to: 'pam', warmth: -0.4, tension: 0.7, familiarity: 0.6 },
    { from: 'jim', to: 'angela', warmth: 0.6, tension: 0.05, familiarity: 0.6 },
    { from: 'pam', to: 'angela', warmth: 0.7, tension: 0.05, familiarity: 0.6 }
  ];
  const rows = deriveTraits([counters({ id: 'angela' })], edges);
  const ids = traitIds(rows[0]);
  assert.ok(ids.includes('beloved'), 'others read her warmly, so she is beloved');
  assert.ok(!ids.includes('abrasive'), 'her own tension toward others is not a fact about her reputation');
});

test('an agent nobody has any tension toward is not abrasive, however tense they feel', () => {
  const edges = [
    { from: 'x', to: 'y', warmth: 0, tension: 0.9, familiarity: 0.5 },
    { from: 'x', to: 'z', warmth: 0, tension: 0.9, familiarity: 0.5 },
    { from: 'y', to: 'x', warmth: 0.1, tension: 0.05, familiarity: 0.5 },
    { from: 'z', to: 'x', warmth: 0.1, tension: 0.05, familiarity: 0.5 }
  ];
  assert.ok(!traitIds(deriveTraits([counters({ id: 'x' })], edges)[0]).includes('abrasive'));
});

test('traits are ranked strongest first and the ordering is stable across identical calls', () => {
  const input = [counters({
    id: 'a', lines: 60, chars: 600, questions: 30, exchanges: 12, opened: 11,
    acted: { checkin: 8, handoff: 2 }
  })];
  const first = deriveTraits(input);
  const second = deriveTraits(input);
  assert.deepEqual(traitIds(first[0]), traitIds(second[0]));
  const strengths = first[0].traits.map((t) => t.strength);
  assert.deepEqual(strengths, [...strengths].sort((x, y) => y - x));
});

// ─── 2. The prompt feedback loop is additive and observable ──────────────────

test('an agent with no traits contributes NOTHING to the prompt', () => {
  // The empty string is load-bearing: buildPrompt filters falsy parts, so a
  // quiet floor gets the exact prompt it got before this feature existed.
  assert.equal(traitProse(undefined), '');
  assert.equal(traitProse(null), '');
  assert.equal(traitProse({ id: 'a', traits: [], lines: 0, exchanges: 0, partners: 0 }), '');
});

test('trait prose names at most three traits and reads as a sentence fragment', () => {
  const reading = deriveTraits([counters({
    id: 'a', lines: 60, chars: 600, questions: 30, exchanges: 12, opened: 11,
    acted: { checkin: 8, handoff: 2 }
  })])[0];
  assert.ok(reading.traits.length >= 4, 'this fixture should earn more traits than the prompt shows');
  const prose = traitProse(reading);
  assert.ok(prose.length > 0);
  assert.equal(prose.split(';').length, 3);
  assert.ok(!/\d/.test(prose), 'the prompt gets words, never the raw numbers');
});

// ─── 3. The trait book: counting, forgetting, persistence, the flag ──────────

test('observe attributes lines by alternation and stores no text whatsoever', () => {
  const home = tmpHome('traits');
  const book = new TraitBook({ getHome: () => home, isEnabled: () => true });
  book.observe('jim', 'pam', ['hey', 'you good?', 'yeah', 'sure?'], 1000);
  const [jim, pam] = ['jim', 'pam'].map((id) => book.snapshot().find((c) => c.id === id));
  assert.equal(jim.lines, 2);
  assert.equal(pam.lines, 2);
  assert.equal(jim.opened, 1, 'the opener is `from`, by the alternation contract');
  assert.equal(pam.opened, 0);
  assert.equal(pam.questions, 2, 'both of pam\'s lines ended in a question mark');
  assert.equal(jim.questions, 0);
  // The privacy property, stated as an assertion: no serialization of this book
  // can contain a spoken word.
  const serialized = JSON.stringify(book.snapshot());
  for (const word of ['hey', 'you good', 'yeah', 'sure']) {
    assert.ok(!serialized.includes(word), `"${word}" must not be stored`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('an Arabic question mark is a question too', () => {
  const home = tmpHome('traits-ar');
  const book = new TraitBook({ getHome: () => home, isEnabled: () => true });
  book.observe('a', 'b', ['كيف حالك؟'], 1);
  assert.equal(book.snapshot().find((c) => c.id === 'a').questions, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('forgetting halves the weights but not the ratios, and never the lifetime count', () => {
  const home = tmpHome('forget');
  const book = new TraitBook({ getHome: () => home, isEnabled: () => true });
  // Every line is a question, so the ratio is exactly 1 before and after the
  // halving — which is the point: forgetting must not itself be an opinion.
  for (let i = 0; i < 500; i++) book.observe('a', 'b', ['q?', 'q?'], 1000 + i);
  const a = book.snapshot().find((c) => c.id === 'a');
  assert.ok(a.lines < 500, 'weights were halved at the ceiling');
  assert.equal(a.questions / a.lines, 1);
  assert.equal(a.lifetimeLines, 500, 'the honest lifetime count is never scaled');
  fs.rmSync(home, { recursive: true, force: true });
});

test('with the chatter flag OFF the book writes nothing and creates no file', () => {
  const home = tmpHome('flag-off');
  const book = new TraitBook({ getHome: () => home, isEnabled: () => false });
  book.observe('jim', 'pam', ['hey', 'hi'], 1);
  book.noteEvent('jim', 'pam', 'checkin', 1);
  book.flush();
  assert.deepEqual(book.snapshot(), []);
  assert.equal(fs.existsSync(path.join(home, TRAITS_FILE_NAME)), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('counters survive a restart, and purge erases the file with them', () => {
  const home = tmpHome('persist');
  const first = new TraitBook({ getHome: () => home, isEnabled: () => true });
  first.observe('jim', 'pam', ['a', 'b?'], 1);
  first.noteEvent('jim', 'pam', 'checkin', 2);
  first.flush();
  assert.ok(fs.existsSync(path.join(home, TRAITS_FILE_NAME)));

  const second = new TraitBook({ getHome: () => home, isEnabled: () => true });
  const jim = second.snapshot().find((c) => c.id === 'jim');
  assert.equal(jim.lines, 1);
  assert.equal(jim.acted.checkin, 1);

  second.purge();
  assert.equal(fs.existsSync(path.join(home, TRAITS_FILE_NAME)), false);
  assert.deepEqual(second.snapshot(), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a corrupt save file starts fresh instead of crashing the floor', () => {
  const home = tmpHome('corrupt');
  fs.writeFileSync(path.join(home, TRAITS_FILE_NAME), '{not json at all', 'utf8');
  const book = new TraitBook({ getHome: () => home, isEnabled: () => true });
  assert.deepEqual(book.snapshot(), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the route classifier is shared, so the relationship book and the traits agree', () => {
  assert.equal(routeEventKind('refuse'), 'refusal');
  assert.equal(routeEventKind('agree'), 'reply');
  assert.equal(routeEventKind('done'), 'reply');
  assert.equal(routeEventKind('request'), 'handoff');
  assert.equal(routeIsNotable('jim', 'human'), false);
  assert.equal(routeIsNotable('jim', 'jim'), false);
  assert.equal(routeIsNotable('jim', 'pam'), true);
});

// ─── 4. Summaries, computed and not generated ────────────────────────────────

const line = (ts, conv, from, to, by, text) => ({ ts, conv, from, to, by, text, gen: true });

test('lines are grouped back into the exchange they were spoken in, newest first', () => {
  const convs = buildConversations([
    line(1000, 'c1', 'jim', 'pam', 'jim', 'hey'),
    line(1000, 'c1', 'jim', 'pam', 'pam', 'hi'),
    line(9000, 'c2', 'pam', 'jim', 'pam', 'still on that ticket?'),
    line(9000, 'c2', 'pam', 'jim', 'jim', 'always')
  ]);
  assert.deepEqual(convs.map((c) => c.conv), ['c2', 'c1']);
  assert.equal(convs[0].lines.length, 2);
  assert.equal(convs[0].from, 'pam', 'whoever opened the exchange is `from`');
});

test('malformed rows are skipped, never repaired and never fatal', () => {
  const convs = buildConversations([
    null,
    'nope',
    { ts: 'later', conv: 'c', from: 'a', to: 'b', by: 'a', text: 'x' },  // no numeric ts
    { ts: 1, conv: 'c', from: 'a', by: 'a', text: 'x' },                  // no recipient
    { ts: 1, conv: 'c', from: 'a', to: 'b', by: 'a', text: '   ' },       // blank
    line(2, 'ok', 'a', 'b', 'a', 'the only good row')
  ]);
  assert.equal(convs.length, 1);
  assert.equal(convs[0].lines.length, 1);
  assert.deepEqual(buildConversations('not an array'), []);
});

test('the summary describes SHAPE — nod, questions, one-sided, back and forth', () => {
  const nod = summarizeConversation([{ by: 'a', text: 'morning' }, { by: 'b', text: 'morning' }]);
  assert.equal(nod.shape, 'nod');

  const quiz = summarizeConversation([
    { by: 'a', text: 'you okay?' }, { by: 'b', text: 'fine' },
    { by: 'a', text: 'sure?' }, { by: 'b', text: 'yes' }, { by: 'a', text: 'really?' }
  ]);
  assert.equal(quiz.shape, 'interrogation');
  assert.equal(quiz.questions, 3);

  const monologue = summarizeConversation([
    { by: 'a', text: 'so' }, { by: 'a', text: 'anyway' }, { by: 'a', text: 'and then' },
    { by: 'a', text: 'so I said' }, { by: 'b', text: 'mm' }
  ]);
  assert.equal(monologue.shape, 'oneSided');
  assert.equal(monologue.dominant, 'a');

  const traded = summarizeConversation([
    { by: 'a', text: 'no' }, { by: 'b', text: 'yes' }, { by: 'a', text: 'no' },
    { by: 'b', text: 'yes' }, { by: 'a', text: 'fine' }, { by: 'b', text: 'thank you' }
  ]);
  assert.equal(traded.shape, 'backAndForth');
  assert.equal(traded.dominant, undefined, 'an even trade has no dominant speaker');
});

test('a three-line exchange does not make its extra speaker "dominant"', () => {
  // Odd lengths always leave someone one ahead. Calling that domination would
  // label essentially every short chat.
  const s = summarizeConversation([
    { by: 'a', text: 'hey' }, { by: 'b', text: 'hi' }, { by: 'a', text: 'later' }
  ]);
  assert.equal(s.dominant, undefined);
});

test('the highlight is a real quoted line, never a paraphrase', () => {
  const s = summarizeConversation([
    { by: 'a', text: 'hm' },
    { by: 'b', text: 'the build is red again and nobody has looked at it' }
  ]);
  assert.equal(s.highlight, 'the build is red again and nobody has looked at it');
  assert.equal(s.highlightBy, 'b');
});

test('a conversation counts as resumed only inside the model\'s own resume window', () => {
  const base = 1_000_000;
  const soon = buildConversations([
    line(base, 'c1', 'a', 'b', 'a', 'one'),
    line(base + 10 * 60_000, 'c2', 'a', 'b', 'a', 'two')
  ]);
  assert.equal(soon[0].summary.resumed, true);
  assert.equal(soon[1].summary.resumed, false, 'their first conversation resumes nothing');

  const later = buildConversations([
    line(base, 'c1', 'a', 'b', 'a', 'one'),
    line(base + RESUME_WINDOW_MS + 1, 'c2', 'a', 'b', 'a', 'two')
  ]);
  assert.equal(later[0].summary.resumed, false);
});

test('the resume window matches the one the dialogue prompt is written against', () => {
  // If these two ever drift, the panel calls a chat "new" while the prompt that
  // produced it said "you were talking about this minutes ago".
  const chat = fs.readFileSync(path.join(__dirname, '..', 'src/main/officeChat.ts'), 'utf8');
  const match = chat.match(/RESUME_WINDOW_MS\s*=\s*(\d+)\s*\*\s*60_000/);
  assert.ok(match, 'officeChat.ts should declare RESUME_WINDOW_MS in minutes');
  assert.equal(RESUME_WINDOW_MS, Number(match[1]) * 60_000);
});

test('pair volumes count both directions as one conversational history', () => {
  const convs = buildConversations([
    line(1, 'c1', 'a', 'b', 'a', 'x'), line(1, 'c1', 'a', 'b', 'b', 'y'),
    line(2, 'c2', 'b', 'a', 'b', 'x'), line(2, 'c2', 'b', 'a', 'a', 'y'),
    line(3, 'c3', 'a', 'c', 'a', 'x')
  ]);
  const vols = pairVolumes(convs);
  assert.equal(vols.length, 2);
  assert.deepEqual([vols[0].a, vols[0].b], ['a', 'b']);
  assert.equal(vols[0].conversations, 2);
  assert.equal(vols[0].lines, 4);
});

// ─── 5. Relationships stay directional all the way to the screen ─────────────

const edge = (from, to, warmth, tension, familiarity) =>
  ({ from, to, warmth, tension, familiarity, interactions: 10, flavor: '' });

test('both directions survive to the view — nothing is averaged', () => {
  const pairs = buildRelPairs([
    edge('jim', 'dwight', 0.7, 0.1, 0.8),
    edge('dwight', 'jim', -0.1, 0.6, 0.8)
  ]);
  assert.equal(pairs.length, 1);
  const p = pairs[0];
  // The canonical order is alphabetical, so `a` is dwight here — and `ab` is
  // therefore HIS reading of jim. Which side is which is exactly the thing this
  // view must not get wrong, so the test states it rather than assuming it.
  assert.equal(p.a, 'dwight');
  assert.equal(p.ab.warmth, -0.1, 'dwight -> jim');
  assert.equal(p.ba.warmth, 0.7, 'jim -> dwight');
  // The tell-tale of an averaging bug: 0.3 appearing anywhere in the output.
  assert.ok(!JSON.stringify(p).includes('0.30000'));
  assert.ok(Math.abs(p.asymmetry - 0.8) < 1e-9);
});

test('`ab` always means the same direction regardless of snapshot order', () => {
  const forward = buildRelPairs([edge('a', 'b', 0.9, 0, 0.5), edge('b', 'a', 0.1, 0, 0.5)])[0];
  const reversed = buildRelPairs([edge('b', 'a', 0.1, 0, 0.5), edge('a', 'b', 0.9, 0, 0.5)])[0];
  assert.equal(forward.ab.warmth, 0.9);
  assert.equal(reversed.ab.warmth, 0.9);
  assert.equal(forward.key, reversed.key);
});

test('the most lopsided pair sorts to the top — asymmetry is the point of the model', () => {
  const pairs = buildRelPairs([
    edge('a', 'b', 0.4, 0.05, 0.9), edge('b', 'a', 0.4, 0.05, 0.9),      // mutual
    edge('c', 'd', 0.8, 0.05, 0.5), edge('d', 'c', -0.2, 0.05, 0.5)      // unrequited
  ]);
  assert.equal(pairs[0].a, 'c');
  assert.equal(pairs[0].reciprocity, 'lopsided');
  assert.equal(pairs[1].reciprocity, 'mutual');
});

test('friction held by only one of them is called that, not "lopsided"', () => {
  const p = buildRelPairs([edge('a', 'b', 0.3, 0.7, 0.6), edge('b', 'a', 0.3, 0.05, 0.6)])[0];
  assert.equal(p.reciprocity, 'oneSidedFriction');
});

test('one recorded direction is "unanswered", and the missing side is null — not zero', () => {
  const p = buildRelPairs([edge('a', 'b', 0.5, 0, 0.4)])[0];
  assert.equal(p.reciprocity, 'unanswered');
  assert.equal(p.ba, null, '"we have no history" is not "I feel nothing"');
  assert.equal(edgeToneKey(null), 'none');
});

test('tone labels follow the same bands the relationship flavours branch on', () => {
  assert.equal(edgeToneKey(edge('a', 'b', 0.1, 0, 0.02)), 'neutral');   // barely knows them
  assert.equal(edgeToneKey(edge('a', 'b', 0.7, 0.05, 0.6)), 'fond');
  assert.equal(edgeToneKey(edge('a', 'b', 0.3, 0.5, 0.6)), 'prickly');
  assert.equal(edgeToneKey(edge('a', 'b', 0.25, 0.05, 0.6)), 'warm');
  assert.equal(edgeToneKey(edge('a', 'b', -0.5, 0.05, 0.6)), 'cold');
});

// ─── 6. A PROPOSAL IS NOT A CHANGE ───────────────────────────────────────────

const RECIPE = { skin: 'light', hairc: [1, 2, 3], hair: 'styleShort', cloth: 'polo', c1: [4, 5, 6] };

/** A sink set that records every call. The two WRITE sinks are the ones under
 *  test: nothing but an approval may ever reach them. */
function spySinks() {
  const calls = { saveCharacter: [], setAgentCharacter: [], forget: [], remember: [] };
  return {
    calls,
    saveCharacter: (name, accent, recipe) => {
      calls.saveCharacter.push({ name, accent, recipe });
      return 'custom:new-id';
    },
    setAgentCharacter: (agentId, characterId) => { calls.setAgentCharacter.push({ agentId, characterId }); },
    forget: (id) => { calls.forget.push(id); },
    remember: (applied) => { calls.remember.push(applied); }
  };
}

const proposal = (over) => ({
  id: 'p1', agentId: 'jim', basedOn: 'jim', trait: 'curious',
  patch: { glasses: 'round' }, createdAt: 1, ...over
});

test('deriving a proposal writes NOTHING — it only returns one', () => {
  const sinks = spySinks();
  const ask = proposeLook([{ id: 'curious', strength: 0.9 }], RECIPE);
  assert.deepEqual(ask, { trait: 'curious', patch: { glasses: 'round' } });
  // The derivation cannot reach a sink even in principle; asserting it here
  // pins the SHAPE of the design (pure in, pure out) rather than an accident.
  assert.deepEqual(sinks.calls.saveCharacter, []);
  assert.deepEqual(sinks.calls.setAgentCharacter, []);
  // …and the agent's own recipe is untouched by having been read.
  assert.equal(RECIPE.glasses, undefined);
});

test('REJECTING never applies anything — the core invariant of this feature', () => {
  clearDismissals();
  const sinks = spySinks();
  rejectLookProposal(proposal(), sinks);
  assert.deepEqual(sinks.calls.saveCharacter, [], 'no character may be minted by a rejection');
  assert.deepEqual(sinks.calls.setAgentCharacter, [], 'no agent may be repainted by a rejection');
  assert.deepEqual(sinks.calls.remember, [], 'a rejection is not recorded as an application');
  assert.deepEqual(sinks.calls.forget, ['p1'], 'the only effect is that the ask goes away');
});

test('a rejection leaves no persistent trace, only a session-long "no"', () => {
  clearDismissals();
  assert.equal(wasDismissed('jim', 'curious'), false);
  rejectLookProposal(proposal(), spySinks());
  assert.equal(wasDismissed('jim', 'curious'), true, 'it does not come straight back this session');
  assert.equal(wasDismissed('jim', 'opener'), false, 'saying no to one thing is not saying no to everything');
  assert.equal(wasDismissed('pam', 'curious'), false, 'and it is not a floor-wide veto');
  clearDismissals();
  assert.equal(wasDismissed('jim', 'curious'), false, 'nothing survives the session');
});

test('APPROVING is the only path that writes, and it is reversible', () => {
  const sinks = spySinks();
  const applied = approveLookProposal(proposal(), RECIPE, 'jim', 'Jim', '#6fa8dc', sinks);
  assert.ok(applied);
  assert.equal(sinks.calls.saveCharacter.length, 1);
  assert.deepEqual(sinks.calls.saveCharacter[0].recipe.glasses, 'round');
  assert.deepEqual(sinks.calls.setAgentCharacter, [{ agentId: 'jim', characterId: 'custom:new-id' }]);
  // Reversibility is a stored fact, not a promise: the old character id is kept.
  assert.equal(applied.previousCharacter, 'jim');
  assert.equal(applied.appliedCharacter, 'custom:new-id');
  assert.deepEqual(sinks.calls.forget, ['p1']);
});

test('a stale proposal is dropped rather than applied over a look the user picked', () => {
  const sinks = spySinks();
  // The agent is on `pam` now; the proposal was written against `jim`.
  const applied = approveLookProposal(proposal(), RECIPE, 'pam', 'Jim', '#6fa8dc', sinks);
  assert.equal(applied, null);
  assert.deepEqual(sinks.calls.saveCharacter, []);
  assert.deepEqual(sinks.calls.setAgentCharacter, []);
  assert.deepEqual(sinks.calls.forget, ['p1']);
});

test('approval MINTS a character and never edits the one the agent was wearing', () => {
  const base = { ...RECIPE };
  const sinks = spySinks();
  approveLookProposal(proposal(), base, 'jim', 'Jim', '#6fa8dc', sinks);
  assert.equal(base.glasses, undefined, 'the base recipe is left exactly as it was');
  assert.notEqual(sinks.calls.saveCharacter[0].recipe, base);
});

test('applying a patch never mutates its input', () => {
  const base = { ...RECIPE };
  const next = applyLookPatch(base, { accessory: 'scarf' });
  assert.equal(base.accessory, undefined);
  assert.equal(next.accessory, 'scarf');
  assert.equal(next.skin, 'light');
});

test('nothing is proposed for a look the agent already wears, or for weak evidence', () => {
  assert.equal(proposeLook([{ id: 'curious', strength: 0.9 }], { ...RECIPE, glasses: 'round' }), null);
  assert.equal(proposeLook([{ id: 'curious', strength: MIN_STRENGTH_TO_PROPOSE - 0.01 }], RECIPE), null);
  assert.equal(proposeLook([], RECIPE), null);
  assert.ok(patchIsSatisfied({ ...RECIPE, glasses: 'round' }, { glasses: 'round' }));
});

test('the strongest trait gets to ask, and only one thing is asked for at a time', () => {
  const ask = proposeLook([
    { id: 'curious', strength: 0.4 },
    { id: 'caretaker', strength: 0.95 }
  ], RECIPE);
  assert.equal(ask.trait, 'caretaker');
  assert.equal(Object.keys(ask.patch).length, 1, 'a proposal you cannot hold in your head cannot be approved');
});

test('a trait whose look is already worn steps aside for the next one down', () => {
  const ask = proposeLook([
    { id: 'caretaker', strength: 0.95 },
    { id: 'curious', strength: 0.6 }
  ], { ...RECIPE, accessory: 'scarf' });
  assert.equal(ask.trait, 'curious');
});

// ─── 7. The write boundary, asserted against the source ─────────────────────

test('the conversation tab writes nothing operational — only a character', () => {
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'src/renderer/src/components/ConversationPanel.tsx'), 'utf8'
  );
  // The Phase 6 rule: conversation may READ the work and never write it. These
  // are the calls that would break it.
  for (const forbidden of ['hiveSend', 'hiveTaskUpdate', 'hiveAssign', 'controlAutoDelivery', 'spawnPty', 'killPty']) {
    assert.ok(!panel.includes(forbidden), `ConversationPanel must not call ${forbidden}`);
  }
  // The single permitted write, and it is only ever a character.
  const updates = panel.match(/updateAgent\([^)]*\)/g) ?? [];
  assert.ok(updates.length > 0, 'the approval path does update the agent');
  for (const call of updates) {
    assert.ok(/character/.test(call), `updateAgent may only set a character, got: ${call}`);
  }
});

test('the conversation tab is absent from the UI while the chatter flag is off', () => {
  // INERTIA, in the renderer. index.ts's claim is that with officeChatterEnabled
  // off the whole experiment is absent from the UI — but the tab used to render
  // unconditionally, so every user saw a permanently empty page that polled
  // three IPC channels every five seconds for results that are empty BY DESIGN
  // while the flag is off.
  const panel = fs.readFileSync(
    path.join(__dirname, '..', 'src/renderer/src/components/CommandCenterPanel.tsx'), 'utf8'
  );
  assert.match(panel, /officeChatterEnabled === true/,
    'the tab must read the chatter flag');
  assert.match(panel, /if \(key === 'conversation'\) return showConversation;/,
    'the tab strip must be filtered on the flag');
  assert.match(panel, /!showConversation && tab === 'conversation'/,
    'the panel must never stay parked on a tab that just disappeared');
  assert.match(panel, /tab === 'conversation' && showConversation && <ConversationPanel \/>/,
    'the panel body must be gated too, so the polls never start');
});

// ─── 8. i18n: four locales, and a Latin-American Spanish ────────────────────

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

test('every conversation key exists in all four locales', () => {
  const en = flatten(locale('en').conversation);
  const keys = Object.keys(en);
  assert.ok(keys.length >= 60, `expected a substantial key set, got ${keys.length}`);
  for (const loc of LOCALES.slice(1)) {
    const other = flatten(locale(loc).conversation);
    assert.deepEqual(Object.keys(other).sort(), keys.sort(), `${loc} is missing or has extra keys`);
  }
});

test('the tab itself is named in all four locales', () => {
  for (const loc of LOCALES) {
    const label = locale(loc).commandCenter.tabs.conversation;
    assert.ok(typeof label === 'string' && label.length > 0, `${loc} has no tab label`);
  }
});

test('nothing was left untranslated by copy-pasting English', () => {
  const en = flatten(locale('en').conversation);
  for (const loc of ['es', 'ar', 'zh-CN']) {
    const other = flatten(locale(loc).conversation);
    for (const [key, value] of Object.entries(en)) {
      // One genuine coincidence, not an oversight: "no" is the word in both
      // English and Spanish, and translating it to something longer would make
      // the reject button read as a sentence.
      if (loc === 'es' && key === 'look.reject') continue;
      assert.notEqual(other[key], value, `${loc}.${key} is still the English string`);
    }
  }
});

test('every interpolation placeholder survives translation', () => {
  const en = flatten(locale('en').conversation);
  const vars = (s) => (String(s).match(/\{\{\w+\}\}/g) ?? []).sort();
  for (const loc of ['es', 'ar', 'zh-CN']) {
    const other = flatten(locale(loc).conversation);
    for (const [key, value] of Object.entries(en)) {
      assert.deepEqual(vars(other[key]), vars(value), `${loc}.${key} lost or gained a placeholder`);
    }
  }
});

test('the Spanish is LATIN AMERICAN, not peninsular', () => {
  const es = JSON.stringify(flatten(locale('es').conversation)).toLowerCase();
  // Second-person plural, and the vocabulary that marks Spain.
  for (const tell of ['vosotros', 'vuestro', 'vuestra', 'ordenador', 'vale,', 'coger', 'móvil']) {
    assert.ok(!es.includes(tell), `"${tell}" is peninsular Spanish`);
  }
  // And it actually reads as LatAm rather than as neutral-by-omission.
  assert.ok(/(ac[áa]|pod[ée]s|qued[óo]|platic|gafete|aretes|aud[íi]fonos)/.test(es),
    'expected recognisably Latin-American vocabulary');
});

test('every trait has a label, an evidence sentence and a look, in every locale', () => {
  const ids = Object.keys(locale('en').conversation.trait);
  assert.equal(ids.length, 12);
  for (const loc of LOCALES) {
    const c = locale(loc).conversation;
    for (const id of ids) {
      assert.ok(c.trait[id], `${loc}: no label for ${id}`);
      assert.ok(c.evidence[id], `${loc}: no evidence sentence for ${id}`);
      assert.ok(c.look.change[id], `${loc}: no look for ${id}`);
    }
  }
});
