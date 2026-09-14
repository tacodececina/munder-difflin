'use strict';

// Validates the Phase 4 custom-theme-bundle validator (themeBundle.ts). That
// module is deliberately pixi.js-free (only `import type` from
// themeRegistry.ts, erased at compile time; the one runtime import is
// tiledCollision.ts, itself pixi-free) specifically so it can be exercised
// here under plain `node --test`, with no Electron/browser/WebGL context —
// see themeBundle.ts's header comment. themeLoader.ts (the orchestration
// layer that actually reads bundle files off disk via window.cth and builds
// textures) is NOT loaded here: it transitively pulls in themeRegistry.ts's
// Vite `?url`/`?raw` asset imports and cast.ts, neither of which resolve
// outside a Vite build — that layer is covered by typecheck + manual/e2e
// verification instead, not this suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  validateManifestShape,
  validateBundleAgainstMap,
  validateThemeBundle,
  parseHexColor,
} = loadTs('src/renderer/src/scene/office/themeBundle.ts');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'theme-bundle-valid');
const VALID_MANIFEST_RAW = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'theme.json'), 'utf8'));
const VALID_MAP_RAW_TEXT = fs.readFileSync(path.join(FIXTURE_DIR, 'map.tmj'), 'utf8');

/** A pristine copy of the fixture, re-read from disk every call.
 *
 *  Deliberately NOT `JSON.parse(JSON.stringify(VALID_MANIFEST_RAW))`:
 *  `validateManifestShape` fills its optional anchors in PLACE, so any test
 *  that validates VALID_MANIFEST_RAW leaves `anchors.worldClock` /
 *  `askBoard` / `coffeeSteam` stamped onto the shared object, and cloning it
 *  afterwards hands the next test a manifest that is no longer the fixture.
 *  Re-reading the file makes each test's copy independent of run order. */
function cloneManifest() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'theme.json'), 'utf8'));
}

test('station spots are optional and empty station lists remain empty', () => {
  const legacy = cloneManifest();
  assert.equal(validateThemeBundle(legacy, VALID_MAP_RAW_TEXT).ok, true);
  assert.equal(legacy.stationSpots, undefined);
  legacy.stationSpots = [];
  assert.equal(validateThemeBundle(legacy, VALID_MAP_RAW_TEXT).ok, true);
  assert.deepEqual(legacy.stationSpots, []);
});

test('authored station kinds and facings validate on the bundle own map', () => {
  const manifest = cloneManifest();
  manifest.stationSpots = ['shelf', 'terminal', 'web', 'board', 'mailbox', 'mcp'].map((kind, i) => ({
    kind, stand: { x: i + 1, y: 3 }, facing: ['up', 'down', 'left', 'right'][i % 4],
  }));
  assert.equal(validateThemeBundle(manifest, VALID_MAP_RAW_TEXT).ok, true);
});

for (const [label, value] of [
  ['null list', null], ['object list', {}], ['null spot', [null]],
  ['unknown kind', [{ kind: 'printer', stand: { x: 1, y: 3 }, facing: 'up' }]],
  ['desk kind', [{ kind: 'desk', stand: { x: 1, y: 3 }, facing: 'up' }]],
  ['missing stand', [{ kind: 'shelf', facing: 'up' }]],
  ['fractional coordinate', [{ kind: 'shelf', stand: { x: 1.5, y: 3 }, facing: 'up' }]],
  ['NaN coordinate', [{ kind: 'shelf', stand: { x: 1, y: NaN }, facing: 'up' }]],
  ['infinite coordinate', [{ kind: 'shelf', stand: { x: Infinity, y: 3 }, facing: 'up' }]],
  ['invalid facing', [{ kind: 'shelf', stand: { x: 1, y: 3 }, facing: 'north' }]],
]) {
  test(`station schema rejects ${label}`, () => {
    const manifest = cloneManifest(); manifest.stationSpots = value;
    const result = validateManifestShape(manifest);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.code === 'stationSpots' || e.code === 'stationSpot'));
  });
}

