'use strict';

// Regression guard for the tile→world extraction (scene/office/projection.ts).
//
// THE CLAIM UNDER TEST: nothing moved. Before this refactor the conversion was
// `tx * tileSize` written out by hand in TiledMapRenderer.ts, Character.ts,
// OfficeFloor.tsx, DeskScreen.ts, DeskShelf.ts and WorldClock.ts. Every one of
// those formulas is reproduced here, verbatim, as `OLD.*` — and the new
// projection is required to agree with it on a wide sweep of coordinates
// (negatives, zero, and past the far corner of the biggest shipped map), for
// both tile sizes the codebase has ever used.
//
// A failure here means the office floor MOVED, which is the one thing this
// step was not allowed to do.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { createOrthogonalProjection } = loadTs('src/renderer/src/scene/office/projection.ts');

// ── the formulas as they were written, before the extraction ────────────────

const OLD = {
  // TiledMapRenderer.tileToPixel / unflipped tile sprite placement;
  // DeskScreen / DeskShelf / WorldClock / OfficeFloor prop anchors.
  tileToPixel: (tx, ty, ts) => ({ x: tx * ts, y: ty * ts }),
  // TiledMapRenderer.buildTileLayers, the flipped/rotated branch.
  tileCenter: (tx, ty, ts) => ({ x: tx * ts + ts / 2, y: ty * ts + ts / 2 }),
  // Character constructor / repositionTo / updateWalk target; OfficeFloor's
  // `humanPos` (the office door, where escalation envelopes fly).
  foot: (tx, ty, ts) => ({ x: tx * ts + ts / 2, y: ty * ts + ts }),
  // TiledMapRenderer.pixelToTile.
  pixelToTile: (px, py, ts) => ({ x: Math.floor(px / ts), y: Math.floor(py / ts) }),
  // Character.getTilePosition: pixelToTile(px, py - 1).
  footToTile: (px, py, ts) => ({ x: Math.floor(px / ts), y: Math.floor((py - 1) / ts) }),
  // Camera.setMapSize / ThoughtBubble.setBounds arguments.
  mapSize: (w, h, ts) => ({ width: w * ts, height: h * ts }),
  // Every `(row + k) * tileSize ± n` z-index in the scene.
  rowDepth: (row, ts) => row * ts,
};

// Both tile sizes the project has shipped: the maps are 16px, design/tokens.ts
// still documents a 32px world.
const TILE_SIZES = [16, 32];

/** Coordinates worth sweeping: well past both edges of the biggest map
 *  (38×24 today; the brief's 34×22 sits inside this), plus zero and negatives
 *  — an agent's foot anchor and a thought cloud both leave the grid. */
function tileSweep() {
  const out = [];
  for (let v = -64; v <= 96; v++) out.push(v);
  return out;
}

test('tileToWorld reproduces `tx * tileSize` exactly, off-map and negative included', () => {
  const sweep = tileSweep();
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (const tx of sweep) {
      for (const ty of sweep) {
        assert.deepEqual(proj.tileToWorld(tx, ty), OLD.tileToPixel(tx, ty, ts),
          `tileToWorld(${tx},${ty}) @ ts=${ts}`);
      }
    }
  }
});

test('tileCenterToWorld reproduces the flipped-tile pivot exactly', () => {
  const sweep = tileSweep();
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (const tx of sweep) {
      for (const ty of sweep) {
        assert.deepEqual(proj.tileCenterToWorld(tx, ty), OLD.tileCenter(tx, ty, ts),
          `tileCenterToWorld(${tx},${ty}) @ ts=${ts}`);
      }
    }
  }
});

test('tileFootToWorld reproduces the avatar anchor exactly', () => {
  const sweep = tileSweep();
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (const tx of sweep) {
      for (const ty of sweep) {
        assert.deepEqual(proj.tileFootToWorld(tx, ty), OLD.foot(tx, ty, ts),
          `tileFootToWorld(${tx},${ty}) @ ts=${ts}`);
      }
    }
  }
});

