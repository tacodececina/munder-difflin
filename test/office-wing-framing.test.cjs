'use strict';

// Framing one WING of the office floor (src/renderer/src/scene/office/wingFraming.ts).
//
// The rebuilt office map is 48x36 tiles and the camera's only mode was
// fitToScreen() — the whole floor squeezed into the panel. Wings are the fix:
// point the camera at ONE named zone. `Camera.focusOn()` had been sitting unused
// in the file the whole time; this module is the arithmetic that feeds it.
//
// What these tests guard is everything that would rot in silence, because none
// of it throws when it is wrong — it just looks slightly off on screen:
//
//   1. The zoom is DERIVED FROM THE ZONE. A small room and a big one must not be
//      drawn at the same scale, and a magic constant is exactly how that
//      happens. This is the requirement most likely to be "simplified" away.
//   2. The clamp matches the camera's. focusOn() re-clamps to [minZoom, 4]; if
//      this module returned something outside that, the number the tests pin
//      would not be the number on screen.
//   3. The wing is CENTRED, with air around it. "Everything is cramped" is the
//      complaint this feature answers; a wing drawn edge-to-edge repeats it.
//   4. Selecting an agent never strands them. Framing a wing sets the camera's
//      `manualOverride`, and nudgeToward() silently bails out under it — so
//      without a rule, clicking an agent in another wing does nothing at all and
//      the user is looking at the wrong room. All four branches are pinned here.
//   5. Non-office themes degrade to NO wings, so the picker never mounts on
//      them. Their maps have zones (`cafeteria`, `livingroom`, `holding`) that a
//      looser filter would happily turn into fake rooms.
//
// Pure by construction: no pixi, no store, no DOM — the same discipline
// idleAffinity.ts and projection.ts are held to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  computeWingFraming, wingWorldRect, fitZoom,
  wingsFromZones, wingContainingTile, wingForSelection,
  wingSuffix, wingLabelKey, wingFallbackLabel,
  WING_PREFIX, WING_PADDING_TILES, MAX_WING_ZOOM,
} = loadTs('src/renderer/src/scene/office/wingFraming.ts');

const { createOrthogonalProjection, createIsometricProjection } =
  loadTs('src/renderer/src/scene/office/projection.ts');

const TILE = 16;
const proj = createOrthogonalProjection(TILE);

const root = path.join(__dirname, '..');
const mapFile = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/src/assets/maps', name), 'utf8'));

/** The real office map's zones, in the same tile units parseZones produces. */
function zonesOf(name) {
  const map = mapFile(name);
  const layer = map.layers.find((l) => l.name === 'zones' && l.type === 'objectgroup');
  const out = new Map();
  for (const o of layer?.objects ?? []) {
    out.set(o.name, {
      x: Math.floor(o.x / map.tilewidth),
      y: Math.floor(o.y / map.tileheight),
      width: Math.floor((o.width ?? 0) / map.tilewidth),
      height: Math.floor((o.height ?? 0) / map.tileheight),
    });
  }
  return { map, zones: out };
}

const OFFICE = zonesOf('office.tmj');
const officeWings = wingsFromZones(OFFICE.zones);
const officeMapWorld = proj.mapSizeToWorld(OFFICE.map.width, OFFICE.map.height);
/** A representative panel: the floor column of a 1280-wide window. */
const VIEW = { width: 900, height: 560 };

const frame = (zone, view = VIEW) =>
  computeWingFraming({ zone, projection: proj, view, mapWorld: officeMapWorld });

// ── the map actually declares wings ─────────────────────────────────────────

test('the office map declares the five wings the picker offers', () => {
  assert.deepEqual(
    officeWings.map((w) => w.name),
    ['wing-engineering', 'wing-warroom', 'wing-meeting', 'wing-deploy', 'wing-break'],
    'the wings changed in office.tmj — the labels in every locale need to follow',
  );
});

test('`boardroom` is not offered as a wing', () => {
  // It is the same rectangle as wing-meeting and exists for the seat-overflow
  // code in OfficeFloor. Offering both would put the same room in the list twice
  // under two names.
  assert.equal(wingContainingTile({ x: -1, y: -1 }, officeWings), null);
  assert.ok(!officeWings.some((w) => w.name === 'boardroom'));
  assert.ok(OFFICE.zones.has('boardroom'), 'the overflow zone itself must still exist');
});

