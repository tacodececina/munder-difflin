'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { createSceneLifecycle } =
  loadTs('src/renderer/src/scene/office/sceneLifecycle.ts');

test('a newer channel token invalidates an older asynchronous response', () => {
  const scene = createSceneLifecycle(7);
  const first = scene.issue('ci');
  const second = scene.issue('ci');

  assert.equal(scene.isCurrent('ci', first), false);
  assert.equal(scene.isCurrent('ci', second), true);
  assert.equal(scene.generation, 7);
});

test('invalidating a channel discards callbacks already in flight', () => {
  const scene = createSceneLifecycle(3);
  const token = scene.issue('task-board');
  scene.invalidate('task-board');

  assert.equal(scene.isCurrent('task-board', token), false);
});

test('disposing the scene cancels tracked timers', async () => {
  const scene = createSceneLifecycle(1);
  let fired = false;
  scene.timeout(() => { fired = true; }, 0);
  scene.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fired, false);
});
