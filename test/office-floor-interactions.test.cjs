'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  FloorInteractionRegistry,
  deskVisualRect,
  projectedTileRect,
} = loadTs('src/renderer/src/scene/office/floorInteractions.ts');

const projection = {
  tileWidth: 16,
  tileHeight: 16,
  tileToWorld: (x, y) => ({ x: x * 16, y: y * 16 }),
};

test('specific visual targets win over large room targets', () => {
  const registry = new FloorInteractionRegistry();
  registry.register({
    id: 'room:engineering',
    kind: 'room',
    priority: 10,
    bounds: projectedTileRect(projection, { x: 1, y: 1, width: 10, height: 20 }),
    target: { kind: 'room', room: 'engineering' },
  });
  registry.register({
    id: 'desk:pc-1',
    kind: 'desk',
    priority: 20,
    bounds: deskVisualRect(projection, { x: 4, y: 16 }, 3),
    target: { kind: 'desk', seatId: 'pc-1' },
  });

  const desk = deskVisualRect(projection, { x: 4, y: 16 }, 3);
  const target = registry.resolve({ x: desk.x + desk.width / 2, y: desk.y + desk.height / 2 });
  assert.equal(target?.id, 'desk:pc-1');
});

test('desk hitboxes follow the visual monitor offset', () => {
  const base = deskVisualRect(projection, { x: 4, y: 16 }, 0);
  const rear = deskVisualRect(projection, { x: 4, y: 16 }, 3);
  assert.equal(rear.y - base.y, 3 * 16);
  assert.notEqual(rear.y, base.y);
});

test('outside points and malformed rectangles do not resolve', () => {
  const registry = new FloorInteractionRegistry();
  registry.register({
    id: 'room:briefing',
    kind: 'room',
    priority: 1,
    bounds: { x: 20, y: 20, width: 16, height: 16 },
    target: { kind: 'room', room: 'briefing' },
  });
  assert.equal(registry.resolve({ x: 19.99, y: 20 }), null);
  assert.equal(registry.resolve({ x: Number.NaN, y: 20 }), null);
});

test('the inspector source has no task mutation route', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/OfficeInspector.tsx'), 'utf8');
  assert.doesNotMatch(source, /openTaskDetail|hivePatchTask|setStatus/);
});

test('a one-tile region does not intercept the adjacent tile', () => {
  const registry = new FloorInteractionRegistry();
  registry.register({ id: 'room:briefing', kind: 'room', priority: 1,
    bounds: projectedTileRect(projection, { x: 2, y: 3, width: 1, height: 1 }),
    target: { kind: 'room', room: 'briefing' } });
  assert.equal(registry.resolve({ x: 3 * 16, y: 3 * 16 }), null);
  assert.equal(registry.resolve({ x: 2 * 16, y: 4 * 16 }), null);
  assert.equal(registry.resolve({ x: 2 * 16, y: 3 * 16 })?.id, 'room:briefing');
});

test('keyboard targets only include registered entries and cannot mutate them', () => {
  const registry = new FloorInteractionRegistry();
  registry.register({ id: 'desk:empty', kind: 'desk', priority: 1,
    bounds: { x: 0, y: 0, width: 16, height: 16 }, target: { kind: 'desk', seatId: 'empty' } });
  const targets = registry.list();
  assert.deepEqual(targets, [{ kind: 'desk', seatId: 'empty' }]);
  targets[0].seatId = 'changed';
  assert.equal(registry.get('desk:empty').target.seatId, 'empty');
  registry.unregister('desk:empty');
  assert.deepEqual(registry.list(), []);
});
