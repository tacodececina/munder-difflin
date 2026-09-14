'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SYNTHETIC_SCENE_FIXTURES, getSyntheticSceneFixture } = require('../tools/perf/office-scene-fixtures.cjs');

test('isolated scene probe exposes the 11-agent synthetic fixture', () => {
  const fixture = getSyntheticSceneFixture(11);
  assert.equal(fixture.id, 'synthetic-office-11');
  assert.equal(fixture.agents.length, 11);
  assert.equal(new Set(fixture.agents).size, 11);
  assert.ok(fixture.agents.every((id) => id.startsWith('fixture-agent-')));
});

test('isolated scene probe exposes the 19-agent synthetic fixture', () => {
  const fixture = getSyntheticSceneFixture(19);
  assert.equal(fixture.id, 'synthetic-office-19');
  assert.equal(fixture.agents.length, 19);
  assert.equal(new Set(fixture.agents).size, 19);
  assert.ok(fixture.agents.every((id) => id.startsWith('fixture-agent-')));
});

test('fixture catalog has no productive roster entry', () => {
  assert.deepEqual(Object.keys(SYNTHETIC_SCENE_FIXTURES).sort(), ['11', '19']);
  assert.ok(Object.values(SYNTHETIC_SCENE_FIXTURES).every((fixture) =>
    fixture.agents.every((id) => id.startsWith('fixture-agent-'))
  ));
});
