'use strict';

// Phase 10 (tvshow-phase10-procedural-floor-walls): tileArt.ts draws
// procedural floor/wall tiles the same way portraitArt.ts draws character
// portraits — a tiny set of primitives (shades/setPx) into a raw RGBA
// buffer — instead of reusing the generic recycled tile pack every theme
// shipped with before. Unlike portraitArt.ts, tileArt.ts never touches
// `document` itself (patchTilesetCanvas takes a caller-supplied 2D context),
// so this test needs no DOM shim at all — it fakes just the three
// CanvasRenderingContext2D methods patchTilesetCanvas actually calls,
// backed by a plain in-memory RGBA buffer standing in for a whole atlas
// image.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  drawFloorTile,
  drawWallTile,
  patchTilesetCanvas,
  TILE_PALETTES,
} = loadTs('src/renderer/src/scene/office/tileArt.ts');

// ─── a fake "atlas canvas" backed by a flat RGBA buffer ──────────────────────
function makeFakeAtlasCtx(width, height, fill = () => [0, 0, 0, 0]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  const ctx = {
    getImageData(sx, sy, sw, sh) {
      const out = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) {
        const srcOff = ((sy + y) * width + sx) * 4;
        const dstOff = (y * sw) * 4;
        out.set(data.subarray(srcOff, srcOff + sw * 4), dstOff);
      }
      return { width: sw, height: sh, data: out };
    },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(imgData, dx, dy) {
      for (let y = 0; y < imgData.height; y++) {
        const srcOff = (y * imgData.width) * 4;
        const dstOff = ((dy + y) * width + dx) * 4;
        data.set(imgData.data.subarray(srcOff, srcOff + imgData.width * 4), dstOff);
      }
    },
  };
  return { ctx, data, width, height };
}

// ─── drawFloorTile ────────────────────────────────────────────────────────────
test('drawFloorTile returns a fully opaque tw*th*4 buffer for every variant', () => {
  const pal = TILE_PALETTES.office;
  for (let variant = 0; variant < 4; variant++) {
    const buf = drawFloorTile(16, 16, variant, pal);
    assert.equal(buf.length, 16 * 16 * 4);
    let minAlpha = 255;
    for (let i = 0; i < 16 * 16; i++) minAlpha = Math.min(minAlpha, buf[i * 4 + 3]);
    assert.equal(minAlpha, 255, `variant ${variant} must be fully opaque (no holes)`);
  }
});

test('drawFloorTile is not a flat single color — the whole point of Phase 10 is texture, not another solid fill', () => {
  const pal = TILE_PALETTES.office;
  const buf = drawFloorTile(16, 16, 0, pal);
  const colors = new Set();
  for (let i = 0; i < 16 * 16; i++) colors.add(`${buf[i * 4]},${buf[i * 4 + 1]},${buf[i * 4 + 2]}`);
  assert.ok(colors.size >= 3, `expected multiple distinct colors (grout/sheen/fleck/base), got ${colors.size}`);
});

test('drawFloorTile variants differ from one another (no two of the 2x2 meta-tile positions are identical)', () => {
  const pal = TILE_PALETTES.office;
  const bufs = [0, 1, 2, 3].map((v) => drawFloorTile(16, 16, v, pal));
  for (let a = 0; a < bufs.length; a++) {
    for (let b = a + 1; b < bufs.length; b++) {
      assert.notDeepEqual(Array.from(bufs[a]), Array.from(bufs[b]), `variant ${a} and ${b} must not be pixel-identical`);
    }
  }
});

test('drawFloorTile is deterministic', () => {
  const pal = TILE_PALETTES.office;
  const a = drawFloorTile(16, 16, 2, pal);
  const b = drawFloorTile(16, 16, 2, pal);
  assert.deepEqual(Array.from(a), Array.from(b));
});

// ─── drawWallTile ─────────────────────────────────────────────────────────────
test('drawWallTile preserves the source alpha silhouette exactly (never reshapes a wall piece)', () => {
  const pal = TILE_PALETTES.office;
  const tw = 16, th = 16;
  // a synthetic silhouette: a rounded-ish blob, opaque in the middle, the
  // corners fully transparent — stands in for office.tmj's real wall gids
  // (rounded corners, double-bar mullions, etc.), which is exactly the shape
  // information this function must not disturb.
  const mask = new Uint8ClampedArray(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const cx = x - tw / 2, cy = y - th / 2;
      mask[y * tw + x] = (cx * cx + cy * cy) < (tw / 2) * (tw / 2) ? 255 : 0;
    }
  }
  const out = drawWallTile(tw, th, mask, pal);
  for (let i = 0; i < tw * th; i++) {
    assert.equal(out[i * 4 + 3], mask[i], `pixel ${i} alpha must match the source mask exactly`);
  }
});

test('drawWallTile paints real shading (not a single flat RGB) across the opaque region', () => {
  const pal = TILE_PALETTES.office;
  const tw = 16, th = 16;
  const mask = new Uint8ClampedArray(tw * th).fill(255); // fully opaque tile
  const out = drawWallTile(tw, th, mask, pal);
  const colors = new Set();
  for (let i = 0; i < tw * th; i++) colors.add(`${out[i * 4]},${out[i * 4 + 1]},${out[i * 4 + 2]}`);
  assert.ok(colors.size >= 2, `expected a gradient/panel-line, got ${colors.size} distinct color(s)`);
});

