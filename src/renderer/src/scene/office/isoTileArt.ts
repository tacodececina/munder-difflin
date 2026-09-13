// Procedural ISOMETRIC floor & wall tiles — the 2:1 sibling of ./tileArt.
//
// WHY THIS LIVES NEXT TO tileArt.ts, NOT INSTEAD OF IT
// ----------------------------------------------------
// tileArt.ts explains (in its own header) why this app's floor and walls are
// drawn in code rather than stamped from a recycled tile pack: the pack read
// as flat and lifeless, and portraitArt.ts had already proved that a tiny set
// of primitives (shades/mix/setPx) beats external art for something this
// small. That reasoning does not change when the projection changes — so this
// module does NOT invent a second art style. It imports tileArt's primitives,
// its shading constants (1.16/0.86 for floors, 1.14/0.8 for walls) and its
// TILE_PALETTES verbatim, and re-draws the SAME recipe — base tone per
// variant, grout on the two shared edges, occlusion just inside the shadow
// edge, sparse sheen on the lit edge, a couple of grain flecks — onto a
// diamond instead of a square. An `office` iso floor therefore comes out of
// the same warm oak the orthogonal one does; all four shipped palettes
// (office / brooklyn99 / siliconvalley / friends) work unchanged.
//
// WHY 32x16 (and not "whatever the atlas says", the way tileArt.ts works)
// ----------------------------------------------------------------------
// tileArt.ts takes an explicit tw/th per call because a square tile is
// seamless at ANY size. A diamond is not: the silhouette only tiles without
// gaps or overlaps when its edge is an exact 2:1 staircase, which requires
// half-width and half-height to both be whole pixels. The scene's logical
// cell today is 16px (map.tilewidth — see projection.ts's
// createOrthogonalProjection(tileSize)), so:
//
//   ISO_TILE_W = 2 * 16 = 32   half-width  = 16 px  (integer)
//   ISO_TILE_H =     16 = 16   half-height =  8 px  (integer)
//
// That is the canonical pixel-art isometric tile, and it is the right choice
// here for three independent reasons:
//   1. 2:1 is the only ratio whose edge is a clean repeating 2-px step run.
//      Pixel-art line craft calls a "2,2,2,2" run a clean shallow slope; a
//      true 30-degree diamond (width = 16*sqrt(2) ~= 22.6) would need
//      fractional steps and would alias into jaggies at every tile boundary.
//   2. Both half-steps land on whole pixels, so every tile origin is an
//      integer world position — no sub-pixel seams, the same property the
//      orthogonal projection already relies on.
//   3. The diamond's HEIGHT equals the existing 16px grid module, so the iso
//      art stays on the same pixel grid as the 18x32 character sprites
//      (portraitArt.ts SCENE_W/SCENE_H) and the 16x16 prop atlas. Mixing
//      pixel grids inside one scene is the fastest way to make a game look
//      unfinished, and 32x16 avoids it without rescaling anything.
//
// Wall height is the other projection constant. In a 3/4 / isometric view a
// wall's visible face height must be a scene-wide constant or the room stops
// reading as one room, so ISO_WALL_FACE_H is 16 — one full grid module, which
// makes the wall sprite a 32x32 cube (diamond cap + one module of vertical
// face). Taller walls are stacked cubes, not a different tile.
//
// NOW WIRED INTO THE RENDERER, via `buildIsoAtlas` at the bottom of this file:
// the `isometric` prototype theme (themeRegistry.ts) declares a tileset with no
// `url` at all, and OfficeFloor's loadTilesetTexture builds its atlas canvas
// from these buffers instead of decoding a PNG. Everything above that function
// is unchanged and still pure — no DOM, no pixi — so `tools/iso-tile-preview.cjs`
// and test/iso-tile-art.test.cjs keep working exactly as before.