test('worldToTile reproduces `Math.floor(px / tileSize)` exactly, including sub-pixel and negative world points', () => {
  // Walking avatars sit at fractional world coordinates every frame (SPEED is
  // 48 px/s against a variable dt), so integers alone would not prove this.
  const fracs = [0, 0.001, 0.25, 0.5, 0.75, 0.999];
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (let base = -1200; base <= 1600; base += 1) {
      for (const f of fracs) {
        const px = base + f;
        const py = -base + f;
        assert.deepEqual(proj.worldToTile(px, py), OLD.pixelToTile(px, py, ts),
          `worldToTile(${px},${py}) @ ts=${ts}`);
      }
    }
  }
});

test('footToTile reproduces Character.getTilePosition (the 1px backtrack) exactly', () => {
  const fracs = [0, 0.001, 0.5, 0.999];
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (let base = -1200; base <= 1600; base += 1) {
      for (const f of fracs) {
        const px = base + f;
        const py = -base + f;
        assert.deepEqual(proj.footToTile(px, py), OLD.footToTile(px, py, ts),
          `footToTile(${px},${py}) @ ts=${ts}`);
      }
    }
  }
});

test('a foot anchor round-trips back to the tile it was made from', () => {
  // The property the scene actually relies on: sit an agent on a tile, ask it
  // which tile it is on, get the same answer. Includes row 0 and the last row
  // of the tallest shipped map.
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (let tx = -8; tx <= 40; tx++) {
      for (let ty = -8; ty <= 26; ty++) {
        const foot = proj.tileFootToWorld(tx, ty);
        assert.deepEqual(proj.footToTile(foot.x, foot.y), { x: tx, y: ty },
          `foot round-trip (${tx},${ty}) @ ts=${ts}`);
      }
    }
  }
});

test("a tile origin round-trips through worldToTile, and so does the cell's centre", () => {
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (let tx = -8; tx <= 40; tx++) {
      for (let ty = -8; ty <= 26; ty++) {
        const o = proj.tileToWorld(tx, ty);
        assert.deepEqual(proj.worldToTile(o.x, o.y), { x: tx, y: ty });
        const c = proj.tileCenterToWorld(tx, ty);
        assert.deepEqual(proj.worldToTile(c.x, c.y), { x: tx, y: ty });
      }
    }
  }
});

test('mapSizeToWorld reproduces `width * tileSize` for every shipped map size', () => {
  // The four shipped .tmj files plus the brief's 34×22 and a couple of edges.
  const SIZES = [[34, 22], [36, 24], [38, 24], [1, 1], [0, 0], [128, 96]];
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (const [w, h] of SIZES) {
      assert.deepEqual(proj.mapSizeToWorld(w, h), OLD.mapSize(w, h, ts), `${w}x${h} @ ts=${ts}`);
    }
  }
});

test('rowDepth reproduces `row * tileSize`', () => {
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (let row = -64; row <= 96; row++) {
      assert.equal(proj.rowDepth(row), OLD.rowDepth(row, ts), `rowDepth(${row}) @ ts=${ts}`);
    }
  }
});

test('depthAtWorldY is the world Y the scene already sorted characters by', () => {
  const proj = createOrthogonalProjection(16);
  for (const y of [-100, -1, 0, 0.5, 1, 17.25, 352, 1e6]) {
    assert.equal(proj.depthAtWorldY(y), y);
  }
});

// ── the z-index of every prop that was migrated, formula by formula ─────────

test('every migrated prop keeps the exact z-index it had', () => {
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (let row = -4; row <= 30; row++) {
      // DeskShelf: (deskTile.y + 1) * tileSize - 2
      assert.equal(proj.rowDepth(row + 1) - 2, (row + 1) * ts - 2, 'DeskShelf');
      // DeskScreen: (topLeft.y + 2) * ts - 1
      assert.equal(proj.rowDepth(row + 2) - 1, (row + 2) * ts - 1, 'DeskScreen');
      // OfficeFloor coffee tray / sink / errand fx / task boards: (y + 1) * ts
      assert.equal(proj.rowDepth(row + 1), (row + 1) * ts, 'tray/sink/errand/board');
      // OfficeFloor taken desk note: desk.y * ts - 1
      assert.equal(proj.rowDepth(row) - 1, row * ts - 1, 'desk note');
    }
    // The wall-row constants: WorldClock and the calendar and the alarm clock
    // all hang on row 3; the coffee machine sorts at row 19; ASK ME at row 11.
    assert.equal(proj.rowDepth(3), 3 * ts, 'wall props');
    assert.equal(proj.rowDepth(19), 19 * ts, 'coffee machine');
    assert.equal(proj.rowDepth(11), 11 * ts, 'ASK ME board');
  }
});

