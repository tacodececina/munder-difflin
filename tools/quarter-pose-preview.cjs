'use strict';

// Look at the ¾ (three-quarter) character pose, without launching the app.
//
// portraitArt.ts grew a third orientation — a body turned toward screen-right,
// for the isometric office prototype, where a cast that only faces the camera
// or the wall reads as decals standing on a slanted floor. Whether 18×32 has
// enough pixels to insinuate a turned shoulder is a question only eyes can
// answer, so this composes the real buffers into a sheet a human can open.
//
// Follows tools/iso-scene-preview.cjs: no dependencies, PNG encoded here with
// node:zlib, every pixel coming out of the shipped module rather than a second
// renderer. What it adds over that script is the two gates pixel art is always
// judged by and code review never catches:
//
//   • the SILHOUETTE row — every pose flattened to one flat colour. If the ¾
//     silhouette is not obviously a different shape from the front one, the
//     pose is decoration and no amount of shading rescues it.
//   • the 1× strip — the only test that matters for a sprite that will be seen
//     at roughly game size. A pose that only works at 8× is a small
//     illustration, not a sprite.
//
// A faint ground line runs through every cell: all four orientations must put
// the feet on it, or the character bounces 1px when it turns in the scene.
//
//   node tools/quarter-pose-preview.cjs [outDir]
//   QUARTER_CHAR=dwight node tools/quarter-pose-preview.cjs
//
// Writes quarter-pose@8x.png and quarter-pose.png (1×) to
// <os.tmpdir()>/munder-difflin-iso-preview by default.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const loadTs = require('../test/load-ts.cjs');

const {
  sceneFrameBufs, quarterFrameBufs, mirrorSceneBuf, SCENE_W, SCENE_H,
} = loadTs('src/renderer/src/scene/office/portraitArt.ts');

// ─── minimal PNG writer (RGBA8, no filtering) — same as iso-scene-preview ────
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── canvas ──────────────────────────────────────────────────────────────────
function makeCanvas(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}
function px(canvas, x, y, c, a = 255) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const d = (y * canvas.width + x) * 4;
  const t = a / 255;
  canvas.data[d] = canvas.data[d] * (1 - t) + c[0] * t;
  canvas.data[d + 1] = canvas.data[d + 1] * (1 - t) + c[1] * t;
  canvas.data[d + 2] = canvas.data[d + 2] * (1 - t) + c[2] * t;
  canvas.data[d + 3] = 255;
}
/** Nearest-neighbour blit of an 18×32 sprite buffer at `scale`. `flat` (an RGB)
 *  replaces every opaque pixel — that is how the silhouette row is made. */
function blitSprite(canvas, buf, dx, dy, scale, flat) {
  for (let y = 0; y < SCENE_H; y++) {
    for (let x = 0; x < SCENE_W; x++) {
      const s = (y * SCENE_W + x) * 4;
      const a = buf[s + 3];
      if (!a) continue;
      const c = flat || [buf[s], buf[s + 1], buf[s + 2]];
      for (let oy = 0; oy < scale; oy++) {
        for (let ox = 0; ox < scale; ox++) px(canvas, dx + x * scale + ox, dy + y * scale + oy, c, a);
      }
    }
  }
}

// ─── a 3×5 label font (only the glyphs this sheet needs) ─────────────────────
const GLYPHS = {
  A: '.#.|#.#|###|#.#|#.#', B: '##.|#.#|##.|#.#|##.', C: '.##|#..|#..|#..|.##',
  E: '###|#..|##.|#..|###', F: '###|#..|##.|#..|#..', H: '#.#|#.#|###|#.#|#.#',
  I: '###|.#.|.#.|.#.|###', K: '#.#|#.#|##.|#.#|#.#', L: '#..|#..|#..|#..|###',
  M: '#.#|###|###|#.#|#.#', N: '#.#|###|###|###|#.#', O: '.#.|#.#|#.#|#.#|.#.',
  R: '##.|#.#|##.|#.#|#.#', S: '.##|#..|.#.|..#|##.', T: '###|.#.|.#.|.#.|.#.',
  U: '#.#|#.#|#.#|#.#|.#.', X: '#.#|#.#|.#.|#.#|#.#', G: '.##|#..|#.#|#.#|.##',
  P: '##.|#.#|##.|#..|#..', D: '##.|#.#|#.#|#.#|##.', W: '#.#|#.#|###|###|#.#',
  J: '..#|..#|..#|#.#|.#.', V: '#.#|#.#|#.#|#.#|.#.', Y: '#.#|#.#|.#.|.#.|.#.',
  1: '.#.|##.|.#.|.#.|###', 2: '##.|..#|.#.|#..|###', 3: '##.|..#|.#.|..#|##.',
  4: '#.#|#.#|###|..#|..#', 8: '###|#.#|###|#.#|###', '/': '..#|..#|.#.|#..|#..',
  '-': '...|...|###|...|...', ' ': '...|...|...|...|...',
};
function drawText(canvas, text, dx, dy, scale, color) {
  let cx = dx;
  for (const ch of text.toUpperCase()) {
    const g = GLYPHS[ch];
    if (g) {
      g.split('|').forEach((row, ry) => {
        for (let rx = 0; rx < row.length; rx++) {
          if (row[rx] !== '#') continue;
          for (let oy = 0; oy < scale; oy++) {
            for (let ox = 0; ox < scale; ox++) px(canvas, cx + rx * scale + ox, dy + ry * scale + oy, color);
          }
        }
      });
    }
    cx += 4 * scale;
  }
}

