'use strict';

// TALL FURNITURE HAS TO HIDE WHOEVER WALKS BEHIND IT — and nothing else may
// move. Guard for scene/office/tileOcclusion.ts.
//
// THE BUG. The office floor was redesigned with objects that have visual HEIGHT
// (a desk PC is one drawing spread over two cells: screen above, keyboard
// below) while the renderer still assumed the old flat floor plan, where every
// tile could be painted under every avatar. The upper cell of a desk PC is
// walkable on purpose — you should be able to walk behind a monitor — so an
// agent crossing it was drawn ON TOP of the screen.
//
// WHAT IS ASSERTED HERE, in three layers:
//   1. the rule itself, on hand-built maps: each of its three conditions must
//      be able to veto, alone;
//   2. the DEPTH CONTRACT against the real orthogonal projection and the real
//      avatar anchor — behind is hidden, in front is not, and a seated agent
//      still draws over its own keyboard;
//   3. the four SHIPPED maps against their REAL atlases: the exact set of tiles
//      whose depth changes, tile by tile. That list is the promise that the
//      other themes did not move — brooklyn99's is empty, and siliconvalley's
//      and friends' contain their nine desk PCs and nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { bottomEdgeProbe } = require('./atlas-alpha.cjs');

const { standingTileDepthRows } = loadTs('src/renderer/src/scene/office/tileOcclusion.ts');
const { createOrthogonalProjection } = loadTs('src/renderer/src/scene/office/projection.ts');
const { parseCollisionGrid, parseSpawnPoints, markWalkableSpawnPoints, WALKABLE_SPAWN_PREFIXES } =
  loadTs('src/renderer/src/scene/office/tiledCollision.ts');
const { monitorVisualOffsets, monitorDisplayGid } =
  loadTs('src/renderer/src/scene/office/deskVisuals.ts');

const TS = 16;
const LAYER = 'furniture-above';

// ── layer 1: the rule, on maps small enough to read ─────────────────────────

/** A 3x4 map with `cells` painted into furniture-above, everything walkable and
 *  every gid's art running off the bottom, unless overridden. */
function tinyMap(cells) {
  const width = 3, height = 4;
  const data = new Array(width * height).fill(0);
  for (const [x, y, gid] of cells) data[y * width + x] = gid;
  return {
    width,
    height,
    tilewidth: TS,
    tileheight: TS,
    tilesets: [{ firstgid: 1, columns: 16, tilewidth: TS, tileheight: TS }],
    layers: [{ name: LAYER, type: 'tilelayer', data }],
  };
}

function rows(map, overrides = {}) {
  return standingTileDepthRows(map, LAYER, {
    displayedGid: (x, y) => map.layers[0].data[y * map.width + x] ?? 0,
    displayOffset: () => 0,
    isWalkable: () => true,
    artRunsOffBottom: () => true,
    ...overrides,
  });
}

test('the top of a two-cell prop sorts on the row it stands on; its base does not', () => {
  // A desk PC: screen at (1,1), keyboard at (1,2). The screen must draw over
  // anyone standing on (1,1); the keyboard must not steal the seat below it.
  const map = tinyMap([[1, 1, 365], [1, 2, 381]]);
  const got = rows(map);
  assert.deepEqual([...got], [['1,1', 2]]);
});

test('a lone tile never occludes — there is nothing below it to stand on', () => {
  assert.equal(rows(tinyMap([[1, 1, 19]])).size, 0);
});

test('flat art that leaves its bottom row empty stays under the cast', () => {
  // Condition 2, alone: the wall trim in the brooklyn99 map is two pixels tall
  // at the TOP of its cell and happens to sit above another decal.
  const map = tinyMap([[1, 1, 19], [1, 2, 20]]);
  assert.equal(rows(map, { artRunsOffBottom: () => false }).size, 0);
});

test('a cell nobody can stand on is left out of the sorted layer entirely', () => {
  // Condition 3, alone: a wall-mounted screen is tall and continuous, but no
  // avatar can ever be behind it, so sorting it would only cost frames — and
  // would put it in front of its own live readout.
  const map = tinyMap([[1, 1, 365], [1, 2, 381]]);
  assert.equal(rows(map, { isWalkable: () => false }).size, 0);
});