test('drawWallTile leaves fully-transparent input untouched (transparent stays transparent)', () => {
  const pal = TILE_PALETTES.office;
  const tw = 16, th = 16;
  const mask = new Uint8ClampedArray(tw * th); // all zero
  const out = drawWallTile(tw, th, mask, pal);
  for (let i = 0; i < tw * th; i++) assert.equal(out[i * 4 + 3], 0);
});

// ─── patchTilesetCanvas: the actual atlas-compositing integration point ──────
test('patchTilesetCanvas is a no-op when the entry has no patches', () => {
  const { ctx, data } = makeFakeAtlasCtx(64, 64, () => [10, 20, 30, 255]);
  const before = Array.from(data);
  patchTilesetCanvas(ctx, { firstgid: 1, columns: 4, tilewidth: 16, tileheight: 16 });
  assert.deepEqual(Array.from(data), before);
});

test('patchTilesetCanvas repaints exactly the requested floor/wall gid cells and leaves every other pixel untouched', () => {
  // A tiny synthetic 4-col atlas of 16x16 tiles (64x64 px = 16 cells,
  // firstgid 1): cell (col,row) -> gid = firstgid + row*columns + col.
  // gid 6 -> local 5 -> col1,row1. gid 11 -> local 10 -> col2,row2.
  const { ctx, data, width, height } = makeFakeAtlasCtx(64, 64, (x, y) => {
    // an opaque diagonal stripe stands in for a "wall piece" silhouette so
    // the wall patch has real alpha structure to preserve, and a flat fill
    // elsewhere stands in for "some other tile" (desks/chairs/etc. — must
    // survive untouched).
    return [200, 40, 40, ((x + y) % 5 === 0) ? 255 : 0];
  });
  const before = Array.from(data);

  const entry = {
    firstgid: 1,
    columns: 4,
    tilewidth: 16,
    tileheight: 16,
    patches: [
      { kind: 'floor', gids: [6] },   // local 5 -> col1,row1 -> px(16,16)
      { kind: 'wall', gids: [11] },   // local 10 -> col2,row2 -> px(32,32)
    ],
  };
  patchTilesetCanvas(ctx, entry);

  function cellChanged(px, py) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = ((py + y) * width + (px + x)) * 4;
        for (let c = 0; c < 4; c++) if (data[i + c] !== before[i + c]) return true;
      }
    }
    return false;
  }

  assert.ok(cellChanged(16, 16), 'floor gid cell (col1,row1) should have been repainted');
  assert.ok(cellChanged(32, 32), 'wall gid cell (col2,row2) should have been repainted');

  // Every OTHER cell (everything that isn't the two patched gids) must be
  // byte-identical to the source — this is the whole promise of "compose
  // over the base atlas": desks/chairs/monitors/every other prop untouched.
  let untouchedPixels = 0, totalOutsidePatched = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inFloorCell = x >= 16 && x < 32 && y >= 16 && y < 32;
      const inWallCell = x >= 32 && x < 48 && y >= 32 && y < 48;
      if (inFloorCell || inWallCell) continue;
      totalOutsidePatched++;
      const i = (y * width + x) * 4;
      if (data[i] === before[i] && data[i + 1] === before[i + 1] && data[i + 2] === before[i + 2] && data[i + 3] === before[i + 3]) {
        untouchedPixels++;
      }
    }
  }
  assert.equal(untouchedPixels, totalOutsidePatched, 'pixels outside the patched gid cells must be byte-identical to the source');
});

test('patchTilesetCanvas floor patch is fully opaque even where the source tile had transparency', () => {
  // The office.tmj floor gids are fully opaque in the real atlas too, but
  // this guards the actual contract: a floor patch must not inherit holes
  // from whatever happened to be at that gid position before.
  const { ctx, data, width } = makeFakeAtlasCtx(32, 32, () => [0, 0, 0, 0]); // fully transparent source
  patchTilesetCanvas(ctx, {
    firstgid: 1, columns: 2, tilewidth: 16, tileheight: 16,
    patches: [{ kind: 'floor', gids: [1] }], // local 0 -> col0,row0 -> px(0,0)
  });
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (y * width + x) * 4;
      assert.equal(data[i + 3], 255, `floor pixel (${x},${y}) must be opaque`);
    }
  }
});

// ─── palette shape ────────────────────────────────────────────────────────────
test("TILE_PALETTES.office has valid floor/wall RGB triples", () => {
  const pal = TILE_PALETTES.office;
  for (const group of [pal.floor.base, pal.floor.mortar, pal.floor.fleck, pal.wall.base, pal.wall.line]) {
    assert.equal(group.length, 3);
    for (const c of group) {
      assert.ok(Number.isInteger(c) && c >= 0 && c <= 255, `channel ${c} out of [0,255]`);
    }
  }
});
