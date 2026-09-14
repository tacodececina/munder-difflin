'use strict';

/**
 * Synthetic-only cast used by the isolated office scene probe.
 * These IDs are deliberately not agent IDs from the hive and never cross IPC.
 */
const SYNTHETIC_SCENE_FIXTURES = Object.freeze({
  11: Object.freeze({
    id: 'synthetic-office-11',
    agents: Object.freeze(Array.from({ length: 11 }, (_, i) => `fixture-agent-${String(i + 1).padStart(2, '0')}`)),
  }),
  19: Object.freeze({
    id: 'synthetic-office-19',
    agents: Object.freeze(Array.from({ length: 19 }, (_, i) => `fixture-agent-${String(i + 1).padStart(2, '0')}`)),
  }),
});

function getSyntheticSceneFixture(size) {
  const fixture = SYNTHETIC_SCENE_FIXTURES[size];
  if (!fixture) throw new Error(`unsupported synthetic scene fixture: ${size}`);
  return fixture;
}

module.exports = { SYNTHETIC_SCENE_FIXTURES, getSyntheticSceneFixture };