test('a prop anchored at row r sorts behind an avatar standing on row r', () => {
  // The painter's-order invariant the scene depends on, stated in terms of the
  // projection rather than of `tileSize`: an avatar's depth is its foot anchor,
  // which is the FAR edge of its row.
  const proj = createOrthogonalProjection(16);
  for (let row = 0; row < 24; row++) {
    const avatar = proj.depthAtWorldY(proj.tileFootToWorld(0, row).y);
    assert.equal(avatar, proj.rowDepth(row + 1));
    assert.ok(proj.rowDepth(row) < avatar, `row ${row} prop must sort behind its avatar`);
  }
});

// ── the extraction itself: nobody multiplies by a tile size any more ────────

const SCENE = path.resolve(__dirname, '..', 'src/renderer/src/scene/office');

/** Source with line comments dropped, so prose about tileSize cannot trip the
 *  scan below. NOTE the pattern is deliberately unanchored: with `$` and no `m`
 *  flag it silently stopped stripping anything on a CRLF checkout (`.` cannot
 *  cross the `\r`, so `$` never matched), which turned this into a scan over
 *  comments too. */
function code(file) {
  return fs.readFileSync(path.join(SCENE, file), 'utf8')
    .split('\n')
    .map((l) => l.replace(/\/\/.*/, ''))
    .join('\n');
}

test('the six files that used to hardcode the projection no longer scale by a tile size', () => {
  // This is the refactor's actual deliverable. If a new call site starts
  // writing `x * tileSize` again, the projection stops being the single place
  // that knows the geometry — and the next step (a second projection) breaks.
  const FILES = [
    'TiledMapRenderer.ts', 'Character.ts', 'OfficeFloor.tsx',
    'DeskScreen.ts', 'DeskShelf.ts', 'WorldClock.ts',
  ];
  // `ts` / `ts0` / `tsB` / `ts2` / `calTs` were the local aliases for it.
  const NAMES = String.raw`(?:this\.)?(?:mapRenderer\.)?(?:tileSize|tileWidth|tileHeight|calTs|tsB|ts0|ts2)`;
  const MULTIPLY = new RegExp(String.raw`(?:\*\s*${NAMES}\b)|(?:\b${NAMES}\s*\*)`);
  for (const f of FILES) {
    const src = code(f);
    const hit = src.split('\n').find((l) => MULTIPLY.test(l));
    assert.equal(hit, undefined, `${f} still scales by a tile size: ${hit}`);
  }
});