import {
  FLOOR_VARIANT_FLECKS,
  FLOOR_VARIANT_TONE,
  clamp,
  mix,
  setPx,
  shades,
  type RGB,
  type TilePalette,
} from './tileArt';

type Buf = Uint8ClampedArray;

/** Width of one iso diamond, in pixels. See the header for why it is 2x the
 *  16px logical cell rather than 16*sqrt(2). */
export const ISO_TILE_W = 32;
/** Height of one iso diamond, in pixels — exactly the logical cell size, which
 *  is what makes the projection 2:1. */
export const ISO_TILE_H = 16;
/** Visible vertical face height of one wall block. One grid module, so a wall
 *  block is a 32x32 cube; a taller wall is stacked blocks. */
export const ISO_WALL_FACE_H = 16;

const HALF_W = ISO_TILE_W / 2; // 16
const HALF_H = ISO_TILE_H / 2; // 8

/** Total sprite height of a wall block: the diamond cap plus its face. */
export function isoWallTileHeight(faceHeight: number = ISO_WALL_FACE_H): number {
  return ISO_TILE_H + faceHeight;
}

/**
 * The horizontal span `[leftX, rightX]` (inclusive) the diamond occupies on
 * row `y`, or an empty span (`left > right`) off the tile.
 *
 * THIS IS THE WHOLE SEAMLESSNESS CONTRACT, so it is worth stating exactly.
 * Row widths run 2, 6, 10, 14, 18, 22, 26, 30 down to the waist and mirror
 * back up — i.e. each row steps 2px outward on each side, the clean shallow
 * slope, and the widths sum to 256 = ISO_TILE_W * ISO_TILE_H / 2, precisely
 * half the bounding box. Half the box is exactly what one cell of a 2:1 grid
 * may own, so diamonds placed on `isoCellOrigin` partition the plane with no
 * gap and no overlap. (Columns 0 and 31 stay empty inside any single tile —
 * the neighbouring diamond's tip lands there. That is the proof, not a bug:
 * a "fixed" 4..32 diamond would sum to 288 and overlap its neighbours.)
 */
export function isoRowSpan(y: number): readonly [number, number] {
  if (y < 0 || y >= ISO_TILE_H) return [1, 0];
  const d = y < HALF_H ? y : ISO_TILE_H - 1 - y;
  return [HALF_W - 1 - 2 * d, HALF_W + 2 * d];
}

/**
 * Top-left corner of cell (tx,ty)'s 32x16 bounding box, in the iso world this
 * art is drawn for. Exported because the seam test and the preview tool both
 * need the placement rule the silhouette was designed against — it is NOT a
 * Projection and nothing in the scene uses it. projection.ts's
 * `createIsometricProjection` reproduces exactly this arithmetic (plus a
 * whole-map origin shift, so the west corner does not sit at negative x).
 */
export function isoCellOrigin(tx: number, ty: number): { x: number; y: number } {
  return { x: (tx - ty) * HALF_W, y: (tx + ty) * HALF_H };
}

/** Per-column lowest row of the diamond — the ridge the vertical wall faces
 *  hang from. -1 for the two columns the diamond never touches. */
function diamondBottomY(): number[] {
  const out = new Array<number>(ISO_TILE_W).fill(-1);
  for (let y = 0; y < ISO_TILE_H; y++) {
    const [l, r] = isoRowSpan(y);
    for (let x = l; x <= r; x++) if (y > out[x]) out[x] = y;
  }
  return out;
}
const BOTTOM_Y = diamondBottomY();

/** setPx with bounds checking — portraitArt.ts's `set()` does the same thing
 *  for the same reason: iso drawing walks edges, and an edge run that steps
 *  one pixel past the tip must be dropped, not wrapped onto the next row. */
function put(buf: Buf, w: number, h: number, x: number, y: number, c: RGB, a = 255): void {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  setPx(buf, w, x, y, c, a);
}