// ── (5) every other theme degrades to no control at all ─────────────────────

test('no other shipped theme offers a single wing', () => {
  // Their zones are prop/seating regions, not places to point a camera. A filter
  // loose enough to catch them would invent rooms called "holding".
  for (const name of ['brooklyn99.tmj', 'friends.tmj', 'siliconvalley.tmj', 'isometric.tmj']) {
    const { zones } = zonesOf(name);
    assert.deepEqual(wingsFromZones(zones), [], `${name} would mount the wing picker`);
  }
});

test('a zone that is only the bare prefix, or has no area, is not a wing', () => {
  const zones = new Map([
    [WING_PREFIX, { x: 0, y: 0, width: 4, height: 4 }],          // no room name
    ['wing-flat', { x: 0, y: 0, width: 0, height: 4 }],           // zero width
    ['wing-thin', { x: 0, y: 0, width: 4, height: 0 }],           // zero height
    ['wing-real', { x: 1, y: 1, width: 4, height: 4 }],
  ]);
  assert.deepEqual(wingsFromZones(zones).map((w) => w.name), ['wing-real']);
});

test('wings keep the order the map declares them in', () => {
  // The picker renders this list verbatim; sorting it alphabetically would put
  // "wing-break" first, which is not how anyone reads a floor plan.
  const zones = new Map([
    ['wing-zulu', { x: 0, y: 0, width: 2, height: 2 }],
    ['wing-alpha', { x: 4, y: 0, width: 2, height: 2 }],
  ]);
  assert.deepEqual(wingsFromZones(zones).map((w) => w.name), ['wing-zulu', 'wing-alpha']);
});

// ── (1) the zoom comes from the zone, not from a constant ───────────────────

test('a small wing is drawn CLOSER than a large one', () => {
  // The whole requirement in one assertion: if this ever passes with both sides
  // equal, the zoom has been replaced by a magic number.
  const eng = frame(OFFICE.zones.get('wing-engineering'));   // 27x20 tiles
  const meet = frame(OFFICE.zones.get('wing-meeting'));      // 17x9 tiles
  assert.ok(meet.zoom > eng.zoom,
    `the meeting room (17x9) must be closer than engineering (27x20): ${meet.zoom} vs ${eng.zoom}`);
});

test('every wing is a real step in from the whole-floor overview', () => {
  const overview = fitZoom(officeMapWorld.width, officeMapWorld.height, VIEW);
  for (const w of officeWings) {
    const f = frame(w.rect);
    assert.ok(f.zoom > overview * 1.2,
      `${w.name} zooms to ${f.zoom} against an overview of ${overview} — that is not worth a click`);
  }
});

test('halving a wing\'s size doubles its zoom', () => {
  // Exactly proportional, padding aside — the property a derived zoom has and a
  // lookup table does not.
  const big = { x: 0, y: 0, width: 200, height: 200 };
  const small = { x: 0, y: 0, width: 100, height: 100 };
  const view = { width: 2000, height: 2000 };
  // A map large enough that NEITHER clamp binds — this test is about the raw
  // proportionality, and the clamps have their own tests above.
  const hugeMap = proj.mapSizeToWorld(1000, 1000);
  const noPad = (zone) => computeWingFraming({
    zone, projection: proj, view, mapWorld: hugeMap, paddingTiles: 0,
  });
  assert.ok(noPad(small).zoom < MAX_WING_ZOOM, 'the ceiling must not bind here');
  assert.equal(noPad(small).zoom / noPad(big).zoom, 2);
});

// ── (2) the clamp is the camera's clamp ─────────────────────────────────────

