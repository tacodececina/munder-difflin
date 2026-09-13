'use strict';

// isoTileArt.ts is the 2:1 isometric sibling of tileArt.ts: the same
// procedural recipe (per-variant tone, grout on the two shared edges,
// occlusion on the shadow edge, sparse sheen on the lit edge, grain flecks)
// drawn onto a diamond instead of a square, out of the same primitives and
// the same TILE_PALETTES.
//
// Two things are actually load-bearing here and both are asserted:
//   1. BUFFER CONTRACT — right size, fully deterministic. A generator whose
//      output shifts between calls cannot be cached by (variant, palette),
//      which is the whole reason tileArt's tiles are cheap.
//   2. SILHOUETTE / SEAMLESSNESS — the 32x16 diamond must partition the plane
//      when laid out on isoCellOrigin. This is the one property a square tile
//      gets for free and a diamond does not, so it is tested directly by
//      stamping a grid and counting coverage per pixel: any gap or any
//      double-cover is a visible seam in the running scene.
//
// No DOM, no Pixi: isoTileArt is pure arithmetic over a raw RGBA buffer,
// exactly like tileArt's drawing half.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  ISO_TILE_W,
  ISO_TILE_H,
  ISO_WALL_FACE_H,
  isoWallTileHeight,
  isoRowSpan,
  isoCellOrigin,
  drawIsoFloorTile,
  drawIsoWallTile,
} = loadTs('src/renderer/src/scene/office/isoTileArt.ts');

const { TILE_PALETTES } = loadTs('src/renderer/src/scene/office/tileArt.ts');

const PALETTE_KEYS = Object.keys(TILE_PALETTES);
const alphaAt = (buf, w, x, y) => buf[(y * w + x) * 4 + 3];
const rgbKey = (buf, i) => `${buf[i * 4]},${buf[i * 4 + 1]},${buf[i * 4 + 2]}`;

// ─── dimensions ──────────────────────────────────────────────────────────────
test('the iso tile is 2:1 and both half-steps are whole pixels', () => {
  assert.equal(ISO_TILE_W, 2 * ISO_TILE_H, 'a pixel-art iso tile is exactly 2:1');
  assert.equal(ISO_TILE_W % 2, 0);
  assert.equal(ISO_TILE_H % 2, 0);
  // Integer half-width/half-height is what keeps every tile origin on a whole
  // pixel — see isoCellOrigin.
  assert.equal(isoCellOrigin(1, 0).x, ISO_TILE_W / 2);
  assert.equal(isoCellOrigin(1, 0).y, ISO_TILE_H / 2);
  assert.equal(isoCellOrigin(0, 1).x, -ISO_TILE_W / 2);
  assert.equal(isoCellOrigin(0, 1).y, ISO_TILE_H / 2);
  assert.deepEqual(isoCellOrigin(0, 0), { x: 0, y: 0 });
});

// ─── the diamond silhouette ──────────────────────────────────────────────────
test('isoRowSpan is a clean 2px step run that covers exactly half the bounding box', () => {
  let total = 0;
  let prevLeft = null;
  for (let y = 0; y < ISO_TILE_H; y++) {
    const [l, r] = isoRowSpan(y);
    assert.ok(l <= r, `row ${y} must be non-empty`);
    // symmetric about the vertical centre line
    assert.equal(l + r, ISO_TILE_W - 1, `row ${y} must be horizontally centred`);
    // Every step is exactly 2 columns — the clean shallow slope; a 1 or a 3
    // anywhere in this run is a jaggy repeated at every tile edge in the room.
    // The single exception is the waist (rows HALF_H-1 / HALF_H), where the
    // edge turns the corner at the W and E tips and holds its column for two
    // rows; that is the corner, not a step.
    if (prevLeft !== null) {
      const step = Math.abs(l - prevLeft);
      assert.equal(step, y === ISO_TILE_H / 2 ? 0 : 2,
        `row ${y} must step by ${y === ISO_TILE_H / 2 ? 0 : 2}, stepped by ${step}`);
    }
    prevLeft = l;
    total += r - l + 1;
  }
  assert.equal(total, (ISO_TILE_W * ISO_TILE_H) / 2,
    'a 2:1 diamond owns exactly half its bounding box, or it cannot tile');
});

