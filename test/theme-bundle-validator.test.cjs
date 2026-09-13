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

/** Deep-clone helper so each test mutates its own copy of the fixture. */
function cloneManifest() {
  return JSON.parse(JSON.stringify(VALID_MANIFEST_RAW));
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
