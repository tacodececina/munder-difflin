'use strict';

// Look at the isometric PROTOTYPE SCENE, without launching the app.
//
// tools/iso-tile-preview.cjs renders the tiles in isolation; this renders the
// thing the theme actually produces: isometric.tmj, composited through the REAL
// `createIsometricProjection` and the REAL `buildIsoAtlas`, with real character
// sprites (portraitArt.ts's scene buffers) standing on the seats — and sorted by
// the same `tileDepth` / `depthAtWorldY` the renderer sorts by.
//
// It is a review instrument, not a second renderer: every number it uses comes
// out of the shipped modules, so if the projection or the atlas changes, this
// picture changes with it. What it deliberately does NOT reproduce is pixi's
// stable-sort tie-breaking and the camera, neither of which affects whether the
// occlusion reads correctly.
//
//   node tools/iso-scene-preview.cjs [outDir]
//   ISO_WALKER_POSE=quarterBody node tools/iso-scene-preview.cjs   (what-if)
//
// ISO_WALKER_POSE re-poses the two WALKERS (the standing, non-seated agents)
// with one of portraitArt's turned orientations, so the question "would a
// turned body actually help on a diagonal floor?" can be looked at BEFORE any
// of it is wired into cast.ts. It is a preview-only override: nothing in the
// app reads it, and the default ('front') reproduces the previous image
// byte-for-byte, so this file's normal output is unchanged.
//
// Writes iso-scene.png (1x) and iso-scene@3x.png. Defaults to
// <os.tmpdir()>/munder-difflin-iso-preview.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const loadTs = require('../test/load-ts.cjs');

const { buildIsoAtlas, ISO_ATLAS_CELL, ISO_ATLAS_COLUMNS } =
  loadTs('src/renderer/src/scene/office/isoTileArt.ts');
const { TILE_PALETTES } = loadTs('src/renderer/src/scene/office/tileArt.ts');
const { createIsometricProjection } = loadTs('src/renderer/src/scene/office/projection.ts');
const { sceneFrameBufs, quarterFrameBufs, SCENE_W, SCENE_H } =
  loadTs('src/renderer/src/scene/office/portraitArt.ts');

// Preview-only pose override for the standing walkers — see the header note.
// Anything other than a turned orientation falls back to the front frames, so
// a typo degrades to the previous picture rather than to a crash.
const WALKER_POSE = process.env.ISO_WALKER_POSE || 'front';
const TURNED = WALKER_POSE === 'quarter' || WALKER_POSE === 'quarterBody';

const MAP = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/src/assets/maps/isometric.tmj'), 'utf8'));

// ─── minimal PNG writer (RGBA8, no filtering) — same as iso-tile-preview ─────
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
function makeCanvas(width, height, bg) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
/** Source-over blit of an RGBA buffer. */
function blit(canvas, buf, w, h, dx, dy) {
  for (let y = 0; y < h; y++) {
    const cy = dy + y;
    if (cy < 0 || cy >= canvas.height) continue;
    for (let x = 0; x < w; x++) {
      const cx = dx + x;
      if (cx < 0 || cx >= canvas.width) continue;
      const s = (y * w + x) * 4;
      const a = buf[s + 3];
      if (!a) continue;
      const d = (cy * canvas.width + cx) * 4;
      const t = a / 255;
      canvas.data[d] = canvas.data[d] * (1 - t) + buf[s] * t;
      canvas.data[d + 1] = canvas.data[d + 1] * (1 - t) + buf[s + 1] * t;
      canvas.data[d + 2] = canvas.data[d + 2] * (1 - t) + buf[s + 2] * t;
      canvas.data[d + 3] = 255;
    }
  }
}
function scale(canvas, factor) {
  const out = makeCanvas(canvas.width * factor, canvas.height * factor, [0, 0, 0]);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const s = (Math.floor(y / factor) * canvas.width + Math.floor(x / factor)) * 4;
      const d = (y * out.width + x) * 4;
      out.data[d] = canvas.data[s]; out.data[d + 1] = canvas.data[s + 1];
      out.data[d + 2] = canvas.data[s + 2]; out.data[d + 3] = 255;
    }
  }
  return out;
}

// ─── the scene ───────────────────────────────────────────────────────────────
const paletteKey = process.env.ISO_PALETTE || 'office';
const pal = TILE_PALETTES[paletteKey] || TILE_PALETTES.office;
const atlas = buildIsoAtlas(pal);
const proj = createIsometricProjection({
  tileWidth: MAP.tilewidth,
  tileHeight: MAP.tileheight,
  mapWidthInTiles: MAP.width,
  mapHeightInTiles: MAP.height,
});

/** One atlas cell as its own RGBA buffer (the renderer does this with a
 *  Texture frame; here it is a crop). */
function atlasCell(gid) {
  const i = gid - 1;
  const ox = (i % ISO_ATLAS_COLUMNS) * ISO_ATLAS_CELL;
  const oy = Math.floor(i / ISO_ATLAS_COLUMNS) * ISO_ATLAS_CELL;
  const buf = new Uint8ClampedArray(ISO_ATLAS_CELL * ISO_ATLAS_CELL * 4);
  for (let y = 0; y < ISO_ATLAS_CELL; y++) {
    for (let x = 0; x < ISO_ATLAS_CELL; x++) {
      const s = ((oy + y) * atlas.width + (ox + x)) * 4;
      const d = (y * ISO_ATLAS_CELL + x) * 4;
      buf[d] = atlas.data[s]; buf[d + 1] = atlas.data[s + 1];
      buf[d + 2] = atlas.data[s + 2]; buf[d + 3] = atlas.data[s + 3];
    }
  }
  return buf;
}

