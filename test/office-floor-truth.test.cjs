'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const floor = fs.readFileSync(
  path.join(__dirname, '../src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');

test('the floor has no canned errand, suck-up or cheer claims', () => {
  for (const name of ['ERRAND_THOUGHTS', 'SUCK_UP_KEYS', 'CHEER_KEYS', 'CHEER_MIN_BUSY_MS']) {
    assert.doesNotMatch(floor, new RegExp(`\\b${name}\\b`), `${name} survived`);
  }
  assert.doesNotMatch(floor, /hiveTasks\(\)/, 'the scene must not use the unqualified task snapshot');
  assert.match(floor, /readTaskDoneEvents/);
  assert.match(floor, /hiveTaskReading\(\)/);
});

test('task completion observation has a silent scene baseline', () => {
  assert.match(floor, /if \(!taskDoneBaseline\)/);
  assert.match(floor, /seenTaskDone = current/);
  assert.match(floor, /rt\.character\.cheer\(\)/);
});