// ─── floor ───────────────────────────────────────────────────────────────────
// Same four variants as drawFloorTile, same FLOOR_VARIANT_TONE table, same
// FLOOR_VARIANT_FLECKS table. The orthogonal tile puts its grout on the RIGHT
// and BOTTOM edges so two neighbours share one line rather than doubling it;
// in this projection +tx runs down-right and +ty runs down-left, so the
// right/bottom edges ARE the two lower edges of the diamond (SE and SW). The
// recipe is transposed, not redesigned.
//
// Light direction is tileArt's: top-left. The orthogonal tile catches a sheen
// near its top-left corner and drops an occlusion line above its bottom grout;
// here the sheen runs along the upper-left (NW) edge and the occlusion runs
// just inside the lower-right (SE) edge, which is the same light doing the
// same thing to a rotated cell.

/** One procedural isometric floor tile: an ISO_TILE_W x ISO_TILE_H RGBA buffer,
 *  opaque inside the diamond and fully transparent outside it.
 *
 *  Deterministic: same (variant, palette) always produces the same pixels, so
 *  callers can cache by those — exactly like drawFloorTile. */
export function drawIsoFloorTile(variant: number, pal: TilePalette): Buf {
  const w = ISO_TILE_W, h = ISO_TILE_H;
  const tone = FLOOR_VARIANT_TONE[variant % FLOOR_VARIANT_TONE.length];
  const toned: RGB = [
    clamp(pal.floor.base[0] * tone),
    clamp(pal.floor.base[1] * tone),
    clamp(pal.floor.base[2] * tone),
  ];
  const [hi, base, sh] = shades(toned, 1.16, 0.86);
  const buf = new Uint8ClampedArray(w * h * 4);

  // 1. flat fill of the diamond
  for (let y = 0; y < h; y++) {
    const [l, r] = isoRowSpan(y);
    for (let x = l; x <= r; x++) put(buf, w, h, x, y, base);
  }

  // 2. grout on the two SHARED lower edges (SE + SW), drawn as full 2px step
  //    runs: at 2:1 the boundary moves two columns per row, so a 1px-per-row
  //    line would be a dotted diagonal of orphan pixels rather than a line.
  for (let y = HALF_H; y < h; y++) {
    const [l, r] = isoRowSpan(y);
    put(buf, w, h, l, y, pal.floor.mortar);
    put(buf, w, h, l + 1, y, pal.floor.mortar);
    put(buf, w, h, r - 1, y, pal.floor.mortar);
    put(buf, w, h, r, y, pal.floor.mortar);
  }

  // 3. ambient occlusion just inside the SE (shadow-side) grout only. The
  //    orthogonal tile shades one row above its bottom grout; doing both lower
  //    edges here would spend a quarter of a 16px-tall tile on trim.
  for (let y = HALF_H; y < h; y++) {
    const [l, r] = isoRowSpan(y);
    if (r - 3 >= l) { put(buf, w, h, r - 2, y, sh); put(buf, w, h, r - 3, y, sh); }
  }

  // 4. sparse sheen along the lit NW edge — the `(i + variant) % 3` cadence of
  //    drawFloorTile's diagonal sheen, so the four variants catch light on
  //    different steps and the field does not band.
  for (let y = 0; y < HALF_H; y++) {
    if ((y + variant) % 3 !== 0) continue;
    const [l, r] = isoRowSpan(y);
    if (l + 3 <= r) { put(buf, w, h, l + 2, y, hi); put(buf, w, h, l + 3, y, hi); }
  }

  // 5. the same two grain flecks, projected. A fleck authored at cell coord
  //    (fx,fy) in the 16x16 cell lands at (HALF_W + fx - fy, (fx + fy) / 2) —
  //    the 2:1 transform — so the speckle keeps the placement it was tuned at.
  for (const [fx, fy] of FLOOR_VARIANT_FLECKS[variant % FLOOR_VARIANT_FLECKS.length]) {
    const px = HALF_W + fx - fy;
    const py = Math.floor((fx + fy) / 2);
    const [l, r] = isoRowSpan(py);
    if (px >= l && px <= r) put(buf, w, h, px, py, pal.floor.fleck);
  }

  return buf;
}

