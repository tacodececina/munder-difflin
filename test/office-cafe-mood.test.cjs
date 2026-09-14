'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { cafeMoodFor } = loadTs('src/renderer/src/scene/office/cafeMood.ts');

test('success status does not imply a completed task or a celebration', () => {
  for (const [speaker, partner] of [
    ['success', 'idle'], ['idle', 'success'], ['success', 'success'],
    ['success', undefined], [undefined, 'success'],
  ]) assert.equal(cafeMoodFor(speaker, partner), 'generic');
});

test('observed blocked or looping status still warrants a check-in', () => {
  for (const status of ['blocked', 'looping']) {
    assert.equal(cafeMoodFor(status, 'success'), 'breaker-checkin');
    assert.equal(cafeMoodFor('success', status), 'breaker-checkin');
  }
});

test('missing and unknown statuses cannot manufacture a celebration', () => {
  assert.equal(cafeMoodFor(), 'generic');
  assert.equal(cafeMoodFor('unknown', 'idle'), 'generic');
});
