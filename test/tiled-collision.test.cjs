'use strict';

// Unit tests for the pure Tiled-JSON parsing helpers extracted out of
// TiledMapRenderer.ts into tiledCollision.ts (Phase 4: extracted so the
// theme-bundle validator can reuse the SAME collision/spawn-point rules
// without importing pixi.js — see that file's header and
// theme-bundle-validator.test.cjs). This file is a regression guard for the
// extraction itself: the fixture map here is deliberately the same one the
// bundle-validator tests use, and the assertions mirror what
// TiledMapRenderer's constructor used to compute inline before the refactor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  parseCollisionGrid,
  parseSpawnPoints,
  markWalkableSpawnPoints,
  parseZones,
  resolveTilesetIndex,
  buildWalkable,
  findLayer,
  WALKABLE_SPAWN_PREFIXES,
} = loadTs('src/renderer/src/scene/office/tiledCollision.ts');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'theme-bundle-valid');
const MAP = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'map.tmj'), 'utf8'));

test('parseCollisionGrid: border walled, interior open, matching the fixture .tmj', () => {
  const grid = parseCollisionGrid(MAP);
  assert.equal(grid.length, MAP.height);
  assert.equal(grid[0].length, MAP.width);
  // corners + border are blocked
  assert.equal(grid[0][0], false);
  assert.equal(grid[0][9], false);
  assert.equal(grid[7][0], false);
  assert.equal(grid[7][9], false);
  // interior is open
  assert.equal(grid[1][1], true);
  assert.equal(grid[3][5], true);
});

test('parseCollisionGrid: a map with no collision layer is fully walkable', () => {
  const noCollision = { ...MAP, layers: MAP.layers.filter((l) => l.name !== 'collision') };
  const grid = parseCollisionGrid(noCollision);
  for (let y = 0; y < noCollision.height; y++) {
    for (let x = 0; x < noCollision.width; x++) {
      assert.equal(grid[y][x], true, `(${x},${y}) should default walkable with no collision layer`);
    }
  }
});

test('parseSpawnPoints: every named spawn point resolves to the correct tile coords', () => {
  const points = parseSpawnPoints(MAP);
  assert.deepEqual(points.get('desk-ceo'), { x: 2, y: 2 });
  assert.deepEqual(points.get('pc-1'), { x: 4, y: 2 });
  assert.deepEqual(points.get('cafe-stand-coffee'), { x: 5, y: 5 });
  assert.equal(points.get('nonexistent-seat'), undefined);
});

test('markWalkableSpawnPoints: forces desk-/pc- prefixed points walkable even over a blocked tile', () => {
  const grid = parseCollisionGrid(MAP);
  const points = new Map([['desk-ceo', { x: 0, y: 0 }]]); // pretend it sits on the border wall
  assert.equal(grid[0][0], false, 'sanity: (0,0) starts blocked');
  markWalkableSpawnPoints(grid, points, MAP.width, MAP.height, WALKABLE_SPAWN_PREFIXES);
  assert.equal(grid[0][0], true, 'desk- prefixed spawn points must be forced walkable');
});

test('markWalkableSpawnPoints: a non-prefixed name (e.g. cafe-seat-1) is NOT forced walkable', () => {
  const grid = parseCollisionGrid(MAP);
  const points = new Map([['cafe-seat-1', { x: 0, y: 0 }]]);
  markWalkableSpawnPoints(grid, points, MAP.width, MAP.height, WALKABLE_SPAWN_PREFIXES);
  assert.equal(grid[0][0], false, 'only desk-/pc-/warroom-/entrance-prefixed names are auto-walkable');
});

test('buildWalkable combines collision + spawn-point overrides into one Walkable', () => {
  const w = buildWalkable(MAP);
  assert.equal(w.width, MAP.width);
  assert.equal(w.height, MAP.height);
  assert.equal(w.isWalkable(1, 1), true);
  assert.equal(w.isWalkable(0, 0), false);
  assert.equal(w.isWalkable(-1, 0), false, 'out of bounds is never walkable');
  assert.equal(w.isWalkable(MAP.width, 0), false, 'out of bounds is never walkable');
});

test('parseZones: empty when the map has no zones layer (the fixture has none)', () => {
  const zones = parseZones(MAP);
  assert.equal(zones.size, 0);
});

test('resolveTilesetIndex: picks the tileset with the highest firstgid <= tileId', () => {
  const tilesets = [{ firstgid: 1 }, { firstgid: 513 }, { firstgid: 1025 }];
  assert.equal(resolveTilesetIndex(1, tilesets), 0);
  assert.equal(resolveTilesetIndex(512, tilesets), 0);
  assert.equal(resolveTilesetIndex(513, tilesets), 1);
  assert.equal(resolveTilesetIndex(2000, tilesets), 2);
  assert.equal(resolveTilesetIndex(0, tilesets), undefined);
});

test('findLayer: matches by both name AND type', () => {
  const collisionLayer = findLayer(MAP.layers, 'collision', 'tilelayer');
  assert.ok(collisionLayer);
  assert.equal(findLayer(MAP.layers, 'collision', 'objectgroup'), undefined);
  const spawnLayer = findLayer(MAP.layers, 'spawn-points', 'objectgroup');
  assert.ok(spawnLayer);
});