// ─── walls ───────────────────────────────────────────────────────────────────
/** Which vertical faces of the block are visible. `both` is a free-standing
 *  cube; `left`/`right` are the single-face pieces a wall run needs at the
 *  points where the other face is buried in the next block. */
export type IsoWallFaces = 'both' | 'left' | 'right';

/**
 * Brightness factors for the three planes of a wall block, as multiples of
 * pal.wall.base.
 *
 * drawWallTile shades ONE plane, sweeping a gradient from 1.14 at the top down
 * to 0.8 at the bottom — that whole ramp describes a single flat partition. An
 * isometric block shows THREE planes at once, and reusing that 1.14/1.0/0.8
 * spread renders them as one near-white mass: office's wall.base is [206,200,
 * 188], so the cap and the lit face would land 29 levels apart and the block
 * stops reading as a solid. Verified by rendering, not by arithmetic — see
 * tools/iso-tile-preview.cjs.
 *
 * So the ramp widens to roughly the classic isometric 100 / 80 / 58
 * relationship. `cap` deliberately keeps drawWallTile's exact 1.14, so the
 * top-lit plane — the one a viewer reads the wall's colour from — is the same
 * tone the orthogonal wall already starts from; only the two receding planes
 * step down further. Light is top-left, as everywhere else in tileArt: the
 * left (SW) face catches it, the right (SE) face turns away.
 */
export const ISO_WALL_PLANE = { cap: 1.14, left: 0.9, right: 0.66 } as const;

export interface IsoWallOptions {
  /** Visible height of the vertical faces. Defaults to ISO_WALL_FACE_H. */
  faceHeight?: number;
  /** Defaults to 'both'. */
  faces?: IsoWallFaces;
  /** Draw the pal.wall.line accent band across the face. Defaults to true.
   *  A stack of blocks repeats the band once per block, which turns a wall
   *  into corrugated siding — loudly so for the palettes whose line colour is
   *  an accent rather than a neutral (siliconvalley's burnt orange, friends'
   *  burgundy). Callers building a stack draw the band on the top block only. */
  band?: boolean;
}

/**
 * One procedural isometric wall block: an ISO_TILE_W x (ISO_TILE_H +
 * faceHeight) RGBA buffer holding a diamond cap plus its vertical face(s),
 * transparent everywhere else.
 *
 * Where drawWallTile has to REPAINT an existing alpha silhouette (office.tmj's
 * wall gids are pre-authored corner/edge/mullion pieces and reshaping them
 * would break the room), an iso block has no legacy silhouette to preserve —
 * the geometry IS the projection. So this one generates its own shape, and
 * paints it from the same pal.wall.base and the same pal.wall.line accent band
 * at 42% down the face.
 *
 * Its three planes take ISO_WALL_PLANE (see there for why the ramp is wider
 * than drawWallTile's), plus a lit chamfer where each face meets the cap and a
 * one-row contact shadow at the bottom so the block sits on the floor instead
 * of floating.
 *
 * Stacking: a taller wall is N of these drawn bottom-up at successive
 * -faceHeight offsets. Each block's face covers the cap of the block beneath
 * it exactly, so the run reads as one continuous wall.
 *
 * Deterministic: same (palette, options) always produces the same pixels.
 */
