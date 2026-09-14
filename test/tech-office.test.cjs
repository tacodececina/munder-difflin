'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const loadTs = require('./load-ts.cjs');
const { buildOfficeMap, writeOfficeMap } = require('../tools/gen-tech-office.cjs');
const { validateOfficeMap } = require('../tools/mapgen/validate-tech-office.cjs');
const { TECH_PIECES, TECH_ATLAS_META, buildTechOfficeAtlas, drawTechProp, techGid } = loadTs('src/renderer/src/scene/office/techOfficeArt.ts');
const { TILE_PALETTES } = loadTs('src/renderer/src/scene/office/tileArt.ts');
const { monitorVisualOffsets, readDeskVisualOffsets, deskDisplayTop, monitorDisplayGid, deskCupPixelOffset } = loadTs('src/renderer/src/scene/office/deskVisuals.ts');
const layer = (m, n) => m.layers.find(l => l.name === n);
const put = (m, n, x, y, gid) => { layer(m, n).data[y * m.width + x] = gid; };
const spawn = (m, n) => layer(m, 'spawn-points').objects.find(o => o.name === n);

test('office station stands reach their own props without borrowing a permanent seat', () => {
  const { OFFICE_BINDINGS } = loadTs('src/renderer/src/scene/office/officeLayout.ts');
  const { buildWalkable, parseSpawnPoints } = loadTs('src/renderer/src/scene/office/tiledCollision.ts');
  const { findPath } = loadTs('src/renderer/src/scene/office/pathfinding.ts');
  const map = buildOfficeMap(), walk = buildWalkable(map), spawns = parseSpawnPoints(map);
  const props = JSON.parse(map.properties.find(p => p.name === 'propPlacements').value);
  const stationProps = { shelf: 'shelf', terminal: 'server', mcp: 'network', web: 'screen', board: 'whiteboard' };
  assert.equal(OFFICE_BINDINGS.stationSpots?.length, 5);
  for (const spot of OFFICE_BINDINGS.stationSpots) {
    assert.ok(findPath(walk, spawns.get('entrance'), spot.stand), spot.kind);
    assert.equal(layer(map, 'collision').data[spot.stand.y * map.width + spot.stand.x], 0);
    assert.ok(![...spawns.values()].some(s => s.x === spot.stand.x && s.y === spot.stand.y));
    const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[spot.facing];
    const target = { x: spot.stand.x + delta[0], y: spot.stand.y + delta[1] };
    assert.ok(props.some(p => p.key === stationProps[spot.kind] && target.x >= p.x && target.y >= p.y
      && target.x < p.x + TECH_PIECES[p.key].w && target.y < p.y + TECH_PIECES[p.key].h), `${spot.kind} faces its prop`);
  }
});

test('composed map is deterministic, preserves 19 desks and is connected', () => {
  const map = buildOfficeMap(), report = validateOfficeMap(map);
  assert.equal(report.seats, 19);
  assert.ok(report.reachable > 900);
  assert.ok(report.waiting >= 16);
  assert.deepEqual(map, buildOfficeMap());
  const inventory = JSON.parse(map.properties.find(p => p.name === 'propPlacements').value);
  for (const kind of ['island', 'bench', 'corner', 'standing', 'server', 'network', 'whiteboard', 'screen'])
    assert.ok(inventory.some(p => p.key === kind), `missing ${kind}`);
});