test('the projection module itself stays pixi-free, like tiledCollision.ts', () => {
  // So it can be unit-tested (this file) and reused by the pixi-free theme
  // bundle validator without dragging a renderer in.
  const src = fs.readFileSync(path.join(SCENE, 'projection.ts'), 'utf8');
  assert.ok(!/from '(pixi\.js|@pixi)/.test(src), 'projection.ts imported pixi');
});

test('the map renderer hands its projection out — one instance, shared', () => {
  const src = code('TiledMapRenderer.ts');
  assert.match(src, /readonly projection: Projection/,
    'the renderer must expose the projection every consumer reads');
  assert.match(src, /createOrthogonalProjection\(this\.tileSize\)/,
    'the orthogonal projection must still be built from map.tilewidth — the value the scene always used');
  // The vertical placement of a tile sprite must be ASKED, not hard-coded: a
  // literal `tileHeight - th` here would bottom-align orthogonal maps too, which
  // silently moves any user bundle with a taller atlas (see the guard below).
  assert.match(src, /sprite\.y = p\.y \+ this\.projection\.tileArtOffsetY\(th\)/,
    'the unflipped tile placement must go through projection.tileArtOffsetY');
  assert.ok(!/this\.projection\.tileHeight\s*-\s*th/.test(src),
    'the renderer must not spell the bottom-alignment rule out itself');
});

// ── the second projection (isometric prototype) ─────────────────────────────
//
// Everything above this line is the "nothing moved" guard for the orthogonal
// office. Everything below is about the diamond grid that was added next to it,
// and it is split into two halves on purpose:
//
//   1. THE ORTHOGONAL PROJECTION DID NOT CHANGE when the interface grew. The
//      three members added for isometry (tileDepth / facingForWorldStep /
//      facingForTileStep) each have an orthogonal implementation that has to
//      reproduce a formula that used to be inline somewhere else, exactly like
//      every OLD.* above.
//   2. The isometric implementation keeps the contracts the SCENE relies on —
//      round-tripping, staying inside the world box the camera clamps to, and
//      the depth agreement that makes it legal to sort map tiles and avatars in
//      one container.

const { createIsometricProjection } = loadTs('src/renderer/src/scene/office/projection.ts');
const {
  isoCellOrigin, ISO_TILE_W, ISO_TILE_H,
  buildIsoAtlas, ISO_ATLAS_SLOTS, ISO_ATLAS_CELL, ISO_ATLAS_COLUMNS,
} = loadTs('src/renderer/src/scene/office/isoTileArt.ts');
const { TILE_PALETTES } = loadTs('src/renderer/src/scene/office/tileArt.ts');

const OLD_FACING = {
  // Character.updateWalk, before it delegated.
  walk: (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')),
  // OfficeFloor.facingForSeat / faceFurniture: a fixed answer per neighbour.
  seat: { '0,-1': 'up', '0,1': 'down', '-1,0': 'left', '1,0': 'right' },
};

test('the orthogonal projection still answers every facing question the way the inline code did', () => {
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    // The exact tile steps facingForSeat probes, in its own order.
    for (const [step, want] of Object.entries(OLD_FACING.seat)) {
      const [dtx, dty] = step.split(',').map(Number);
      assert.equal(proj.facingForTileStep(dtx, dty), want, `facingForTileStep(${step}) @ ts=${ts}`);
    }
    // …and a wide sweep of world steps against Character.updateWalk's formula.
    for (let dx = -40; dx <= 40; dx += 1) {
      for (let dy = -40; dy <= 40; dy += 1) {
        assert.equal(proj.facingForWorldStep(dx, dy), OLD_FACING.walk(dx, dy),
          `facingForWorldStep(${dx},${dy}) @ ts=${ts}`);
      }
    }
  }
});

test('the orthogonal tileDepth is rowDepth and nothing else — the column never mattered', () => {
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (let ty = -8; ty <= 40; ty++) {
      for (let tx = -8; tx <= 40; tx++) {
        assert.equal(proj.tileDepth(tx, ty), proj.rowDepth(ty), `tileDepth(${tx},${ty}) @ ts=${ts}`);
        assert.equal(proj.tileDepth(tx, ty), OLD.rowDepth(ty, ts));
      }
    }
  }
  // And the renderer must keep painting orthogonal tile layers under the cast,
  // which is what the old scene graph did.
  assert.equal(createOrthogonalProjection(16).sortsTilesWithCharacters, false);
});

test('an orthogonal tile sprite lands on its cell origin whatever the atlas cell height', () => {
  // THE USER-BUNDLE GUARD. The pre-extraction renderer wrote
  // `sprite.y = y * tileSize` with no reference to the texture height, so a
  // custom theme bundle whose atlas declares e.g. tileheight 32 on a 16px map
  // (a common wall convention) rendered top-aligned. Bottom-aligning it — Tiled's
  // rule, which the isometric atlas needs — would move that art 16px up with no
  // validator error and no shipped map to catch it. So the offset is a
  // projection decision and the orthogonal answer is zero, always.
  for (const ts of TILE_SIZES) {
    const proj = createOrthogonalProjection(ts);
    for (const texH of [1, 8, 16, 17, 24, 32, 48, 64]) {
      assert.equal(proj.tileArtOffsetY(texH), 0, `tileArtOffsetY(${texH}) @ ts=${ts}`);
    }
    // …i.e. the whole placement is byte-for-byte the old inline formula.
    for (const [tx, ty] of [[0, 0], [3, 7], [-2, 5], [40, 90]]) {
      const p = proj.tileToWorld(tx, ty);
      assert.deepEqual({ x: p.x, y: p.y + proj.tileArtOffsetY(32) }, OLD.tileToPixel(tx, ty, ts));
    }
  }
});

// ── isometric ──────────────────────────────────────────────────────────────

