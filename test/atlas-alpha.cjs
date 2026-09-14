'use strict';

// The shipped tile ART, in node, so a test can ask the same question the
// renderer asks a GPU texture: "does this gid's art touch the bottom edge of
// its cell?" (scene/office/TiledMapRenderer.ts's `bottomEdgeOpaqueMask`, and
// scene/office/tileOcclusion.ts for why that question decides occlusion).
//
// Two sources, because the four shipped themes have two: the office floor's
// atlas is DRAWN by techOfficeArt.ts (loadable straight into node), the other
// three decode PNGs. The PNG reader below is the 8-bit, non-interlaced subset
// those four files actually use — zlib is a node builtin, so this needs no
// dependency and no canvas.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const loadTs = require('./load-ts.cjs');

const ASSETS = path.resolve(__dirname, '..', 'src', 'renderer', 'src', 'assets');
const OPAQUE_ALPHA = 16; // same threshold as the renderer's mask

function decodePng(buf) {
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, palette = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth + ' unsupported');
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (colorType === 6) alpha[i] = out[i * 4 + 3];
    else if (colorType === 4) alpha[i] = out[i * 2 + 1];
    else if (colorType === 3) {
      const ix = out[i];
      alpha[i] = trns && ix < trns.length ? trns[ix] : 255;
    } else alpha[i] = 255;
  }
  return { width: w, height: h, alpha };
}

const cache = new Map();
function pngAlpha(rel) {
  if (!cache.has(rel)) cache.set(rel, decodePng(fs.readFileSync(path.join(ASSETS, rel))));
  return cache.get(rel);
}

function techAlpha() {
  if (!cache.has('procedural:tech-office')) {
    const { buildTechOfficeAtlas } = loadTs('src/renderer/src/scene/office/techOfficeArt.ts');
    const atlas = buildTechOfficeAtlas();
    const alpha = new Uint8Array(atlas.width * atlas.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = atlas.data[i * 4 + 3];
    cache.set('procedural:tech-office', { width: atlas.width, height: atlas.height, alpha });
  }
  return cache.get('procedural:tech-office');
}

// Which atlas each shipped theme's gid ranges come from, in map order. Mirrors
// themeRegistry's OFFICE_TILESETS / BASE_TILESETS.
const THEME_ATLASES = {
  office: [{ firstgid: 1, columns: 16, tw: 16, th: 16, image: techAlpha }],
  brooklyn99: [
    { firstgid: 1, columns: 16, tw: 16, th: 16, image: () => pngAlpha('tilesets/office-tileset.png') },
    { firstgid: 513, columns: 16, tw: 16, th: 16, image: () => pngAlpha('tilesets/a5-office-floors-walls.png') },
    { firstgid: 1025, columns: 16, tw: 16, th: 16, image: () => pngAlpha('tilesets/interiors.png') },
  ],
};
THEME_ATLASES.siliconvalley = THEME_ATLASES.brooklyn99;
THEME_ATLASES.friends = THEME_ATLASES.brooklyn99;

/** `(gid) => boolean`: does that gid's art reach the bottom edge of its cell?
 *  Same answer the renderer's per-atlas mask gives at run time. */
function bottomEdgeProbe(themeName) {
  const sets = THEME_ATLASES[themeName];
  if (!sets) throw new Error('no atlas list for theme ' + themeName);
  return (gid) => {
    const id = gid & 0x1fffffff;
    if (id === 0) return false;
    let pick = null;
    for (const s of sets) if (id >= s.firstgid) pick = s;
    if (!pick) return false;
    const img = pick.image();
    const local = id - pick.firstgid;
    const sx = (local % pick.columns) * pick.tw;
    const y = Math.floor(local / pick.columns) * pick.th + pick.th - 1;
    if (y >= img.height) return false;
    for (let x = sx; x < sx + pick.tw && x < img.width; x++) {
      if (img.alpha[y * img.width + x] >= OPAQUE_ALPHA) return true;
    }
    return false;
  };
}

module.exports = { bottomEdgeProbe, decodePng };