for (const [stand, code] of [[{ x: 0, y: 0 }, 'tileNotWalkable'], [{ x: 99, y: 1 }, 'tileOutOfBounds'], [{ x: -1, y: 1 }, 'tileOutOfBounds']]) {
  test(`station map validation rejects ${JSON.stringify(stand)}`, () => {
    const manifest = cloneManifest();
    manifest.stationSpots = [{ kind: 'shelf', stand, facing: 'up' }];
    const result = validateThemeBundle(manifest, VALID_MAP_RAW_TEXT);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.code === code && e.message.includes('stationSpots[0].stand')));
  });
}

// ─── the happy path ──────────────────────────────────────────────────────────

test('a valid bundle (test/fixtures/theme-bundle-valid) passes both validation passes cleanly', () => {
  const shape = validateManifestShape(VALID_MANIFEST_RAW);
  assert.equal(shape.ok, true, `shape validation failed: ${shape.ok ? '' : JSON.stringify(shape.errors)}`);

  const mapErrors = validateBundleAgainstMap(shape.manifest, VALID_MAP_RAW_TEXT);
  assert.deepEqual(mapErrors, [], `map validation found unexpected errors: ${JSON.stringify(mapErrors)}`);

  const combined = validateThemeBundle(VALID_MANIFEST_RAW, VALID_MAP_RAW_TEXT);
  assert.equal(combined.ok, true);
});

test('validateThemeBundle can validate manifest shape alone (map text omitted)', () => {
  const result = validateThemeBundle(VALID_MANIFEST_RAW);
  assert.equal(result.ok, true);
});

// ─── optional anchors: old bundles keep importing ────────────────────────────
//
// The fixture manifest declares only calendar/boards/clock — exactly the
// schema bundles shipped against before worldClock/askBoard/coffeeSteam
// existed. Those three must be FILLED IN, not rejected and not left undefined:
// themeLoader.ts hands `manifest.anchors` straight to ThemeConfig, and
// OfficeFloor reads `.x`/`.y` off each one without a guard.

test('a bundle predating worldClock/askBoard/coffeeSteam still validates, with each anchor defaulted', () => {
  const manifest = cloneManifest();
  assert.equal(manifest.anchors.worldClock, undefined, 'fixture should NOT declare the newer anchors');
  assert.equal(manifest.anchors.askBoard, undefined);
  assert.equal(manifest.anchors.coffeeSteam, undefined);

  const result = validateManifestShape(manifest);
  assert.equal(result.ok, true, `expected an old-shape bundle to pass: ${result.ok ? '' : JSON.stringify(result.errors)}`);

  // worldClock → the interactive clock's own wall tile.
  assert.deepEqual(result.manifest.anchors.worldClock, manifest.anchors.clock);
  // askBoard → the task boards' wall run (the only wall tile an old manifest has).
  assert.deepEqual(result.manifest.anchors.askBoard, manifest.anchors.boards);
  // coffeeSteam → the machine's top tile, 3 rows above where a character brews.
  assert.deepEqual(result.manifest.anchors.coffeeSteam, {
    x: manifest.coffee.machineStand.x,
    y: manifest.coffee.machineStand.y - 3,
  });
  // The board stands → office.tmj's own offsets from its boards anchor.
  const b = manifest.anchors.boards;
  assert.deepEqual(result.manifest.anchors.boardPinStand, { x: b.x + 2, y: b.y + 1 });
  assert.deepEqual(result.manifest.anchors.boardTakeStand, { x: b.x + 3, y: b.y + 1 });
  assert.deepEqual(result.manifest.anchors.boardArchiveStand, { x: b.x + 6, y: b.y + 1 });
});

test('anchors a bundle DOES declare are never overwritten by the defaults', () => {
  const manifest = cloneManifest();
  manifest.anchors.worldClock = { x: 2, y: 2 };
  manifest.anchors.askBoard = { x: 3, y: 3 };
  manifest.anchors.coffeeSteam = { x: 4, y: 4 };
  manifest.anchors.boardPinStand = { x: 5, y: 5 };
  manifest.anchors.boardTakeStand = { x: 6, y: 6 };
  manifest.anchors.boardArchiveStand = { x: 7, y: 7 };
  const result = validateManifestShape(manifest);
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.anchors.worldClock, { x: 2, y: 2 });
  assert.deepEqual(result.manifest.anchors.askBoard, { x: 3, y: 3 });
  assert.deepEqual(result.manifest.anchors.coffeeSteam, { x: 4, y: 4 });
  assert.deepEqual(result.manifest.anchors.boardPinStand, { x: 5, y: 5 });
  assert.deepEqual(result.manifest.anchors.boardTakeStand, { x: 6, y: 6 });
  assert.deepEqual(result.manifest.anchors.boardArchiveStand, { x: 7, y: 7 });
});

