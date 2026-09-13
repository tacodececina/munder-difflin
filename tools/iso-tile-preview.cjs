'use strict';

// Look at the isometric tiles.
//
// src/renderer/src/scene/office/isoTileArt.ts generates raw RGBA buffers and
// nothing in the app renders them yet (by design — this is a visual prototype,
// not a feature). Pixel art cannot be reviewed by reading code, so this script
// composes those buffers into PNGs a human can actually open: a tiled room at
// 1x plus a 6x nearest-neighbour blow-up, and a per-palette tile sheet showing
// all four floor variants and all three wall face modes for every theme
// tileArt.ts ships.
//
// Everything is composited over a dark CHECKERBOARD on purpose. A 2:1 diamond
// only tiles seamlessly if its silhouette owns exactly half its bounding box;
// if that ever breaks, the checker shows straight through the floor field and
// the failure is visible in one glance instead of hiding as a faint seam.
//
//   node tools/iso-tile-preview.cjs [outDir]
//
// Defaults to <os.tmpdir()>/munder-difflin-iso-preview. No dependencies: PNG
// is encoded here with node:zlib, the same way the app has no asset pipeline
// for this art in the first place.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const loadTs = require('../test/load-ts.cjs');

const {
  ISO_TILE_W,
  ISO_TILE_H,
  ISO_WALL_FACE_H,
  isoWallTileHeight,
  isoCellOrigin,
  drawIsoFloorTile,
  drawIsoWallTile,
} = loadTs('src/renderer/src/scene/office/isoTileArt.ts');
const { TILE_PALETTES } = loadTs('src/renderer/src/scene/office/tileArt.ts');

// ─── minimal PNG writer (RGBA8, no filtering) ────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  // 10..12: compression / filter / interlace, all 0
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── tiny RGBA canvas ────────────────────────────────────────────────────────
function makeCanvas(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Dark 8px checker, so any hole in the tiling is unmistakable. */
function fillChecker(canvas) {
  const a = [26, 29, 36], b = [35, 39, 48];
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const c = ((x >> 3) + (y >> 3)) % 2 === 0 ? a : b;
      const i = (y * canvas.width + x) * 4;
      canvas.data[i] = c[0]; canvas.data[i + 1] = c[1]; canvas.data[i + 2] = c[2]; canvas.data[i + 3] = 255;
    }
  }
}

/** Source-over blit of a w x h RGBA buffer. */
function blit(canvas, buf, w, h, dx, dy) {
  for (let y = 0; y < h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= canvas.height) continue;
    for (let x = 0; x < w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= canvas.width) continue;
      const s = (y * w + x) * 4;
      const a = buf[s + 3];
      if (!a) continue;
      const d = (ty * canvas.width + tx) * 4;
      if (a === 255) {
        canvas.data[d] = buf[s]; canvas.data[d + 1] = buf[s + 1];
        canvas.data[d + 2] = buf[s + 2]; canvas.data[d + 3] = 255;
      } else {
        const t = a / 255;
        canvas.data[d] += (buf[s] - canvas.data[d]) * t;
        canvas.data[d + 1] += (buf[s + 1] - canvas.data[d + 1]) * t;
        canvas.data[d + 2] += (buf[s + 2] - canvas.data[d + 2]) * t;
        canvas.data[d + 3] = 255;
      }
    }
  }
}

/** Nearest-neighbour upscale — the only correct way to enlarge pixel art. */
function scale(canvas, factor) {
  const out = makeCanvas(canvas.width * factor, canvas.height * factor);
  for (let y = 0; y < out.height; y++) {
    const sy = (y / factor) | 0;
    for (let x = 0; x < out.width; x++) {
      const sx = (x / factor) | 0;
      const s = (sy * canvas.width + sx) * 4;
      const d = (y * out.width + x) * 4;
      out.data[d] = canvas.data[s]; out.data[d + 1] = canvas.data[s + 1];
      out.data[d + 2] = canvas.data[s + 2]; out.data[d + 3] = canvas.data[s + 3];
    }
  }
  return out;
}

// ─── scene ───────────────────────────────────────────────────────────────────
// office.tmj's floor is one 2x2 meta-tile repeated across the room, its four
// stamps in top-left / top-right / bottom-left / bottom-right order — the same
// order drawIsoFloorTile's `variant` follows. Repeat it the same way here so
// the preview shows the field the renderer would actually produce.
const variantAt = (tx, ty) => ((ty % 2) + 2) % 2 * 2 + ((tx % 2) + 2) % 2;