const ISO_MAP = { w: 12, h: 12 };
function iso(w = ISO_MAP.w, h = ISO_MAP.h) {
  return createIsometricProjection({
    tileWidth: ISO_TILE_W, tileHeight: ISO_TILE_H, mapWidthInTiles: w, mapHeightInTiles: h,
  });
}

test("the isometric placement is isoTileArt's own cell origin, shifted so nothing is negative", () => {
  // isoTileArt.ts's diamond silhouette is only seamless against THIS placement
  // rule; if the projection drifts from it the floor grows gaps.
  const proj = iso();
  const shift = (ISO_MAP.h - 1) * (ISO_TILE_W / 2);
  for (let tx = 0; tx < ISO_MAP.w; tx++) {
    for (let ty = 0; ty < ISO_MAP.h; ty++) {
      const cell = isoCellOrigin(tx, ty);
      assert.deepEqual(proj.tileToWorld(tx, ty), { x: cell.x + shift, y: cell.y + ISO_TILE_H },
        `tileToWorld(${tx},${ty})`);
    }
  }
});

test('every isometric tile lands inside the world box the camera clamps to', () => {
  // Camera.ts assumes the world spans [0,mapWidth] x [0,mapHeight]; a diamond
  // grid naturally runs negative at its west corner, so the projection has to
  // absorb that. A 32x32 wall block is the tallest art, so its top edge is the
  // binding constraint on the headroom.
  for (const [w, h] of [[12, 12], [1, 1], [20, 6], [6, 20]]) {
    const proj = iso(w, h);
    const world = proj.mapSizeToWorld(w, h);
    for (let tx = 0; tx < w; tx++) {
      for (let ty = 0; ty < h; ty++) {
        const p = proj.tileToWorld(tx, ty);
        const artTop = p.y + proj.tileArtOffsetY(32); // the renderer's bottom-alignment
        assert.ok(p.x >= 0, `tile (${tx},${ty}) x=${p.x} went negative on ${w}x${h}`);
        assert.ok(artTop >= 0, `tile (${tx},${ty}) art started at y=${artTop} on ${w}x${h}`);
        assert.ok(p.x + ISO_TILE_W <= world.width, `tile (${tx},${ty}) ran past the east edge`);
        assert.ok(p.y + ISO_TILE_H <= world.height, `tile (${tx},${ty}) ran past the south edge`);
      }
    }
  }
});

test('the isometric projection bottom-aligns tall art, and only the isometric one does', () => {
  const proj = iso();
  // A floor diamond fills the cell's height exactly → no overhang.
  assert.equal(proj.tileArtOffsetY(ISO_TILE_H), 0);
  // A wall cube is one whole cell-height taller → it hangs that far above.
  assert.equal(proj.tileArtOffsetY(ISO_ATLAS_CELL), ISO_TILE_H - ISO_ATLAS_CELL);
  for (const texH of [1, 8, 16, 17, 32, 48]) {
    assert.equal(proj.tileArtOffsetY(texH), proj.tileHeight - texH, `tileArtOffsetY(${texH})`);
  }
  // The two projections must genuinely disagree here — that is the whole point
  // of asking the projection instead of hard-coding one rule in the renderer.
  assert.notEqual(proj.tileArtOffsetY(ISO_ATLAS_CELL), createOrthogonalProjection(16).tileArtOffsetY(ISO_ATLAS_CELL));
});

test('an isometric foot anchor round-trips back to its own tile', () => {
  const proj = iso();
  for (let tx = 0; tx < ISO_MAP.w; tx++) {
    for (let ty = 0; ty < ISO_MAP.h; ty++) {
      const foot = proj.tileFootToWorld(tx, ty);
      assert.deepEqual(proj.footToTile(foot.x, foot.y), { x: tx, y: ty }, `round-trip (${tx},${ty})`);
      assert.deepEqual(proj.worldToTile(foot.x, foot.y), { x: tx, y: ty });
    }
  }
});

