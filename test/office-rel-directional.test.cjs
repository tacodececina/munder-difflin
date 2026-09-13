'use strict';

// Directional relationship state (src/main/officeRel.ts).
//
// The book used to key on an UNORDERED pair, so A and B always shared one set
// of numbers. It now keys on an ORDERED (from → to) edge, which is what lets an
// unrequited warmth or a one-sided grudge exist at all. These tests pin the
// three things that can silently regress: that the two directions really do
// diverge, that a pre-directional save file still loads (seeding both ways from
// the old symmetric value instead of throwing), and that a new save round-trips.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { RelationshipBook } = loadTs('src/main/officeRel.ts');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'office-rel-'));
}

const SAVE_FILE = 'office-relationships.json';

test('a refusal lands far harder on the refused than on the refuser', () => {
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  book.note('dwight', 'jim', 'refusal');   // dwight refuses jim

  const dwightOnJim = book.get('dwight', 'jim');
  const jimOnDwight = book.get('jim', 'dwight');

  assert.ok(jimOnDwight.tension > dwightOnJim.tension,
    'the refused should carry more tension than the refuser');
  assert.ok(jimOnDwight.warmth < dwightOnJim.warmth,
    'the refused should cool off more than the refuser');
  // Shared history is shared, whichever way the refusal went.
  assert.ok(Math.abs(jimOnDwight.familiarity - dwightOnJim.familiarity) < 1e-9);
});

test('repeated one-way refusals build a genuinely lopsided pair', () => {
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  for (let i = 0; i < 8; i++) book.note('angela', 'kevin', 'refusal');
  for (let i = 0; i < 8; i++) book.note('angela', 'kevin', 'cafe');

  const angelaOnKevin = book.get('angela', 'kevin');
  const kevinOnAngela = book.get('kevin', 'angela');
  assert.ok(kevinOnAngela.tension - angelaOnKevin.tension > 0.15,
    `expected a clear tension gap, got ${angelaOnKevin.tension} vs ${kevinOnAngela.tension}`);
  assert.notStrictEqual(angelaOnKevin.flavor, kevinOnAngela.flavor);
});

test('each direction is its own row in the snapshot', () => {
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  book.note('pam', 'jim', 'checkin');
  const rows = book.snapshot();
  assert.strictEqual(rows.length, 2);
  const keys = rows.map((r) => `${r.from}|${r.to}`).sort();
  assert.deepStrictEqual(keys, ['jim|pam', 'pam|jim']);
});

test('a pre-directional save file loads and seeds BOTH directions', () => {
  const home = tmpHome();
  // Exactly the old on-disk shape: symmetric rows keyed {a, b}, no version.
  fs.writeFileSync(path.join(home, SAVE_FILE), JSON.stringify({
    pairs: [{
      a: 'jim', b: 'dwight',
      warmth: 0.42, tension: 0.31, familiarity: 0.64,
      interactions: 17, lastAt: Date.now(),
      recent: [{ t: 'handoff', at: Date.now() }],
      lastLines: ['bears. beets.', 'battlestar galactica.']
    }]
  }), 'utf8');

  const book = new RelationshipBook(() => home);
  const forward = book.get('jim', 'dwight');
  const back = book.get('dwight', 'jim');
  for (const rel of [forward, back]) {
    assert.ok(Math.abs(rel.warmth - 0.42) < 0.01, `warmth survived: ${rel.warmth}`);
    assert.ok(Math.abs(rel.familiarity - 0.64) < 0.01, `familiarity survived: ${rel.familiarity}`);
    assert.strictEqual(rel.interactions, 17);
  }
  assert.deepStrictEqual(book.lastLines('jim', 'dwight'), ['bears. beets.', 'battlestar galactica.']);
  assert.deepStrictEqual(book.lastLines('dwight', 'jim'), ['bears. beets.', 'battlestar galactica.']);
});

test('a corrupt or unknown save file never throws', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, SAVE_FILE), '{not json at all', 'utf8');
  const book = new RelationshipBook(() => home);
  assert.deepStrictEqual(book.snapshot(), []);
  assert.doesNotThrow(() => book.note('creed', 'toby', 'cafe'));
});

test('saved edges round-trip through the new format', () => {
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  book.note('michael', 'toby', 'friction');
  book.flush();

  const raw = JSON.parse(fs.readFileSync(path.join(home, SAVE_FILE), 'utf8'));
  // 3 since the conversation thread (`lastTurns`) became attributed; version 2
  // files still load, which the migration tests above cover.
  assert.strictEqual(raw.version, 3);
  assert.strictEqual(raw.edges.length, 2);
  assert.ok(raw.edges.every((e) => typeof e.from === 'string' && typeof e.to === 'string'));

  const reopened = new RelationshipBook(() => home);
  assert.ok(reopened.get('michael', 'toby').tension > 0);
});

test('reading a pair never mints a row', () => {
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  // Exactly what officeChat.request() does at the top of every café break: both
  // directions are read before anything is noted. If the break is interrupted
  // before an event lands, nothing may be left behind.
  book.get('jim', 'dwight');
  book.get('dwight', 'jim');
  book.recentEvents('jim', 'dwight');
  book.lastLines('jim', 'dwight');

  assert.deepStrictEqual(book.snapshot(), [], 'a read-only visit leaves no edges');

  // …and a save triggered by a real event elsewhere must not persist them either.
  book.note('pam', 'michael', 'cafe');
  book.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(home, SAVE_FILE), 'utf8'));
  assert.deepStrictEqual(
    raw.edges.map((e) => `${e.from}|${e.to}`).sort(),
    ['michael|pam', 'pam|michael'],
    'only the noted pair reached disk'
  );
});

test('an unknown direction still reads as a blank edge', () => {
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  const cold = book.get('creed', 'toby');
  assert.strictEqual(cold.warmth, 0);
  assert.strictEqual(cold.tension, 0);
  assert.strictEqual(cold.interactions, 0);
  assert.ok(typeof cold.flavor === 'string' && cold.flavor.length > 0);
  assert.deepStrictEqual(book.recentEvents('creed', 'toby'), []);
  assert.deepStrictEqual(book.lastLines('creed', 'toby'), []);
});

test('purge cancels the pending save and erases the file', () => {
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  book.note('michael', 'toby', 'friction');
  book.flush();
  assert.ok(fs.existsSync(path.join(home, SAVE_FILE)));

  // A note whose debounced save is still pending when the reset lands.
  book.note('michael', 'toby', 'friction');
  book.purge();
  assert.ok(!fs.existsSync(path.join(home, SAVE_FILE)), 'the reset removes the file');
  assert.deepStrictEqual(book.snapshot(), [], 'and the in-memory book with it');

  // The cancelled timer must not resurrect the file afterwards.
  return new Promise((resolve) => setTimeout(() => {
    assert.ok(!fs.existsSync(path.join(home, SAVE_FILE)), 'no debounced write survived the purge');
    resolve();
  }, 2200));
});

test('recent events record which side of the interaction this edge was on', () => {
  const home = tmpHome();
  const book = new RelationshipBook(() => home);
  book.note('jim', 'dwight', 'handoff');
  assert.strictEqual(book.recentEvents('jim', 'dwight').at(-1).role, 'actor');
  assert.strictEqual(book.recentEvents('dwight', 'jim').at(-1).role, 'subject');
});