test('coffeeSteam falls back to the boards wall when coffee.machineStand is itself unusable', () => {
  const manifest = cloneManifest();
  delete manifest.coffee.machineStand;
  const result = validateManifestShape(manifest);
  // The manifest is rejected (machineStand is required) — but the anchor pass
  // must not throw on the way there, and must still produce a usable tile.
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'coffee'));
  assert.deepEqual(manifest.anchors.coffeeSteam, manifest.anchors.boards);
});

// ─── invalid bundles: each must be rejected with a SPECIFIC, human message ───

test('corrupt / non-object theme.json is rejected with a specific message, not a stack trace', () => {
  for (const bad of [undefined, null, 'not an object', 42, ['array', 'not', 'object']]) {
    const result = validateManifestShape(bad);
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to fail shape validation`);
    assert.ok(result.errors.length >= 1);
    assert.match(result.errors[0].message, /JSON object/);
  }
});

test('a missing required top-level field is rejected, naming the field', () => {
  const manifest = cloneManifest();
  delete manifest.label;
  const result = validateManifestShape(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /label/.test(e.message)), 'expected an error mentioning "label"');
});

test('a seat name that does not exist in the map is rejected by name — the exact example from the phase brief', () => {
  const manifest = cloneManifest();
  manifest.primarySeatNames = [...manifest.primarySeatNames, 'pc-3'];
  const shape = validateManifestShape(manifest);
  assert.equal(shape.ok, true, 'manifest shape itself should still be valid — only the map cross-check should fail');
  const errors = validateBundleAgainstMap(shape.manifest, VALID_MAP_RAW_TEXT);
  assert.ok(errors.length >= 1);
  const hit = errors.find((e) => e.code === 'seatMissing');
  assert.ok(hit, `expected a 'seatMissing' error, got: ${JSON.stringify(errors)}`);
  assert.match(hit.message, /'pc-3'/);
  assert.match(hit.message, /does not exist/);
});

test('a cafe stand pointing at a nonexistent spawn point is rejected', () => {
  const manifest = cloneManifest();
  manifest.cafeStands = [['cafe-stand-nonexistent', 'coffee']];
  const shape = validateManifestShape(manifest);
  assert.equal(shape.ok, true);
  const errors = validateBundleAgainstMap(shape.manifest, VALID_MAP_RAW_TEXT);
  const hit = errors.find((e) => e.code === 'seatMissing' && e.message.includes('cafe-stand-nonexistent'));
  assert.ok(hit, `expected a seatMissing error for cafe-stand-nonexistent, got: ${JSON.stringify(errors)}`);
});

test('a coffee stand tile that is blocked in the collision layer is rejected', () => {
  const manifest = cloneManifest();
  // (0, 0) is the map's border wall — blocked in every cell of the fixture's
  // collision layer (see test/fixtures/theme-bundle-valid/map.tmj).
  manifest.coffee.machineStand = { x: 0, y: 0 };
  const shape = validateManifestShape(manifest);
  assert.equal(shape.ok, true);
  const errors = validateBundleAgainstMap(shape.manifest, VALID_MAP_RAW_TEXT);
  const hit = errors.find((e) => e.code === 'tileNotWalkable' && e.message.includes('coffee.machineStand'));
  assert.ok(hit, `expected a tileNotWalkable error for coffee.machineStand, got: ${JSON.stringify(errors)}`);
});

test('an errand-spot stand tile outside the map bounds is rejected', () => {
  const manifest = cloneManifest();
  manifest.errandSpots[0].stand = { x: 999, y: 999 };
  const shape = validateManifestShape(manifest);
  assert.equal(shape.ok, true);
  const errors = validateBundleAgainstMap(shape.manifest, VALID_MAP_RAW_TEXT);
  const hit = errors.find((e) => e.code === 'tileOutOfBounds');
  assert.ok(hit, `expected a tileOutOfBounds error, got: ${JSON.stringify(errors)}`);
});

test('a tileset whose columns x tilewidth does not match its declared imagewidth is rejected', () => {
  const manifest = cloneManifest();
  manifest.tilesets.push({
    file: 'extra.png',
    firstgid: 2,
    image: 'extra',
    imagewidth: 100, // wrong: columns(16) * tilewidth(16) = 256, not 100
    imageheight: 256,
    tilewidth: 16,
    tileheight: 16,
    columns: 16,
    tilecount: 256,
  });
  const shape = validateManifestShape(manifest);
  assert.equal(shape.ok, true, 'shape check does not verify cross-field geometry — that is the map-aware pass');
  const errors = validateBundleAgainstMap(shape.manifest, VALID_MAP_RAW_TEXT);
  const hit = errors.find((e) => e.code === 'tilesetGeometry' && e.message.includes('extra.png'));
  assert.ok(hit, `expected a tilesetGeometry error for extra.png, got: ${JSON.stringify(errors)}`);
});

test('a tileset firstgid that overlaps the previous tileset\'s gid range is rejected', () => {
  const manifest = cloneManifest();
  // The fixture's single embedded tileset occupies gid 1 (firstgid 1, tilecount 1),
  // so the next tileset must start at gid >= 2. firstgid 1 overlaps it.
  manifest.tilesets.push({
    file: 'extra.png',
    firstgid: 1,
    image: 'extra',
    imagewidth: 16,
    imageheight: 16,
    tilewidth: 16,
    tileheight: 16,
    columns: 1,
    tilecount: 1,
  });
  const shape = validateManifestShape(manifest);
  assert.equal(shape.ok, true);
  const errors = validateBundleAgainstMap(shape.manifest, VALID_MAP_RAW_TEXT);
  const hit = errors.find((e) => e.code === 'tilesetGidOverlap');
  assert.ok(hit, `expected a tilesetGidOverlap error, got: ${JSON.stringify(errors)}`);
});

test('a monitor gid outside the declared tilesets\' gid range is rejected', () => {
  const manifest = cloneManifest();
  manifest.monitor.onGids = [[999, 0, 0]];
  const shape = validateManifestShape(manifest);
  assert.equal(shape.ok, true);
  const errors = validateBundleAgainstMap(shape.manifest, VALID_MAP_RAW_TEXT);
  const hit = errors.find((e) => e.code === 'monitorGidOutOfRange');
  assert.ok(hit, `expected a monitorGidOutOfRange error, got: ${JSON.stringify(errors)}`);
});

test('the map file itself failing to parse as Tiled JSON is rejected specifically, not silently', () => {
  const shape = validateManifestShape(VALID_MANIFEST_RAW);
  assert.equal(shape.ok, true);
  const errors = validateBundleAgainstMap(shape.manifest, '{ this is not valid json');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'mapJson');
  assert.match(errors[0].message, /not valid JSON/);
});

test('a map missing Tiled\'s required top-level keys is rejected specifically', () => {
  const shape = validateManifestShape(VALID_MANIFEST_RAW);
  assert.equal(shape.ok, true);
  const errors = validateBundleAgainstMap(shape.manifest, JSON.stringify({ hello: 'world' }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'mapShape');
});

// ─── parseHexColor ────────────────────────────────────────────────────────

test('parseHexColor accepts "#rrggbb" and bare "rrggbb", rejects everything else', () => {
  assert.equal(parseHexColor('#1a1320'), 0x1a1320);
  assert.equal(parseHexColor('1a1320'), 0x1a1320);
  assert.equal(parseHexColor('#FFFFFF'), 0xffffff);
  assert.equal(parseHexColor('not-a-color'), null);
  assert.equal(parseHexColor('#12345'), null); // too short
  assert.equal(parseHexColor(12345), null); // not even a string
});