for (const [name, mutate, expected] of [
  ['#1 monitor top-left', m => put(m, 'furniture-above', 16, 16, 0), /#1/],
  ['#1 torn 2x2 monitor', m => put(m, 'furniture-above', 17, 17, 0), /#1/],
  ['#2 shelf blocked', m => put(m, 'furniture-above', 15, 17, techGid('bin')), /#2/],
  ['#3 no facing neighbor', m => { for (const [x, y] of [[16, 17], [16, 19], [15, 18], [17, 18]]) put(m, 'collision', x, y, 0); }, /#3/],
  ['#4 cafe seats mispaired', m => { spawn(m, 'cafe-seat-2').y += 16; }, /#4/],
  ['#5 entry without a queue', m => { for (const [x, y] of [[16, 33], [16, 35], [15, 34], [17, 34]]) put(m, 'collision', x, y, 1); }, /#5/],
  ['#5 missing entrance', m => { spawn(m, 'entrance').name = 'door'; }, /#5/],
  ['#6 cafe seat blocked', m => put(m, 'collision', 34, 25, 1), /#6/],
  ['#6 cafe stand blocked', m => put(m, 'collision', 31, 33, 1), /#6/],
  ['#7 renamed layer', m => { layer(m, 'furniture-above').name = 'above'; }, /#7/],
  ['#7 duplicate layer', m => { m.layers.push(structuredClone(layer(m, 'floor'))); }, /#7/],
  ['#7 truncated tile data', m => { layer(m, 'floor').data.pop(); }, /#7/],
  ['#7 wrong object layer type', m => { layer(m, 'zones').type = 'tilelayer'; }, /#7/],
  ['#8 missing wing', m => { layer(m, 'zones').objects.find(o => o.name === 'wing-deploy').name = 'deploy'; }, /#8/],
  ['#8 missing boardroom', m => { layer(m, 'zones').objects.find(o => o.name === 'boardroom').name = 'conference'; }, /#8/],
  ['#8 zone outside map', m => { layer(m, 'zones').objects[0].x = 100000; }, /#8/],
  ['disconnected desk', m => { for (const [x, y] of [[15, 25], [15, 27], [14, 26], [16, 26]]) put(m, 'collision', x, y, 1); }, /unreachable spawn/],
  ['disconnected coffee destination', m => put(m, 'collision', 36, 33, 1), /unreachable coffee.sinkStand/],
  ['blocked station destination', m => put(m, 'collision', 42, 22, 1), /unreachable station shelf/],
  ['disconnected station destination', m => { for (const [x, y] of [[42, 21], [42, 23], [41, 22]]) put(m, 'collision', x, y, 1); }, /unreachable station shelf/],
  ['atlas mismatch', m => { m.tilesets[0].columns = 8; }, /atlas metadata/],
  ['unpainted gid', m => put(m, 'floor', 10, 10, 12), /invalid gid/],
  ['out-of-bounds spawn', m => { spawn(m, 'pc-1').x = -16; }, /invalid spawn/],
  ['missing primary', m => { spawn(m, 'pc-1').name = 'gone'; }, /theme binding/],
  ['duplicate spawn', m => { spawn(m, 'pc-1').name = 'pc-2'; }, /duplicate spawn/],
  ['missing island offset', m => { spawn(m, 'pc-1').properties = []; }, /missing visual offset/],
  ['invalid island offset', m => { spawn(m, 'pc-1').properties[0].value = 99; }, /invalid monitor offset/],
  ['monitor display overlaps another prop', m => put(m, 'furniture-above', 4, 17, techGid('bin')), /monitor display collision/],
]) {
  test(`validator rejects ${name}`, () => {
    const map = buildOfficeMap(); mutate(map);
    assert.throws(() => validateOfficeMap(map), expected);
  });
}

test('failed validation leaves the output byte-identical; valid write round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-contract-'));
  const out = path.join(dir, 'office.tmj');
  try {
    fs.writeFileSync(out, 'sentinel');
    const map = buildOfficeMap(); put(map, 'furniture-above', 16, 16, 0);
    assert.throws(() => writeOfficeMap(map, out), /#1/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'sentinel');
    const valid = buildOfficeMap(); writeOfficeMap(valid, out);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), valid);
  } finally { fs.unlinkSync(out); fs.rmdirSync(dir); }
});

test('every prop round-trips through atlas slicing without a changed pixel or seam', () => {
  const atlas = buildTechOfficeAtlas(), pal = TILE_PALETTES['office-tech'];
  assert.equal(atlas.data.length, atlas.width * atlas.height * 4);
  assert.equal(atlas.width, TECH_ATLAS_META.imagewidth);
  assert.equal(atlas.height, TECH_ATLAS_META.imageheight);
  assert.deepEqual(atlas.data, buildTechOfficeAtlas().data);
  for (const [key, p] of Object.entries(TECH_PIECES)) {
    const original = drawTechProp(key, pal), rebuilt = new Uint8ClampedArray(original.data.length);
    for (let ty = 0; ty < p.h; ty++) for (let tx = 0; tx < p.w; tx++) {
      const gid = techGid(key, tx, ty) - 1;
      for (let y = 0; y < 16; y++) {
        const start = ((Math.floor(gid / 16) * 16 + y) * atlas.width + (gid % 16) * 16) * 4;
        rebuilt.set(atlas.data.subarray(start, start + 64), ((ty * 16 + y) * original.width + tx * 16) * 4);
      }
    }
    assert.deepEqual(rebuilt, original.data, key);
    assert.ok(rebuilt.some((v, i) => i % 4 === 3 && v === 255), `${key} empty silhouette`);
    const colors = new Set();
    for (let i = 0; i < rebuilt.length; i += 4) if (rebuilt[i + 3] === 255) colors.add(`${rebuilt[i]},${rebuilt[i + 1]},${rebuilt[i + 2]}`);
    assert.ok(colors.size <= 24, `${key} has ${colors.size} opaque colors: palette drift`);
  }
  assert.throws(() => techGid('bench', 11, 0), /Invalid/);
  assert.throws(() => techGid('floor', -1, 0), /Invalid/);
});

test('floor materials are opaque periodic fields, palette comes from theme', () => {
  const pal = TILE_PALETTES['office-tech'];
  for (const key of ['floor', 'carpet', 'timber']) {
    const { data } = drawTechProp(key, pal);
    for (let i = 3; i < data.length; i += 4) assert.equal(data[i], 255);
  }
  assert.notDeepEqual(drawTechProp('server', pal).data, drawTechProp('server', TILE_PALETTES.office).data);
  assert.deepEqual(TILE_PALETTES.office.floor.base, [176, 148, 110]);
});

test('rear monitors retain the logical contract; unannotated maps do not move', () => {
  const map = buildOfficeMap();
  assert.equal(readDeskVisualOffsets(map).size, 2);
  assert.equal(monitorVisualOffsets(map).size, 8);
  assert.deepEqual(deskDisplayTop({ x: 4, y: 16 }, 3), { x: 4, y: 17 });
  assert.deepEqual(deskDisplayTop({ x: 4, y: 22 }), { x: 4, y: 20 });
  assert.equal(monitorDisplayGid(365, 3), 369);
  assert.equal(monitorDisplayGid(367, 3), 371);
  assert.equal(monitorDisplayGid(365, 0), 365);
  assert.equal(monitorDisplayGid(513, 3), 513);
  assert.deepEqual(deskCupPixelOffset(), { x: 18, y: 23 });
  assert.deepEqual(deskCupPixelOffset(3), { x: 34, y: 23 });
  for (const name of ['brooklyn99', 'siliconvalley', 'friends', 'isometric']) {
    const other = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/renderer/src/assets/maps', `${name}.tmj`), 'utf8'));
    assert.equal(monitorVisualOffsets(other).size, 0);
  }
  for (const value of [undefined, '3', 0, 9, 1.5]) {
    spawn(map, 'pc-1').properties[0].value = value;
    assert.equal(readDeskVisualOffsets(map).has('4,16'), false);
  }
});

test('Pixi uses the same rear/off/on art and display position as the rasterizer', () => {
  const { Texture } = require('pixi.js');
  const { TiledMapRenderer } = loadTs('src/renderer/src/scene/office/TiledMapRenderer.ts');
  const { DeskScreen } = loadTs('src/renderer/src/scene/office/DeskScreen.ts');
  const map = buildOfficeMap(), r = new TiledMapRenderer(map, [Texture.EMPTY]);
  const above = r.getContainer().children.find(c => c.label === 'furniture-above');
  assert.equal(r.gidAt('furniture-above', 4, 14), 365);
  assert.equal(r.getDeskVisualOffset({ x: 4, y: 16 }), 3);
  const off = above.children.find(s => s.x === 4 * 16 && s.y === 17 * 16);
  assert.ok(off, 'static rear monitor must be on the north edge of the island');
  assert.equal(off.texture.frame.x, ((369 - 1) % 16) * 16);
  assert.equal(off.texture.frame.y, Math.floor((369 - 1) / 16) * 16);
  const screen = new DeskScreen(r, { x: 4, y: 17 }, undefined, 3);
  assert.equal(screen.container.y, off.y);
  assert.equal(screen.container.visible, false);
  screen.setOn(true); screen.update(0.5);
  assert.equal(screen.container.visible, true);
  assert.equal(screen.container.children[0].texture.frame.x, ((371 - 1) % 16) * 16);
  screen.setOn(false); screen.destroy();
  const front = new DeskScreen(r, { x: 4, y: 20 });
  front.setOn(true); front.update(0.5); front.setOn(false); front.destroy();
  r.getContainer().destroy({ children: true });
});