function buildRoom(paletteKey, cols, rows) {
  const pal = TILE_PALETTES[paletteKey];
  const faceH = ISO_WALL_FACE_H;
  const wallH = isoWallTileHeight(faceH);
  const ops = [];

  const plain = drawIsoWallTile(pal, { faceHeight: faceH, band: false });
  const wall = (tx, ty, faces, stack) => {
    const banded = drawIsoWallTile(pal, { faceHeight: faceH, faces });
    const blank = faces === 'both' ? plain : drawIsoWallTile(pal, { faceHeight: faceH, faces, band: false });
    const o = isoCellOrigin(tx, ty);
    // Bottom block FIRST: each block's face is exactly faceH tall and covers
    // the cap of the block beneath it, so painting bottom-up turns the stack
    // into one continuous wall. Top-down leaves every lower cap stamped over
    // the face above it and the run reads as a staircase of loose cubes.
    // Only the TOP block carries the accent band, or the stack turns into
    // corrugated siding.
    for (let s = 0; s < stack; s++) {
      ops.push({ buf: s === stack - 1 ? banded : blank, w: ISO_TILE_W, h: wallH, x: o.x, y: o.y - s * faceH });
    }
  };

  // Back walls first: the two rows behind the room, stacked two blocks high so
  // the preview shows that a taller wall is stacked cubes, not a new tile.
  for (let tx = cols - 1; tx >= -1; tx--) wall(tx, -1, 'both', 2);
  for (let ty = rows - 1; ty >= 0; ty--) wall(-1, ty, 'both', 2);

  // Floor field.
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const o = isoCellOrigin(tx, ty);
      ops.push({ buf: drawIsoFloorTile(variantAt(tx, ty), pal), w: ISO_TILE_W, h: ISO_TILE_H, x: o.x, y: o.y });
    }
  }

  // Free-standing blocks on the floor, sorted back to front (painter's order
  // in this projection is ascending tx+ty). The 'left'/'right' single-face
  // modes are NOT shown here — a lone block missing a face reads as a bug
  // rather than as a partition; the sheet shows them in isolation instead.
  const props = [
    { tx: 3, ty: 1, faces: 'both', stack: 1 },
    { tx: 6, ty: 2, faces: 'both', stack: 2 },
    { tx: 2, ty: 4, faces: 'both', stack: 1 },
    { tx: 5, ty: 5, faces: 'both', stack: 3 },
  ].sort((a, b) => a.tx + a.ty - (b.tx + b.ty));
  for (const p of props) wall(p.tx, p.ty, p.faces, p.stack);

  return ops;
}

function render(ops, margin = 12) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const op of ops) {
    minX = Math.min(minX, op.x); minY = Math.min(minY, op.y);
    maxX = Math.max(maxX, op.x + op.w); maxY = Math.max(maxY, op.y + op.h);
  }
  const canvas = makeCanvas(maxX - minX + margin * 2, maxY - minY + margin * 2);
  fillChecker(canvas);
  for (const op of ops) blit(canvas, op.buf, op.w, op.h, op.x - minX + margin, op.y - minY + margin);
  return canvas;
}

// ─── tile sheet: every palette, every variant, every face mode ───────────────
function buildSheet() {
  const keys = Object.keys(TILE_PALETTES);
  const cellW = ISO_TILE_W + 6;
  const wallH = isoWallTileHeight();
  const rowH = wallH + 8;
  const cols = 4 + 3;
  const canvas = makeCanvas(cellW * cols + 8, rowH * keys.length + 8);
  fillChecker(canvas);

  keys.forEach((key, r) => {
    const pal = TILE_PALETTES[key];
    const y0 = 4 + r * rowH;
    for (let v = 0; v < 4; v++) {
      // bottom-align the floor diamonds with the wall blocks in the same row
      blit(canvas, drawIsoFloorTile(v, pal), ISO_TILE_W, ISO_TILE_H,
        4 + v * cellW, y0 + wallH - ISO_TILE_H);
    }
    ['both', 'left', 'right'].forEach((faces, i) => {
      blit(canvas, drawIsoWallTile(pal, { faces }), ISO_TILE_W, wallH,
        4 + (4 + i) * cellW, y0);
    });
  });
  return canvas;
}

// ─── main ────────────────────────────────────────────────────────────────────
const outDir = process.argv[2] || path.join(os.tmpdir(), 'munder-difflin-iso-preview');
fs.mkdirSync(outDir, { recursive: true });

const write = (name, canvas) => {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, encodePng(canvas.width, canvas.height, canvas.data));
  console.log(`${file}  (${canvas.width}x${canvas.height})`);
};

const room = render(buildRoom('office', 9, 7));
write('iso-room-office-1x.png', room);
write('iso-room-office-6x.png', scale(room, 6));
write('iso-room-brooklyn99-4x.png', scale(render(buildRoom('brooklyn99', 6, 5)), 4));
write('iso-room-siliconvalley-4x.png', scale(render(buildRoom('siliconvalley', 6, 5)), 4));
write('iso-room-friends-4x.png', scale(render(buildRoom('friends', 6, 5)), 4));
write('iso-tiles-sheet-8x.png', scale(buildSheet(), 8));

console.log(`\nISO_TILE_W x ISO_TILE_H = ${ISO_TILE_W}x${ISO_TILE_H}, wall face ${ISO_WALL_FACE_H}px (block ${ISO_TILE_W}x${isoWallTileHeight()})`);