// ─── cast-wide sheet (QUARTER_CAST=1) ────────────────────────────────────────
// The single-character sheet above answers "is this turned?". It cannot answer
// the question that actually decides whether the pose ships: "is this STILL
// THIS PERSON after turning, for all fifteen of them?".
//
// Identity at 18×32 is carried almost entirely by the hair mass, and the ¾ head
// replaces every hairstyle with one generic ¾ mass. Judging that from Jim alone
// is judging a nine-style system from one sample — Jim's short parted hair is
// the *easiest* case in the roster. The long, tall and voluminous styles
// (Phyllis, Kelly, Angela, Meredith, Andy) are where a single shared mass has
// the most to lose, and they have never been looked at.
//
// So: one row per character, FRONT immediately beside 3/4 FULL and 3/4 BODY,
// because "same person?" is a comparison that cannot be made from memory. The
// right-hand block repeats the trio at 2× — near the size an agent actually is
// on the office floor — so nobody signs off on an identity that only holds at 6×.
//
//   QUARTER_CAST=1 node tools/quarter-pose-preview.cjs
const FIXED_CAST = [
  'michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley',
  'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith',
];

if (process.env.QUARTER_CAST) {
  const INK_CAST = [28, 26, 34];
  const S = 6;                 // big enough to see craft, small enough for 15 rows
  const TRIO = ['FRONT', '3/4 FULL', '3/4 BODY'];
  const cellW = SCENE_W * S + 8;
  const rowH = SCENE_H * S + 10;
  const labelW = 9 * 4 * 3 + 12;      // room for the longest name at 3×
  const bigW = labelW + cellW * TRIO.length;
  const smallW = (SCENE_W * 2 + 6) * TRIO.length + 24;
  const headerH = 30;
  const cw = bigW + smallW;
  const ch = headerH + rowH * FIXED_CAST.length;
  const sheet = makeCanvas(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const dark = (Math.floor(x / S) + Math.floor(y / S)) % 2 === 0;
      px(sheet, x, y, dark ? [122, 118, 130] : [134, 130, 142]);
    }
  }
  for (let i = 0; i < TRIO.length; i++) {
    drawText(sheet, TRIO[i], labelW + i * cellW + 4, 8, 3, INK_CAST);
  }
  drawText(sheet, 'AT 2X', bigW + 8, 8, 3, INK_CAST);

  for (let r = 0; r < FIXED_CAST.length; r++) {
    const name = FIXED_CAST[r];
    const dy = headerH + r * rowH;
    const trio = [
      sceneFrameBufs(name).front[0],
      quarterFrameBufs(name, 'quarter')[0],
      quarterFrameBufs(name, 'quarterBody')[0],
    ];
    drawText(sheet, name, 6, dy + SCENE_H * S / 2, 3, INK_CAST);
    for (let i = 0; i < trio.length; i++) {
      blitSprite(sheet, trio[i], labelW + i * cellW + 4, dy, S, null);
    }
    // The same three at 2×: the identity test at something like game size.
    for (let i = 0; i < trio.length; i++) {
      blitSprite(sheet, trio[i], bigW + 8 + i * (SCENE_W * 2 + 6),
        dy + SCENE_H * S - SCENE_H * 2, 2, null);
    }
    for (let x = 0; x < cw; x++) px(sheet, x, dy + rowH - 5, [96, 92, 104]);
  }

  const castDir = process.argv[2] || path.join(os.tmpdir(), 'munder-difflin-iso-preview');
  fs.mkdirSync(castDir, { recursive: true });
  const castOut = path.join(castDir, 'quarter-pose-cast.png');
  fs.writeFileSync(castOut, encodePng(cw, ch, sheet.data));
  console.log(`wrote ${castOut} (${cw}x${ch}) — all ${FIXED_CAST.length} characters`);
  process.exit(0);
}

// ─── the sheet ───────────────────────────────────────────────────────────────
const NAME = process.env.QUARTER_CHAR || 'jim';
const SCALE = 8;
const { front, back } = sceneFrameBufs(NAME);
const quarter = quarterFrameBufs(NAME, 'quarter');
const quarterBody = quarterFrameBufs(NAME, 'quarterBody');