test('the depth row follows the art when a theme displays it somewhere else', () => {
  // The facing-island desks draw their PC three rows further down (deskVisuals'
  // monitorOffsetY). Occlusion has to happen where the art IS.
  const map = tinyMap([[1, 0, 365], [1, 1, 381]]);
  const got = rows(map, { displayOffset: (x, y) => (y <= 1 ? 2 : 0) });
  assert.deepEqual([...got], [['1,0', 3]]);
});

test('the bottom map row cannot be a standing tile', () => {
  const map = tinyMap([[1, 3, 365]]);
  assert.equal(rows(map).size, 0);
});

// ── layer 2: the depth contract, against the real projection ────────────────

test('a standing tile hides the agent behind it and not the one in front', () => {
  const proj = createOrthogonalProjection(TS);
  // The tile is drawn on row 5 and belongs to an object standing on row 6.
  const tileZ = proj.tileDepth(2, 6) + 1;
  const depthOfAgentOn = (row) => proj.depthAtWorldY(proj.tileFootToWorld(2, row).y);

  // BEHIND: standing on the tile's own cell — hidden by it. This is the bug.
  assert.ok(depthOfAgentOn(5) < tileZ, 'agent on the tile must sort behind it');
  // IN FRONT: one row closer to the camera — unchanged, still drawn over it.
  assert.ok(depthOfAgentOn(6) > tileZ, 'agent one row down must sort in front');
  // TWO behind: also hidden, and the ordering is monotone, never arbitrary.
  assert.ok(depthOfAgentOn(4) < depthOfAgentOn(5));
});

test('the +1 nudge is what breaks the tie — without it insertion order decides', () => {
  const proj = createOrthogonalProjection(TS);
  // The un-nudged depth ties EXACTLY with the avatar standing on the tile,
  // and a tie is resolved by insertion order (tiles are built first, the cast
  // joins later), which is how the agent ended up in front.
  assert.equal(proj.tileDepth(2, 6), proj.depthAtWorldY(proj.tileFootToWorld(2, 5).y));
});

test('a seated agent still draws over its own keyboard', () => {
  const proj = createOrthogonalProjection(TS);
  // Desk PC top at seat.y-2, base/keyboard at seat.y-1, agent seated at seat.y.
  const seatY = 10;
  const screenZ = proj.tileDepth(4, seatY - 1) + 1; // the raised top half
  const keyboardZ = proj.tileDepth(4, seatY - 1);   // untouched: not a standing tile
  const agentZ = proj.depthAtWorldY(proj.tileFootToWorld(4, seatY).y);
  assert.ok(agentZ > screenZ);
  assert.ok(agentZ > keyboardZ);
});

test('the desk-PC overlay and the desk trinkets still draw over a raised screen', () => {
  // Every charLayer prop anchored at the seat row keeps its lead over the
  // raised monitor tiles, so DeskScreen's lit variant and DeskShelf are not
  // swallowed by the art they sit on.
  const proj = createOrthogonalProjection(TS);
  const seatY = 10;
  const screenZ = proj.tileDepth(4, seatY - 1) + 1;
  assert.ok(proj.rowDepth(seatY - 2 + 2) - 1 > screenZ, 'DeskScreen');
  assert.ok(proj.rowDepth(seatY - 1 + 1) - 2 > screenZ, 'DeskShelf');
  assert.ok(proj.rowDepth(seatY) - 1 > screenZ, 'taken-note on the desk');
});

// ── layer 3: the shipped maps, against the shipped art ──────────────────────

const MAPS = path.resolve(__dirname, '..', 'src', 'renderer', 'src', 'assets', 'maps');
const readMap = (name) => JSON.parse(fs.readFileSync(path.join(MAPS, name + '.tmj'), 'utf8'));

/** Exactly what TiledMapRenderer wires up, minus pixi: the real walkability
 *  grid, the real display offsets, and the real atlas pixels. */