test('an isometric foot anchor still round-trips while the avatar is mid-step', () => {
  // Walking avatars sit at fractional world coordinates every frame, and
  // Character.getTilePosition is read on those.
  const proj = iso();
  for (let tx = 1; tx < ISO_MAP.w - 1; tx++) {
    for (let ty = 1; ty < ISO_MAP.h - 1; ty++) {
      const a = proj.tileFootToWorld(tx, ty);
      for (const [nx, ny] of [[tx + 1, ty], [tx, ty + 1], [tx - 1, ty], [tx, ty - 1]]) {
        const b = proj.tileFootToWorld(nx, ny);
        // Anywhere in the first 40% of the step must still read as the tile
        // being left; anywhere in the last 40% as the tile being entered.
        for (const t of [0, 0.1, 0.25, 0.4]) {
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          assert.deepEqual(proj.footToTile(p.x, p.y), { x: tx, y: ty }, `leaving (${tx},${ty}) at t=${t}`);
        }
        for (const t of [0.6, 0.75, 0.9, 1]) {
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          assert.deepEqual(proj.footToTile(p.x, p.y), { x: nx, y: ny }, `entering (${nx},${ny}) at t=${t}`);
        }
      }
    }
  }
});

test('THE DEPTH CONTRACT: an avatar on a tile sorts exactly with that tile', () => {
  // This is what makes it legal to put map tiles and characters in ONE sorted
  // container (TiledMapRenderer's `sortsTilesWithCharacters` path). If these
  // two ever disagree by a scale factor, walls stop occluding people.
  const proj = iso();
  assert.equal(proj.sortsTilesWithCharacters, true);
  for (let tx = 0; tx < ISO_MAP.w; tx++) {
    for (let ty = 0; ty < ISO_MAP.h; ty++) {
      const foot = proj.tileFootToWorld(tx, ty);
      assert.equal(proj.depthAtWorldY(foot.y), proj.tileDepth(tx, ty), `depth at (${tx},${ty})`);
    }
  }
});

test('anything one diagonal step nearer the camera sorts in front', () => {
  const proj = iso();
  for (let tx = 0; tx < ISO_MAP.w - 1; tx++) {
    for (let ty = 0; ty < ISO_MAP.h - 1; ty++) {
      const here = proj.tileDepth(tx, ty);
      assert.ok(proj.tileDepth(tx + 1, ty) > here, 'the +x neighbour is nearer');
      assert.ok(proj.tileDepth(tx, ty + 1) > here, 'the +y neighbour is nearer');
      // …and the two tiles on the SAME diagonal are a genuine tie, which is
      // correct: neither can occlude the other.
      if (tx > 0) assert.equal(proj.tileDepth(tx - 1, ty + 1), here);
    }
  }
});

test('walking away from the camera shows the back, walking toward it shows the face', () => {
  // THE REGRESSION THIS WHOLE MEMBER EXISTS FOR. Under 2:1 every cardinal tile
  // step has |dx| = 2|dy|, so the old inline `Math.abs(dx) > Math.abs(dy)`
  // answered 'right'/'left' for all four of them — an avatar walking away from
  // the camera would have kept its face pointed at it.
  const proj = iso();
  const WANT = {
    '1,0': 'right',  // south-east: toward the viewer, to the right → front row
    '0,1': 'left',   // south-west: toward the viewer, to the left  → front, mirrored
    '-1,0': 'up',    // north-west: away → back row
    '0,-1': 'up',    // north-east: away → back row
  };
  for (const [step, want] of Object.entries(WANT)) {
    const [dtx, dty] = step.split(',').map(Number);
    assert.equal(proj.facingForTileStep(dtx, dty), want, `facingForTileStep(${step})`);
    // The same answer has to come out of the world-space form the walk loop
    // actually calls, at every magnitude a frame step can produce.
    const from = proj.tileFootToWorld(4, 4);
    const to = proj.tileFootToWorld(4 + dtx, 4 + dty);
    for (const mag of [0.01, 0.5, 1, 4.3, 16]) {
      const dx = (to.x - from.x) * mag;
      const dy = (to.y - from.y) * mag;
      assert.equal(proj.facingForWorldStep(dx, dy), want, `facingForWorldStep for ${step} x${mag}`);
    }
  }
  // At least one of the four must be the back row, and at least one the front —
  // i.e. the sheet's up row is genuinely reachable, which is the bug.
  const answers = Object.keys(WANT).map((s) => proj.facingForTileStep(...s.split(',').map(Number)));
  assert.ok(answers.includes('up'), 'no tile step ever showed the back');
  assert.ok(answers.some((a) => a === 'left' || a === 'right'), 'no tile step ever showed the front');
});