// One column per orientation; rows are the three walk phases, then silhouettes.
// FRONT sits next to the two turned poses on purpose: the question is not only
// "is this turned" but "is this still the same person", and that comparison
// cannot be made from memory.
const COLUMNS = [
  { label: 'FRONT', frames: front },
  { label: 'BACK', frames: back },
  { label: '3/4 FULL', frames: quarter },
  { label: '3/4 BODY', frames: quarterBody },
  { label: '3/4 LEFT', frames: quarter.map(mirrorSceneBuf) },
];
const PAD = 2 * SCALE;
const CELL_W = SCENE_W * SCALE + PAD * 2;
const CELL_H = SCENE_H * SCALE + PAD;
const HEADER = 12 * SCALE / 2;          // room for one line of 3×5 text at 3×
const STRIP_H = 14 * SCALE;             // the 1×/2×/3× readability strip
const W = CELL_W * COLUMNS.length;
const H = HEADER + CELL_H * 4 + HEADER + STRIP_H;

const canvas = makeCanvas(W, H);
// Mid-grey checkerboard. Deliberately mid, not dark: the cast's trousers and
// the sprite outline are both near-black, and against a dark field the legs
// silently disappear — which is exactly the kind of thing a review sheet is
// supposed to expose rather than hide. The checker also makes a hole punched
// through a silhouette obvious at a glance.
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dark = (Math.floor(x / SCALE) + Math.floor(y / SCALE)) % 2 === 0;
    px(canvas, x, y, dark ? [122, 118, 130] : [134, 130, 142]);
  }
}

const INK = [28, 26, 34];
const GUIDE = [70, 66, 80];

for (let c = 0; c < COLUMNS.length; c++) {
  const col = COLUMNS[c];
  drawText(canvas, col.label, c * CELL_W + PAD, 4, 3, INK);
  for (let row = 0; row < 4; row++) {
    const dx = c * CELL_W + PAD;
    const dy = HEADER + row * CELL_H;
    // Ground line at the sprite's foot row. Every orientation must sit on it.
    const groundY = dy + SCENE_H * SCALE;
    for (let x = c * CELL_W; x < (c + 1) * CELL_W; x++) px(canvas, x, groundY, GUIDE);
    // Rows 0-2 are the walk phases; row 3 is the same phase-0 frame flattened
    // to one colour — the silhouette test.
    if (row < 3) blitSprite(canvas, col.frames[row], dx, dy, SCALE, null);
    else blitSprite(canvas, col.frames[0], dx, dy, SCALE, [16, 14, 20]);
  }
}
// Sits in the gap between the last walk-phase row's ground line and the top of
// the silhouette row: a 3×5 glyph at 3× is 15px tall and the gap is 16px, so
// this is the only y that does not print the word across a sprite's shoes.
drawText(canvas, 'SILHOUETTE', PAD, HEADER + 3 * CELL_H - 15, 3, GUIDE);

// The 1× strip: the same four poses at game scale, then 2× and 3×, so the
// question "does the turn survive when it is 32 pixels tall" is answerable.
const stripY = HEADER + CELL_H * 4 + HEADER;
drawText(canvas, 'GAME SCALE 1X 2X 3X', PAD, stripY - 6 * SCALE / 2, 3, INK);
let sx = PAD;
for (const s of [1, 2, 3]) {
  for (const col of COLUMNS) {
    blitSprite(canvas, col.frames[0], sx, stripY + (STRIP_H - SCENE_H * s) - SCALE, s, null);
    sx += SCENE_W * s + 6;
  }
  sx += 16;
}

const outDir = process.argv[2] || path.join(os.tmpdir(), 'munder-difflin-iso-preview');
fs.mkdirSync(outDir, { recursive: true });
const big = path.join(outDir, `quarter-pose-${NAME}@8x.png`);
fs.writeFileSync(big, encodePng(W, H, canvas.data));

// Also every pose at 1× on its own, for a pixel-exact look. Sized from
// COLUMNS, not from a literal: the canvas was hard-coded for four columns while
// COLUMNS holds five, so the whole 3/4 LEFT sprite landed past the right edge
// and `px`'s bounds guard silently dropped it — the 1× file was missing the one
// pose that proves the mirror works.
const flat = makeCanvas((SCENE_W + 1) * COLUMNS.length - 1, SCENE_H);
for (let i = 0; i < COLUMNS.length; i++) blitSprite(flat, COLUMNS[i].frames[0], i * (SCENE_W + 1), 0, 1, null);
fs.writeFileSync(path.join(outDir, `quarter-pose-${NAME}.png`),
  encodePng(flat.width, flat.height, flat.data));

console.log(`wrote ${big} (${W}x${H}) — character=${NAME}`);
console.log(`      ${path.join(outDir, `quarter-pose-${NAME}.png`)} (1x, ${COLUMNS.length} poses)`);
