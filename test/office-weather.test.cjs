'use strict';

// The office weather (src/renderer/src/scene/office/weather.ts) — the floor's
// sky as a readout of the circuit breaker.
//
// The property worth protecting is that the sky is HONEST and INERT: it must
// only ever darken because real agents are really under the breaker, it must
// clear itself when those agents go away rather than raining forever over an
// empty floor, and it must never be able to touch the agents it reports on
// (which is why this module is pure data in / enum out — there is nothing here
// to mock, and no seam through which it could reach an agent).

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  deriveWeather, summarizeSky, asBreakerLevel, FloorWeather,
  READING_TTL_MS, RAIN_AT, BREAKER_BEAT_MS
} = loadTs('src/renderer/src/scene/office/weather.ts');

const NOW = 1_700_000_000_000;
const reading = (agentId, level, ts = NOW) => ({ agentId, level, ts });

// ─── the rule ───────────────────────────────────────────────────────────────

test('an empty floor is clear', () => {
  assert.equal(deriveWeather([], NOW), 'clear');
});

test('a floor where everyone is healthy is clear', () => {
  const sky = summarizeSky([
    reading('jim', 'healthy'), reading('pam', 'healthy'), reading('dwight', 'healthy')
  ], NOW);
  assert.deepEqual(sky, { armed: 0, stopped: 0, weather: 'clear' });
});

test('one agent under the breaker clouds over', () => {
  assert.equal(deriveWeather([reading('jim', 'steering'), reading('pam', 'healthy')], NOW), 'overcast');
});

test('two agents under the breaker are still overcast', () => {
  const sky = summarizeSky([
    reading('jim', 'steering'), reading('pam', 'constrained'), reading('dwight', 'healthy')
  ], NOW);
  assert.equal(sky.armed, 2);
  assert.equal(sky.weather, 'overcast');
});

test('the third agent under the breaker starts the rain', () => {
  const armed = ['jim', 'pam', 'dwight'].map((id) => reading(id, 'steering'));
  assert.equal(armed.length, RAIN_AT);
  assert.equal(deriveWeather(armed, NOW), 'rain');
});

test('a single stopped agent rains on its own — a kill is a storm', () => {
  const sky = summarizeSky([reading('jim', 'stopped'), reading('pam', 'healthy')], NOW);
  assert.deepEqual(sky, { armed: 1, stopped: 1, weather: 'rain' });
});

test('severity comes from the count, not from the worst level', () => {
  // Two constrained agents are not yet rain: the ladder escalating on one agent
  // is normal, three agents held at once is the floor being in trouble.
  assert.equal(deriveWeather([reading('jim', 'constrained'), reading('pam', 'constrained')], NOW), 'overcast');
});

test('the latest reading for an agent wins, not the worst one it ever had', () => {
  const sky = summarizeSky([
    reading('jim', 'constrained', NOW - 1000),
    reading('jim', 'healthy', NOW)
  ], NOW);
  assert.equal(sky.armed, 0);
  assert.equal(sky.weather, 'clear');
});

// ─── failing clear ──────────────────────────────────────────────────────────

test('a reading older than the TTL has lapsed', () => {
  const stale = reading('jim', 'stopped', NOW - READING_TTL_MS);
  assert.equal(deriveWeather([stale], NOW), 'clear');
});

test('the TTL leaves room for missed beats', () => {
  assert.ok(READING_TTL_MS > 2 * BREAKER_BEAT_MS, 'two missed beats must not clear the sky');
  const oneBeatOld = reading('jim', 'steering', NOW - BREAKER_BEAT_MS * 2);
  assert.equal(deriveWeather([oneBeatOld], NOW), 'overcast');
});

test('agents no longer on the floor have no weather', () => {
  const readings = [reading('jim', 'stopped'), reading('pam', 'steering')];
  assert.equal(deriveWeather(readings, NOW, new Set(['pam'])), 'overcast');
  assert.equal(deriveWeather(readings, NOW, new Set()), 'clear');
});

test('malformed readings are ignored, never guessed at', () => {
  const sky = summarizeSky([
    null,
    'nope',
    { agentId: '', level: 'stopped', ts: NOW },        // no id
    { agentId: 'jim', level: 'on fire', ts: NOW },     // not a breaker level
    { agentId: 'pam', level: 'stopped' },              // no timestamp
    { agentId: 'dwight', level: 'stopped', ts: NaN }   // unusable timestamp
  ], NOW);
  assert.deepEqual(sky, { armed: 0, stopped: 0, weather: 'clear' });
});