function shippedStandingTiles(name) {
  const map = readMap(name);
  const grid = parseCollisionGrid(map);
  const spawns = parseSpawnPoints(map);
  markWalkableSpawnPoints(grid, spawns, map.width, map.height, WALKABLE_SPAWN_PREFIXES);
  const offsets = monitorVisualOffsets(map);
  const above = map.layers.find((l) => l.name === LAYER && l.type === 'tilelayer').data;
  const gidAt = (x, y) =>
    x < 0 || y < 0 || x >= map.width || y >= map.height ? 0 : (above[y * map.width + x] ?? 0) & 0x1fffffff;
  const probe = bottomEdgeProbe(name);
  return standingTileDepthRows(map, LAYER, {
    displayedGid: (x, y) => monitorDisplayGid(gidAt(x, y), offsets.get(`${x},${y}`) ?? 0),
    displayOffset: (x, y) => offsets.get(`${x},${y}`) ?? 0,
    isWalkable: (x, y) =>
      x >= 0 && y >= 0 && x < map.width && y < map.height && grid[y][x],
    artRunsOffBottom: probe,
  });
}

/** What art each selected tile actually carries, counted by gid. */
function gidHistogram(name, standing) {
  const map = readMap(name);
  const above = map.layers.find((l) => l.name === LAYER).data;
  const out = {};
  for (const key of standing.keys()) {
    const [x, y] = key.split(',').map(Number);
    const gid = (above[y * map.width + x] ?? 0) & 0x1fffffff;
    out[gid] = (out[gid] ?? 0) + 1;
  }
  return out;
}

test('brooklyn99 does not change at all — its desk PCs are walled off', () => {
  assert.deepEqual([...shippedStandingTiles('brooklyn99')], []);
});

test('siliconvalley and friends change at their nine desk PCs and nowhere else', () => {
  for (const name of ['siliconvalley', 'friends']) {
    const standing = shippedStandingTiles(name);
    assert.deepEqual(gidHistogram(name, standing), { 365: 9 }, name);
  }
});

test('the office floor raises its monitors and chair backs, and nothing flat', () => {
  const standing = shippedStandingTiles('office');
  // 365/366: the two upper cells of each of the 15 desk PCs — the reported bug.
  // 806 / 808: the back of a chair and of a north-facing chair; an agent that
  // walks behind one is now hidden by it, which is the same rule, not a second.
  assert.deepEqual(gidHistogram('office', standing), { 365: 15, 366: 15, 806: 15, 808: 3 });
  assert.equal(standing.size, 48);
});

test('every raised tile keys its depth on the row directly below its art', () => {
  for (const name of ['office', 'siliconvalley', 'friends']) {
    const offsets = monitorVisualOffsets(readMap(name));
    for (const [key, row] of shippedStandingTiles(name)) {
      const [x, y] = key.split(',').map(Number);
      assert.equal(row, y + (offsets.get(`${x},${y}`) ?? 0) + 1, `${name} ${key}`);
    }
  }
});

test('no raised tile is one a prop hangs a live readout on', () => {
  // The ops screen and the plan board sort on rowDepth(lastRow) with no nudge,
  // so a raised tile of their own art would cover the data they display. They
  // are wall props on blocked cells, and condition 3 is what guarantees that
  // stays true: assert no selected tile sits in the map's wall band.
  for (const name of ['office', 'brooklyn99', 'siliconvalley', 'friends']) {
    for (const key of shippedStandingTiles(name).keys()) {
      const y = Number(key.split(',')[1]);
      assert.ok(y >= 5, `${name}: ${key} is in the wall band`);
    }
  }
});

test('the whole selection is a tiny minority of the layer it comes from', () => {
  // The cost argument, pinned: the sorted container grows by this much and no
  // more. 235 furniture-above tiles on the office map, 48 of them sorted; the
  // 1472-sprite floor layer is never touched.
  const budget = { office: 48, brooklyn99: 0, siliconvalley: 9, friends: 9 };
  for (const [name, expected] of Object.entries(budget)) {
    assert.equal(shippedStandingTiles(name).size, expected, name);
  }
});