export function drawIsoWallTile(pal: TilePalette, opts: IsoWallOptions = {}): Buf {
  const faceH = Math.max(1, Math.round(opts.faceHeight ?? ISO_WALL_FACE_H));
  const faces = opts.faces ?? 'both';
  const band = opts.band ?? true;
  const w = ISO_TILE_W, h = isoWallTileHeight(faceH);
  const plane = (f: number): RGB => [
    clamp(pal.wall.base[0] * f), clamp(pal.wall.base[1] * f), clamp(pal.wall.base[2] * f),
  ];
  const hi = plane(ISO_WALL_PLANE.cap);
  const base = plane(ISO_WALL_PLANE.left);
  const sh = plane(ISO_WALL_PLANE.right);
  const buf = new Uint8ClampedArray(w * h * 4);

  const capEdge: RGB = mix(hi, [255, 255, 255], 0.22);
  const contact: RGB = mix(sh, [0, 0, 0], 0.35);
  // Same 42%-down panel band drawWallTile draws, measured on the face rather
  // than on the whole tile.
  const bandRow = Math.round(faceH * 0.42);

  // 1. the cap
  for (let y = 0; y < ISO_TILE_H; y++) {
    const [l, r] = isoRowSpan(y);
    for (let x = l; x <= r; x++) put(buf, w, h, x, y, hi);
  }
  // 1b. a lit 2px-run edge along the NW rim of the cap (light from top-left)
  for (let y = 0; y < HALF_H; y++) {
    const [l, r] = isoRowSpan(y);
    put(buf, w, h, l, y, capEdge);
    if (l + 1 <= r) put(buf, w, h, l + 1, y, capEdge);
  }

  // 2. the vertical faces, hanging from the diamond's lower silhouette. Each
  //    column drops from its own ridge row, which is what makes the band and
  //    the contact shadow follow the iso slope instead of cutting across it.
  for (let x = 0; x < w; x++) {
    const ridge = BOTTOM_Y[x];
    if (ridge < 0) continue;
    const isLeft = x < HALF_W;
    if (isLeft && faces === 'right') continue;
    if (!isLeft && faces === 'left') continue;
    const faceColor = isLeft ? base : sh;
    const chamfer = mix(faceColor, hi, 0.45);
    for (let i = 0; i < faceH; i++) {
      const y = ridge + 1 + i;
      let c = faceColor;
      if (i === 0) c = chamfer;
      else if (band && (i === bandRow || i === bandRow + 1)) c = pal.wall.line;
      if (i === faceH - 1) c = contact;
      put(buf, w, h, x, y, c);
    }
  }

  return buf;
}

// ─── atlas ───────────────────────────────────────────────────────────────────
// A Tiled tileset is a grid of equal-sized cells, but the pieces above are not
// equal-sized: a floor diamond is 32x16 and a wall cube is 32x32. So the atlas
// uses a SQUARE 32x32 cell and BOTTOM-ALIGNS every piece inside it — the same
// convention Tiled itself uses for tiles taller than the map's tileheight, and
// the reason the ISOMETRIC projection's `tileArtOffsetY` returns
// `tileHeight - textureHeight` (the orthogonal one returns 0 for every texture
// height, keeping its historical cell-origin placement — see projection.ts).
//
// Bottom-aligning means the cell's bottom edge is the diamond's bottom corner
// row, so a wall's cap floats exactly ISO_WALL_FACE_H above the floor it stands
// on, with no per-gid offset table to keep in sync.

/** One slot in the generated atlas, in gid order (firstgid + index). */
export type IsoAtlasSlot =
  | 'floor0' | 'floor1' | 'floor2' | 'floor3'
  | 'wall' | 'wallLeft' | 'wallRight' | 'desk';

export const ISO_ATLAS_SLOTS: readonly IsoAtlasSlot[] = [
  'floor0', 'floor1', 'floor2', 'floor3',
  'wall', 'wallLeft', 'wallRight', 'desk',
] as const;

/** Square cell edge — max(ISO_TILE_W/2 pieces, wall cube height). */
export const ISO_ATLAS_CELL = 32;
export const ISO_ATLAS_COLUMNS = 4;

/** How tall a desk block stands. Two thirds of a wall block: high enough to
 *  hide a seated avatar's legs and read as furniture, low enough that it never
 *  swallows the head of someone standing behind it. */
export const ISO_DESK_FACE_H = 10;