const layer = (name) => MAP.layers.find((l) => l.name === name && l.type === 'tilelayer');
const spawn = MAP.layers.find((l) => l.name === 'spawn-points');

const world = proj.mapSizeToWorld(MAP.width, MAP.height);
const canvas = makeCanvas(Math.ceil(world.width), Math.ceil(world.height), [24, 20, 16]);

// 1. floor — unsorted, underneath everything (TiledMapRenderer keeps it in its
//    own container for exactly this reason).
const floor = layer('floor');
for (let ty = 0; ty < MAP.height; ty++) {
  for (let tx = 0; tx < MAP.width; tx++) {
    const gid = floor.data[ty * MAP.width + tx];
    if (!gid) continue;
    const p = proj.tileToWorld(tx, ty);
    blit(canvas, atlasCell(gid), ISO_ATLAS_CELL, ISO_ATLAS_CELL,
      Math.round(p.x), Math.round(p.y + proj.tileHeight - ISO_ATLAS_CELL));
  }
}

// 2. everything that sorts: wall/furniture tiles AND avatars, one list, one
//    comparison — the whole point of the change under review.
const sorted = [];
for (const name of ['walls', 'furniture-below', 'furniture-above']) {
  const l = layer(name);
  if (!l) continue;
  for (let ty = 0; ty < MAP.height; ty++) {
    for (let tx = 0; tx < MAP.width; tx++) {
      const gid = l.data[ty * MAP.width + tx];
      if (!gid) continue;
      const p = proj.tileToWorld(tx, ty);
      sorted.push({
        depth: proj.tileDepth(tx, ty),
        draw: () => blit(canvas, atlasCell(gid), ISO_ATLAS_CELL, ISO_ATLAS_CELL,
          Math.round(p.x), Math.round(p.y + proj.tileHeight - ISO_ATLAS_CELL)),
      });
    }
  }
}

// Avatars: the real cast art, seated (facing 'up' ⇒ the BACK row) at every
// spawn point whose name is a seat, and one standing in the doorway.
const CAST = ['michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley', 'kelly'];
const SIT_OFFSET_UP = 5;   // Character.ts
const CHAR_SCALE = 1.08;   // CharacterSprite.ts

// Two extra standing figures, one on each side of the free-standing counter.
// They are the proof shot: the northern one MUST come out with its legs behind
// the counter block, the southern one MUST come out in front of it. If the
// depth contract between `tileDepth` and `depthAtWorldY` ever drifts, this
// picture shows it immediately.
// "One tile behind/in front" is (tx-1, ty-1) / (tx+1, ty+1) here, not (0,±1):
// those are the steps that move along the SCREEN's vertical, which is what
// stacking is about. Both are picked against the counter block at (3,9).
const WALKERS = [{ name: 'walker-behind', x: 2, y: 8 }, { name: 'walker-front', x: 4, y: 10 }];

let castIdx = 0;
for (const obj of [...spawn.objects, ...WALKERS.map((w) => ({
  name: w.name, x: w.x * MAP.tilewidth, y: w.y * MAP.tileheight,
}))]) {
  const tx = Math.floor(obj.x / MAP.tilewidth);
  const ty = Math.floor(obj.y / MAP.tileheight);
  const seated = obj.name !== 'entrance' && !obj.name.startsWith('walker-');
  const who = CAST[castIdx++ % CAST.length];
  const { front, back } = sceneFrameBufs(who);
  // Seated agents keep their back view (they face their monitor); only the
  // standing walkers are candidates for a turned pose.
  const buf = seated ? back[0]
    : TURNED ? quarterFrameBufs(who, WALKER_POSE)[0]
    : front[0];
  const w = Math.round(SCENE_W * CHAR_SCALE), h = Math.round(SCENE_H * CHAR_SCALE);
  // Nearest-neighbour upscale by CHAR_SCALE, matching the container scale.
  const big = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.min(SCENE_H - 1, Math.floor(y / CHAR_SCALE)) * SCENE_W
        + Math.min(SCENE_W - 1, Math.floor(x / CHAR_SCALE))) * 4;
      const d = (y * w + x) * 4;
      big[d] = buf[s]; big[d + 1] = buf[s + 1]; big[d + 2] = buf[s + 2]; big[d + 3] = buf[s + 3];
    }
  }
  const foot = proj.tileFootToWorld(tx, ty);
  const fy = foot.y + (seated ? SIT_OFFSET_UP : 0);
  sorted.push({
    depth: proj.depthAtWorldY(fy),
    draw: () => blit(canvas, big, w, h, Math.round(foot.x - w / 2), Math.round(fy - h)),
  });
}

sorted.sort((a, b) => a.depth - b.depth);
for (const item of sorted) item.draw();

const outDir = process.argv[2] || path.join(os.tmpdir(), 'munder-difflin-iso-preview');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'iso-scene.png'), encodePng(canvas.width, canvas.height, canvas.data));
const big = scale(canvas, 3);
fs.writeFileSync(path.join(outDir, 'iso-scene@3x.png'), encodePng(big.width, big.height, big.data));
console.log(`wrote ${outDir}/iso-scene.png (${canvas.width}x${canvas.height}) + @3x, palette=${paletteKey}, walkers=${WALKER_POSE}`);
