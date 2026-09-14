'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { Camera } = loadTs('src/renderer/src/scene/office/Camera.ts');

function fixture() {
  const container = { x: 0, y: 0, scale: { value: 1, set(value) { this.value = value; } } };
  const camera = new Camera(container);
  camera.setMapSize(1000, 1000);
  camera.setViewSize(500, 500);
  return { camera, container };
}

test('economy camera settles selection and resize on the first drawn frame', () => {
  const { camera, container } = fixture();
  camera.setReducedMotion(true);
  camera.focusOn(600, 650, 2);
  camera.update(0.5);
  assert.equal(camera.needsAnimationFrame(), false);
  assert.equal(container.scale.value, 2);
  assert.equal(container.x, -950);
  assert.equal(container.y, -1050);
  camera.fitToScreen();
  camera.setViewSize(600, 600);
  camera.update(0.5);
  assert.equal(camera.needsAnimationFrame(), false);
  assert.equal(container.scale.value, 0.6);
  assert.equal(container.x, 0);
  assert.equal(container.y, 0);
});

test('economy camera ignores decorative nudges and disabling restores interpolation', () => {
  const { camera } = fixture();
  camera.setReducedMotion(true);
  camera.update(0.5);
  camera.nudgeToward(700, 700);
  assert.equal(camera.needsAnimationFrame(), false);
  camera.setReducedMotion(false);
  camera.focusOn(600, 650, 2);
  camera.update(1 / 60);
  assert.equal(camera.needsAnimationFrame(), true);
});

test('normal camera retains its existing interpolation', () => {
  const { camera, container } = fixture();
  camera.focusOn(600, 650, 2);
  camera.update(1 / 60);
  assert.equal(container.scale.value, 1.08);
  assert.equal(camera.needsAnimationFrame(), true);
});