test('the zoom ceiling is the one Camera.focusOn enforces', () => {
  const camera = fs.readFileSync(path.join(root, 'src/renderer/src/scene/office/Camera.ts'), 'utf8');
  const m = camera.match(/Math\.min\((\d+),\s*zoom/);
  assert.ok(m, 'focusOn no longer clamps zoom with a literal ceiling — re-read it');
  assert.equal(Number(m[1]), MAX_WING_ZOOM,
    'MAX_WING_ZOOM drifted from the camera: this module would hand focusOn a value it silently rewrites');
});

test('a tiny wing is capped instead of magnifying the tile art past 4x', () => {
  const f = computeWingFraming({
    zone: { x: 10, y: 10, width: 2, height: 2 },
    projection: proj,
    view: { width: 1600, height: 1200 },
    mapWorld: officeMapWorld,
  });
  assert.equal(f.zoom, MAX_WING_ZOOM);
});

test('a wing never zooms out past the whole-floor fit', () => {
  // The lower clamp. "Zooming into a wing" that showed LESS than the overview it
  // replaced would be a strictly worse view.
  const overview = fitZoom(officeMapWorld.width, officeMapWorld.height, VIEW);
  const wholeMap = { x: 0, y: 0, width: OFFICE.map.width, height: OFFICE.map.height };
  const f = frame(wholeMap);   // padding alone would push this below the fit
  assert.ok(f.zoom >= overview - 1e-9, `${f.zoom} < ${overview}`);
});

test('a viewport that has not been measured yet frames at 1x rather than NaN', () => {
  // ResizeObserver fires with 0x0 during teardown; a division by zero here would
  // put Infinity into the camera's lerp and never come back.
  const f = frame(OFFICE.zones.get('wing-break'), { width: 0, height: 0 });
  assert.equal(f.zoom, 1);
  assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y));
});

// ── (3) centred, with air ───────────────────────────────────────────────────

test('the camera lands on the wing\'s centre, in world pixels', () => {
  const z = OFFICE.zones.get('wing-deploy');   // tiles (30,15) 17x9
  const f = frame(z);
  assert.deepEqual(
    { x: f.x, y: f.y },
    { x: (z.x + z.width / 2) * TILE, y: (z.y + z.height / 2) * TILE },
  );
});

test('a framed wing keeps a margin instead of touching the panel edges', () => {
  const z = OFFICE.zones.get('wing-meeting');
  const f = frame(z);
  const rect = wingWorldRect(z, proj);
  // Whichever axis is tight, the wing must still be inset by the padding.
  const slackX = VIEW.width / f.zoom - rect.width;
  const slackY = VIEW.height / f.zoom - rect.height;
  const pad = 2 * WING_PADDING_TILES * TILE;
  assert.ok(slackX >= pad - 1e-9, `no horizontal air: ${slackX}`);
  assert.ok(slackY >= pad - 1e-9, `no vertical air: ${slackY}`);
});

test('padding costs zoom rather than being decorative', () => {
  const z = OFFICE.zones.get('wing-engineering');
  const padded = frame(z);
  const bare = computeWingFraming({
    zone: z, projection: proj, view: VIEW, mapWorld: officeMapWorld, paddingTiles: 0,
  });
  assert.ok(bare.zoom > padded.zoom);
  assert.equal(bare.x, padded.x, 'padding must not move the centre');
});

// ── the world rectangle ─────────────────────────────────────────────────────

test('a tile rectangle becomes the world box the map renderer draws', () => {
  assert.deepEqual(
    wingWorldRect({ x: 2, y: 3, width: 4, height: 5 }, proj),
    { x: 32, y: 48, width: 64, height: 80 },
  );
});

test('the world box is a true bounding box under a diamond grid too', () => {
  // No shipped isometric map declares zones, but `width * tileWidth` would be
  // wrong the day one does — the box around a tile rectangle is not the product
  // of its sides there. Corner-derived, so it already holds.
  const iso = createIsometricProjection({
    tileWidth: 32, tileHeight: 16, mapWidthInTiles: 12, mapHeightInTiles: 12,
  });
  // Deliberately NOT square: a square tile region's diamond box happens to be
  // `width * tileWidth` wide, so it would prove nothing.
  const r = wingWorldRect({ x: 0, y: 0, width: 4, height: 8 }, iso);
  const corners = [iso.tileToWorld(0, 0), iso.tileToWorld(4, 0), iso.tileToWorld(0, 8), iso.tileToWorld(4, 8)];
  assert.equal(r.x, Math.min(...corners.map((c) => c.x)));
  assert.equal(r.y, Math.min(...corners.map((c) => c.y)));
  assert.ok(r.width > 0 && r.height > 0);
  assert.notEqual(r.width, 4 * iso.tileWidth, 'the naive product would have been wrong here');
});

// ── which wing is a tile in ─────────────────────────────────────────────────