/** The gid offset of a slot within the generated tileset (add `firstgid`). */
export function isoAtlasIndex(slot: IsoAtlasSlot): number {
  return ISO_ATLAS_SLOTS.indexOf(slot);
}

/** The RGBA buffer + pixel size of one slot, before it is placed in the atlas. */
function isoAtlasPiece(slot: IsoAtlasSlot, pal: TilePalette): { buf: Buf; w: number; h: number } {
  switch (slot) {
    case 'floor0': case 'floor1': case 'floor2': case 'floor3': {
      const variant = Number(slot.slice(-1));
      return { buf: drawIsoFloorTile(variant, pal), w: ISO_TILE_W, h: ISO_TILE_H };
    }
    case 'wall':
      return { buf: drawIsoWallTile(pal), w: ISO_TILE_W, h: isoWallTileHeight() };
    case 'wallLeft':
      return { buf: drawIsoWallTile(pal, { faces: 'left' }), w: ISO_TILE_W, h: isoWallTileHeight() };
    case 'wallRight':
      return { buf: drawIsoWallTile(pal, { faces: 'right' }), w: ISO_TILE_W, h: isoWallTileHeight() };
    case 'desk':
      // A desk is a wall block with two changes, both to stop it reading as a
      // piece of wall that fell over:
      //   - no accent band. The band is a WALL's panel line; repeated on a
      //     knee-high block it reads as a stripe painted round the desk.
      //   - the theme's FLOOR colours, not its wall colours. Every palette in
      //     TILE_PALETTES pairs a saturated floor with a near-white wall, so a
      //     desk drawn from wall.base comes out the same value as the room's
      //     partitions. Taking floor.fleck (the floor's own highlight — always
      //     a lighter, same-family tone) makes the desk read as furniture
      //     standing ON that floor, in whatever the active theme's wood/
      //     terracotta/concrete family is, with no per-theme table to maintain.
      return {
        buf: drawIsoWallTile(
          { ...pal, wall: { base: pal.floor.fleck, line: pal.floor.mortar } },
          { faceHeight: ISO_DESK_FACE_H, band: false },
        ),
        w: ISO_TILE_W,
        h: isoWallTileHeight(ISO_DESK_FACE_H),
      };
  }
}

export interface IsoAtlas {
  /** RGBA pixels, `width * height * 4`. */
  data: Buf;
  width: number;
  height: number;
  columns: number;
  /** Both tilewidth and tileheight — the cells are square. */
  cell: number;
  tilecount: number;
}

/**
 * The whole isometric tileset as one RGBA buffer, ready to be handed to a 2D
 * canvas via putImageData (OfficeFloor.loadTilesetTexture) or written to a PNG
 * by a preview tool. Pure and deterministic: same palette in, same pixels out.
 */
export function buildIsoAtlas(pal: TilePalette): IsoAtlas {
  const cell = ISO_ATLAS_CELL;
  const columns = ISO_ATLAS_COLUMNS;
  const rows = Math.ceil(ISO_ATLAS_SLOTS.length / columns);
  const width = columns * cell;
  const height = rows * cell;
  const data = new Uint8ClampedArray(width * height * 4);

  ISO_ATLAS_SLOTS.forEach((slot, i) => {
    const { buf, w, h } = isoAtlasPiece(slot, pal);
    const ox = (i % columns) * cell;
    // Bottom-aligned inside the square cell — see the header note above.
    const oy = (Math.floor(i / columns) + 1) * cell - h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = (y * w + x) * 4;
        if (buf[src + 3] === 0) continue;
        const dst = ((oy + y) * width + (ox + x)) * 4;
        data[dst] = buf[src];
        data[dst + 1] = buf[src + 1];
        data[dst + 2] = buf[src + 2];
        data[dst + 3] = buf[src + 3];
      }
    }
  });

  return { data, width, height, columns, cell, tilecount: ISO_ATLAS_SLOTS.length };
}