test('asBreakerLevel accepts exactly the four levels main can emit', () => {
  for (const level of ['healthy', 'steering', 'constrained', 'stopped']) {
    assert.equal(asBreakerLevel(level), level);
  }
  for (const junk of ['', 'STOPPED', 'looping', 0, null, undefined, {}]) {
    assert.equal(asBreakerLevel(junk), null);
  }
});

// ─── folding the live stream ────────────────────────────────────────────────

test('FloorWeather folds pushes into a current sky', () => {
  const fw = new FloorWeather();
  assert.equal(fw.weather(NOW), 'clear');
  fw.record({ agentId: 'jim', level: 'steering', ts: NOW }, NOW);
  assert.equal(fw.weather(NOW), 'overcast');
  fw.record({ agentId: 'pam', level: 'constrained', ts: NOW }, NOW);
  fw.record({ agentId: 'dwight', level: 'steering', ts: NOW }, NOW);
  assert.equal(fw.weather(NOW), 'rain');
  // Recovery is reported on the same channel — the sky must lift again.
  fw.record({ agentId: 'pam', level: 'healthy', ts: NOW }, NOW);
  fw.record({ agentId: 'dwight', level: 'healthy', ts: NOW }, NOW);
  assert.equal(fw.weather(NOW), 'overcast');
  fw.record({ agentId: 'jim', level: 'healthy', ts: NOW }, NOW);
  assert.equal(fw.weather(NOW), 'clear');
});

test('FloorWeather prunes lapsed and departed agents instead of growing', () => {
  const fw = new FloorWeather();
  fw.record({ agentId: 'jim', level: 'stopped', ts: NOW }, NOW);
  fw.record({ agentId: 'pam', level: 'steering', ts: NOW }, NOW);
  assert.equal(fw.size, 2);
  // pam left the floor; jim's reading lapses a full TTL later.
  assert.equal(fw.weather(NOW + 10, new Set(['jim'])), 'rain');
  assert.equal(fw.size, 1);
  assert.equal(fw.weather(NOW + READING_TTL_MS, new Set(['jim'])), 'clear');
  assert.equal(fw.size, 0);
});

test('a push with no usable timestamp is stamped on arrival, not dropped', () => {
  const fw = new FloorWeather();
  fw.record({ agentId: 'jim', level: 'steering' }, NOW);
  assert.equal(fw.weather(NOW), 'overcast');
});

test('junk pushes never reach the sky', () => {
  const fw = new FloorWeather();
  fw.record({ agentId: 'jim', level: 'meltdown', ts: NOW }, NOW);
  fw.record({ level: 'stopped', ts: NOW }, NOW);
  fw.record({}, NOW);
  assert.equal(fw.size, 0);
  assert.equal(fw.weather(NOW), 'clear');
});

test('forget() drops an agent outright', () => {
  const fw = new FloorWeather();
  fw.record({ agentId: 'jim', level: 'stopped', ts: NOW }, NOW);
  fw.forget('jim');
  assert.equal(fw.weather(NOW), 'clear');
});

// ─── the module cannot act on the floor ─────────────────────────────────────

test('weather.ts exports only readings-in / enum-out — no way to touch an agent', () => {
  const api = loadTs('src/renderer/src/scene/office/weather.ts');
  const surface = Object.keys(api).sort();
  assert.deepEqual(surface, [
    'BREAKER_BEAT_MS', 'FloorWeather', 'RAIN_AT', 'READING_TTL_MS',
    'asBreakerLevel', 'deriveWeather', 'summarizeSky'
  ]);
  // Everything the sky can ever say, exhaustively.
  const outcomes = new Set();
  for (const level of ['healthy', 'steering', 'constrained', 'stopped']) {
    for (let n = 0; n <= 5; n++) {
      const readings = Array.from({ length: n }, (_, i) => reading(`a${i}`, level));
      outcomes.add(deriveWeather(readings, NOW));
    }
  }
  assert.deepEqual([...outcomes].sort(), ['clear', 'overcast', 'rain']);
});