test('the floor silhouette is exactly the diamond isoRowSpan describes', () => {
  const buf = drawIsoFloorTile(0, TILE_PALETTES.office);
  for (let y = 0; y < ISO_TILE_H; y++) {
    const [l, r] = isoRowSpan(y);
    for (let x = 0; x < ISO_TILE_W; x++) {
      const inside = x >= l && x <= r;
      assert.equal(alphaAt(buf, ISO_TILE_W, x, y), inside ? 255 : 0,
        `pixel (${x},${y}) should be ${inside ? 'opaque' : 'transparent'}`);
    }
  }
});

test('iso floor tiles laid on isoCellOrigin cover the plane exactly once — no seams, no overlap', () => {
  // Stamp a generous grid and then check only the interior, where every
  // contributing neighbour is present. A gap shows up as coverage 0 (a
  // transparent pinhole in the running floor); an overlap as coverage 2
  // (two tiles fighting over a pixel, i.e. a flickering edge).
  const N = 10;
  const W = 400, H = 400, OX = 200, OY = 40;
  const cover = new Uint8Array(W * H);
  const buf = drawIsoFloorTile(0, TILE_PALETTES.office);

  for (let ty = 0; ty < N; ty++) {
    for (let tx = 0; tx < N; tx++) {
      const o = isoCellOrigin(tx, ty);
      for (let y = 0; y < ISO_TILE_H; y++) {
        for (let x = 0; x < ISO_TILE_W; x++) {
          if (!alphaAt(buf, ISO_TILE_W, x, y)) continue;
          cover[(OY + o.y + y) * W + (OX + o.x + x)] += 1;
        }
      }
    }
  }

  // Interior = the diamond-shaped region strictly inside the stamped patch:
  // every pixel belonging to a cell with 1 <= tx,ty <= N-2.
  let checked = 0;
  for (let ty = 1; ty < N - 1; ty++) {
    for (let tx = 1; tx < N - 1; tx++) {
      const o = isoCellOrigin(tx, ty);
      for (let y = 0; y < ISO_TILE_H; y++) {
        const [l, r] = isoRowSpan(y);
        for (let x = l; x <= r; x++) {
          const c = cover[(OY + o.y + y) * W + (OX + o.x + x)];
          assert.equal(c, 1,
            `pixel at cell(${tx},${ty}) local(${x},${y}) covered ${c} time(s), expected exactly 1`);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, (N - 2) * (N - 2) * (ISO_TILE_W * ISO_TILE_H) / 2);
});

// ─── floor buffer contract ───────────────────────────────────────────────────
test('drawIsoFloorTile returns an ISO_TILE_W*ISO_TILE_H*4 buffer for every variant and palette', () => {
  for (const key of PALETTE_KEYS) {
    for (let variant = 0; variant < 4; variant++) {
      const buf = drawIsoFloorTile(variant, TILE_PALETTES[key]);
      assert.ok(buf instanceof Uint8ClampedArray);
      assert.equal(buf.length, ISO_TILE_W * ISO_TILE_H * 4, `${key} variant ${variant}`);
    }
  }
});

test('drawIsoFloorTile is deterministic — same input, byte-identical output', () => {
  for (const key of PALETTE_KEYS) {
    for (let variant = 0; variant < 4; variant++) {
      const a = drawIsoFloorTile(variant, TILE_PALETTES[key]);
      const b = drawIsoFloorTile(variant, TILE_PALETTES[key]);
      assert.deepEqual(Array.from(a), Array.from(b), `${key} variant ${variant} must be reproducible`);
    }
  }
});

test('drawIsoFloorTile variants differ from one another', () => {
  const pal = TILE_PALETTES.office;
  const bufs = [0, 1, 2, 3].map((v) => drawIsoFloorTile(v, pal));
  for (let a = 0; a < bufs.length; a++) {
    for (let b = a + 1; b < bufs.length; b++) {
      assert.notDeepEqual(Array.from(bufs[a]), Array.from(bufs[b]),
        `variant ${a} and ${b} must not be pixel-identical`);
    }
  }
});

test('drawIsoFloorTile is textured, not a flat fill, and uses the shared palette', () => {
  const pal = TILE_PALETTES.office;
  const buf = drawIsoFloorTile(0, pal);
  const colors = new Set();
  for (let i = 0; i < ISO_TILE_W * ISO_TILE_H; i++) {
    if (buf[i * 4 + 3]) colors.add(rgbKey(buf, i));
  }
  assert.ok(colors.size >= 4, `expected base/grout/occlusion/sheen/fleck, got ${colors.size}`);
  assert.ok(colors.has(pal.floor.mortar.join(',')), 'the grout colour must come from TILE_PALETTES');
  assert.ok(colors.has(pal.floor.fleck.join(',')), 'the fleck colour must come from TILE_PALETTES');
});

test('drawIsoFloorTile survives out-of-range variant indices', () => {
  // The tone and fleck tables are indexed modulo their length, exactly as
  // drawFloorTile indexes them, so an out-of-range variant can never read
  // `undefined` and punch a hole in the floor. (The sheen cadence keeps the
  // raw index — also matching drawFloorTile — so variant 4 is a legal tile
  // rather than a byte-for-byte copy of variant 0; nothing calls it with
  // anything but 0-3.)
  const pal = TILE_PALETTES.office;
  for (const variant of [4, 9, 37]) {
    const buf = drawIsoFloorTile(variant, pal);
    assert.equal(buf.length, ISO_TILE_W * ISO_TILE_H * 4);
    for (let y = 0; y < ISO_TILE_H; y++) {
      const [l, r] = isoRowSpan(y);
      for (let x = l; x <= r; x++) {
        assert.equal(alphaAt(buf, ISO_TILE_W, x, y), 255, `variant ${variant} pixel (${x},${y})`);
      }
    }
  }
});

// ─── wall buffer contract ────────────────────────────────────────────────────
test('drawIsoWallTile returns a cap-plus-face sized buffer', () => {
  assert.equal(isoWallTileHeight(), ISO_TILE_H + ISO_WALL_FACE_H);
  for (const faceH of [8, ISO_WALL_FACE_H, 24]) {
    const buf = drawIsoWallTile(TILE_PALETTES.office, { faceHeight: faceH });
    assert.equal(buf.length, ISO_TILE_W * isoWallTileHeight(faceH) * 4, `faceHeight ${faceH}`);
  }
});

test('drawIsoWallTile is deterministic for every palette and face mode', () => {
  for (const key of PALETTE_KEYS) {
    for (const faces of ['both', 'left', 'right']) {
      for (const band of [true, false]) {
        const a = drawIsoWallTile(TILE_PALETTES[key], { faces, band });
        const b = drawIsoWallTile(TILE_PALETTES[key], { faces, band });
        assert.deepEqual(Array.from(a), Array.from(b), `${key}/${faces}/band=${band} must be reproducible`);
      }
    }
  }
});

test('drawIsoWallTile band:false drops the accent line without touching the silhouette', () => {
  const pal = TILE_PALETTES.siliconvalley; // the loudest accent of the four
  const banded = drawIsoWallTile(pal, { band: true });
  const plain = drawIsoWallTile(pal, { band: false });
  assert.equal(banded.length, plain.length);
  const line = pal.wall.line.join(',');
  let bandedHas = false, plainHas = false;
  for (let i = 0; i < plain.length / 4; i++) {
    assert.equal(banded[i * 4 + 3], plain[i * 4 + 3], `pixel ${i} alpha must be unchanged`);
    if (rgbKey(banded, i) === line && banded[i * 4 + 3]) bandedHas = true;
    if (rgbKey(plain, i) === line && plain[i * 4 + 3]) plainHas = true;
  }
  assert.ok(bandedHas, 'the default block carries the accent band');
  assert.ok(!plainHas, 'band:false must leave no accent pixels for a stack to repeat');
});

// Per-column top/bottom rows of the diamond, derived from the silhouette
// contract rather than from the wall buffer, so the wall is checked against
// the cap shape instead of against itself.
const CAP_TOP = new Array(ISO_TILE_W).fill(-1);
const CAP_BOTTOM = new Array(ISO_TILE_W).fill(-1);
for (let y = 0; y < ISO_TILE_H; y++) {
  const [l, r] = isoRowSpan(y);
  for (let x = l; x <= r; x++) {
    if (CAP_TOP[x] < 0) CAP_TOP[x] = y;
    CAP_BOTTOM[x] = y;
  }
}

test('drawIsoWallTile caps the block with the same diamond the floor uses', () => {
  const buf = drawIsoWallTile(TILE_PALETTES.office);
  for (let y = 0; y < ISO_TILE_H; y++) {
    const [l, r] = isoRowSpan(y);
    for (let x = l; x <= r; x++) {
      assert.equal(alphaAt(buf, ISO_TILE_W, x, y), 255, `cap pixel (${x},${y}) must be opaque`);
    }
  }
  // The two columns the diamond never reaches stay empty top to bottom — the
  // block never grows wider than the cell it stands on.
  const h = isoWallTileHeight();
  for (const x of [0, ISO_TILE_W - 1]) {
    assert.equal(CAP_TOP[x], -1, `column ${x} is outside the diamond by construction`);
    for (let y = 0; y < h; y++) {
      assert.equal(alphaAt(buf, ISO_TILE_W, x, y), 0, `column ${x} must be empty at row ${y}`);
    }
  }
});

test('drawIsoWallTile silhouette is exactly the cap plus a faceHeight-tall drop per column', () => {
  for (const faceH of [8, ISO_WALL_FACE_H, 24]) {
    const h = isoWallTileHeight(faceH);
    const buf = drawIsoWallTile(TILE_PALETTES.office, { faceHeight: faceH });
    for (let x = 1; x < ISO_TILE_W - 1; x++) {
      const first = CAP_TOP[x];
      const last = CAP_BOTTOM[x] + faceH;
      for (let y = 0; y < h; y++) {
        const expected = y >= first && y <= last ? 255 : 0;
        assert.equal(alphaAt(buf, ISO_TILE_W, x, y), expected,
          `faceHeight ${faceH}: pixel (${x},${y}) should be ${expected ? 'opaque' : 'transparent'}`);
      }
    }
  }
});

test('drawIsoWallTile reads as three distinct planes and carries the palette accent line', () => {
  const pal = TILE_PALETTES.office;
  const buf = drawIsoWallTile(pal);
  const h = isoWallTileHeight();
  // Sample plain face pixels (3 rows below the ridge — past the lit chamfer,
  // above the accent band) on a left column and its mirror on the right.
  const sample = (x, dy) => rgbKey(buf, (CAP_BOTTOM[x] + 1 + dy) * ISO_TILE_W + x);
  const capColor = rgbKey(buf, 4 * ISO_TILE_W + ISO_TILE_W / 2);
  const leftColor = sample(8, 3);
  const rightColor = sample(ISO_TILE_W - 1 - 8, 3);
  assert.notEqual(capColor, leftColor, 'cap and left face must differ in value');
  assert.notEqual(capColor, rightColor, 'cap and right face must differ in value');
  assert.notEqual(leftColor, rightColor, 'the two vertical faces must differ in value');

  const colors = new Set();
  for (let i = 0; i < ISO_TILE_W * h; i++) if (buf[i * 4 + 3]) colors.add(rgbKey(buf, i));
  assert.ok(colors.has(pal.wall.line.join(',')), 'the panel accent must come from TILE_PALETTES');
});

test("drawIsoWallTile 'left'/'right' drop exactly the other half of the face", () => {
  const pal = TILE_PALETTES.office;
  const h = isoWallTileHeight();
  const left = drawIsoWallTile(pal, { faces: 'left' });
  const right = drawIsoWallTile(pal, { faces: 'right' });
  for (let y = ISO_TILE_H; y < h; y++) {
    for (let x = 0; x < ISO_TILE_W; x++) {
      if (x < ISO_TILE_W / 2) {
        assert.equal(alphaAt(right, ISO_TILE_W, x, y), 0, `'right' must not paint left column ${x}`);
      } else {
        assert.equal(alphaAt(left, ISO_TILE_W, x, y), 0, `'left' must not paint right column ${x}`);
      }
    }
  }
});