// ── the generated atlas ────────────────────────────────────────────────────

test('the generated isometric atlas is the size its tileset metadata claims', () => {
  // themeRegistry's ISOMETRIC_TILESETS hard-codes imagewidth/imageheight/
  // columns/tilecount, and the renderer slices frames out of the texture with
  // those numbers. A mismatch would silently crop every tile.
  const atlas = buildIsoAtlas(TILE_PALETTES.office);
  assert.equal(atlas.cell, ISO_ATLAS_CELL);
  assert.equal(atlas.columns, ISO_ATLAS_COLUMNS);
  assert.equal(atlas.tilecount, ISO_ATLAS_SLOTS.length);
  assert.equal(atlas.width, 128);
  assert.equal(atlas.height, 64);
  assert.equal(atlas.data.length, atlas.width * atlas.height * 4);
});

test('every atlas cell is bottom-aligned, so one y-offset rule serves both tile heights', () => {
  const atlas = buildIsoAtlas(TILE_PALETTES.office);
  const alphaAt = (x, y) => atlas.data[(y * atlas.width + x) * 4 + 3];
  ISO_ATLAS_SLOTS.forEach((slot, i) => {
    const ox = (i % atlas.columns) * atlas.cell;
    const oy = Math.floor(i / atlas.columns) * atlas.cell;
    // The diamond's widest row is its waist; its BOTTOM row is the 2px tip, and
    // that tip must sit on the cell's last row for the isometric projection's
    // bottom-alignment (`tileArtOffsetY`) to put the diamond on the floor.
    let lowest = -1;
    for (let y = 0; y < atlas.cell; y++) {
      for (let x = 0; x < atlas.cell; x++) if (alphaAt(ox + x, oy + y)) { lowest = y; break; }
    }
    assert.equal(lowest, atlas.cell - 1, `${slot} is not bottom-aligned in its cell`);
  });
});

test('the isometric atlas takes its colours from the theme palette, with no art files', () => {
  // The whole reason the prototype needed no new assets: swap the palette key
  // and the same room comes out in that show's own floor/wall colours.
  const a = buildIsoAtlas(TILE_PALETTES.office);
  const b = buildIsoAtlas(TILE_PALETTES.friends);
  assert.notDeepEqual(Array.from(a.data), Array.from(b.data));
  // Deterministic: the renderer builds this on every mount.
  assert.deepEqual(Array.from(buildIsoAtlas(TILE_PALETTES.office).data), Array.from(a.data));
});

// ── the four shipped themes must not have moved ────────────────────────────

test('every theme that shipped before the prototype is still an orthogonal map', () => {
  // The one requirement that is not negotiable: adding a second projection must
  // not change what office/brooklyn99/siliconvalley/friends look like. All four
  // were authored in Tiled and therefore state `"orientation":"orthogonal"`
  // explicitly — the field TiledMapRenderer branches on, and the reason it tests
  // for 'isometric' rather than switching on the value.
  const MAPS = path.resolve(__dirname, '..', 'src/renderer/src/assets/maps');
  for (const f of ['office.tmj', 'brooklyn99.tmj', 'siliconvalley.tmj', 'friends.tmj']) {
    const m = JSON.parse(fs.readFileSync(path.join(MAPS, f), 'utf8'));
    assert.equal(m.orientation, 'orthogonal', `${f} must stay orthogonal`);
    assert.equal(m.tilewidth, 16, `${f} must keep its 16px cell`);
    assert.equal(m.tileheight, 16, `${f} must keep its 16px cell`);
    // Every tileset the renderer slices frames from must agree with the cell,
    // so the placement below is the zero-offset case for the shipped art too.
    for (const ts of m.tilesets) {
      if (ts.tileheight === undefined) continue; // external .tsx — not sliced here
      assert.equal(ts.tileheight, m.tileheight, `${f}: tileset "${ts.name}" is not ${m.tileheight}px tall`);
    }
  }
  const isoMap = JSON.parse(fs.readFileSync(path.join(MAPS, 'isometric.tmj'), 'utf8'));
  assert.equal(isoMap.orientation, 'isometric');
  assert.equal(isoMap.tilewidth, ISO_TILE_W);
  assert.equal(isoMap.tileheight, ISO_TILE_H);
});