test('a tile inside a wing resolves to it, and the corridor between resolves to none', () => {
  const z = OFFICE.zones.get('wing-warroom');
  assert.equal(wingContainingTile({ x: z.x, y: z.y }, officeWings), 'wing-warroom');
  assert.equal(
    wingContainingTile({ x: z.x + z.width - 1, y: z.y + z.height - 1 }, officeWings),
    'wing-warroom',
    'the far corner is inside — the rectangle is half-open, not inclusive-exclusive by accident',
  );
  // One past the far edge belongs to the corridor, not to the wing.
  assert.notEqual(
    wingContainingTile({ x: z.x + z.width, y: z.y + z.height }, officeWings),
    'wing-warroom',
  );
});

test('the corridor between the wings belongs to none of them', () => {
  // The wings do NOT tile the floor — the office map leaves a walkable gutter
  // between the west block and the east one. An agent standing in it (mid coffee
  // run, walking to a meeting) is the "no wing" case the selection rule falls
  // back on, so if this ever became false that branch would be unreachable.
  const gutter = { x: 28, y: 20 };
  assert.equal(wingContainingTile(gutter, officeWings), null);
  const gaps = [];
  for (let y = 0; y < OFFICE.map.height; y++) {
    for (let x = 0; x < OFFICE.map.width; x++) {
      if (wingContainingTile({ x, y }, officeWings) === null) gaps.push([x, y]);
    }
  }
  assert.ok(gaps.length > 50, `only ${gaps.length} tiles are outside every wing`);
});

// ── (4) selecting an agent must never strand them ───────────────────────────

test('on the whole floor, selection changes nothing — the old glance still runs', () => {
  // The no-regression branch: a user who never opens the picker must get exactly
  // the camera behaviour that shipped before it existed.
  assert.equal(wingForSelection(null, 'wing-deploy'), null);
  assert.equal(wingForSelection(null, null), null);
});

test('selecting someone in the wing you are already in holds the shot', () => {
  assert.equal(wingForSelection('wing-break', 'wing-break'), 'wing-break');
});

test('selecting someone in ANOTHER wing follows them there', () => {
  // The failure this rule exists to prevent: nudgeToward() bails out under the
  // camera's manualOverride, so without this the selection lands off screen and
  // nothing explains why.
  assert.equal(wingForSelection('wing-break', 'wing-warroom'), 'wing-warroom');
});

test('selecting someone between rooms falls back to the whole office', () => {
  // A coffee run, the entrance, a corridor: no wing would show them, and the
  // overview always does.
  assert.equal(wingForSelection('wing-break', null), null);
});

test('the rule is idempotent — a selection never bounces between two wings', () => {
  let view = 'wing-engineering';
  for (let i = 0; i < 5; i++) view = wingForSelection(view, 'wing-deploy');
  assert.equal(view, 'wing-deploy');
});

// ── labels ──────────────────────────────────────────────────────────────────

test('every wing on the office map has a label in all four locales', () => {
  for (const code of ['en', 'es', 'ar', 'zh-CN']) {
    const l = JSON.parse(fs.readFileSync(
      path.join(root, `src/renderer/src/i18n/locales/${code}.json`), 'utf8'));
    for (const key of ['title', 'openTitle', 'all', 'hint']) {
      assert.ok(l.office.wings[key], `${code} is missing office.wings.${key}`);
    }
    for (const w of officeWings) {
      const leaf = wingLabelKey(w.name).split('.').reduce((n, s) => n?.[s], l);
      assert.ok(leaf, `${code} has no label for ${w.name}`);
    }
  }
});

test('an unknown wing gets a readable label instead of a raw key', () => {
  // A user-authored theme bundle can name a wing this app has never heard of.
  assert.equal(wingSuffix('wing-cold-storage'), 'cold-storage');
  assert.equal(wingFallbackLabel('wing-cold-storage'), 'Cold storage');
  assert.equal(wingLabelKey('wing-cold-storage'), 'office.wings.names.cold-storage');
});

test('a map-derived label can never shadow the picker\'s own strings', () => {
  // Why `names.` exists: a zone called `wing-title` must not resolve to the
  // panel heading.
  assert.ok(wingLabelKey('wing-title').startsWith('office.wings.names.'));
  assert.notEqual(wingLabelKey('wing-all'), 'office.wings.all');
});
