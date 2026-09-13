// Procedural floor & wall tiles for the office map's tile atlas.
//
// Phase 10 (tvshow-phase10-procedural-floor-walls): the office/brooklyn99/
// siliconvalley/friends themes all painted their floor and walls from the
// SAME handful of 16×16 tiles in a generic recycled pack
// (a5-office-floors-walls.png), which read as flat, repetitive, and lifeless
// once you actually look at the running app — a single near-solid color
// stamped across the whole floor, and a flat-gray fill for every wall/
// partition piece. portraitArt.ts already solved the exact same problem for
// character art by drawing everything from a tiny set of primitives
// (set/rect/shades) into a raw RGBA buffer instead of reusing external art;
// this module applies the same technique to floor/wall tiles.
//
// Unlike portraitArt.ts's fixed PORTRAIT_W×PORTRAIT_H character canvas, a
// tile here is whatever size the atlas says it is (16×16 in every atlas this
// app loads today — see TilesetEntry.tilewidth/tileheight in themeRegistry.ts)
// so every drawing primitive below takes an explicit `tw`/`th` rather than
// reading module-level constants.

export type RGB = [number, number, number];
type Buf = Uint8ClampedArray;

// The four primitives below (clamp/shades/mix/setPx) and the two FLOOR_VARIANT_*
// tables are exported, not module-private, because ./isoTileArt draws the
// ISOMETRIC floor/wall tiles out of exactly this vocabulary, exactly these
// shading constants and exactly these palettes. Two procedural tile modules
// shading through two different `shades()` would drift apart the first time
// anyone tuned one of them; sharing the primitives is what keeps the iso art
// recognisably the same room as the orthogonal art.
export const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Derive a light/base/dark trio from one base color — the same shading
 *  trick portraitArt.ts's shades() uses for skin/hair/clothing, duplicated
 *  here (rather than imported) so tileArt.ts stays a standalone module with
 *  its own tile-sized buffers instead of portraitArt's fixed character
 *  canvas and its module-level CUR_W/CUR_H state. */
export function shades(rgb: RGB, dl = 1.18, dd = 0.72): [RGB, RGB, RGB] {
  return [
    [clamp(rgb[0] * dl), clamp(rgb[1] * dl), clamp(rgb[2] * dl)],
    [rgb[0], rgb[1], rgb[2]],
    [clamp(rgb[0] * dd), clamp(rgb[1] * dd), clamp(rgb[2] * dd)],
  ];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [clamp(a[0] + (b[0] - a[0]) * t), clamp(a[1] + (b[1] - a[1]) * t), clamp(a[2] + (b[2] - a[2]) * t)];
}

export function setPx(buf: Buf, w: number, x: number, y: number, c: RGB, a = 255): void {
  const i = (y * w + x) * 4;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = a;
}

// ─── palettes ────────────────────────────────────────────────────────────────
// One palette per theme name, mirroring portraitArt.ts's RECIPES-by-name
// pattern: a fixed lookup table keyed by a short id, easy to extend with a
// new entry per theme once this technique moves beyond `office` (Phase 10
// scope is office only — see themeRegistry.ts's OFFICE_TILESETS).
export interface TilePalette {
  floor: { base: RGB; mortar: RGB; fleck: RGB };
  wall: { base: RGB; line: RGB };
}

export const TILE_PALETTES: Record<string, TilePalette> = {
  office: {
    // Warm oak-plank floor instead of the source pack's flat sage-green tile.
    floor: { base: [176, 148, 110], mortar: [116, 94, 68], fleck: [203, 178, 136] },
    // Soft warm gray, close in value to the original flat fill so the room
    // doesn't jump in brightness, but now with real shading instead of one
    // solid RGB stamped across every wall/partition/frame piece.
    wall: { base: [206, 200, 188], line: [158, 152, 140] },
  },
  // Precinct bullpen (tvshow-phase12a-brooklyn99-structure): a cooler, more
  // saturated steel/institutional blue-green — "police-station linoleum +
  // institutional paint" — clearly distinct in hue from office's warm oak/
  // gray (office is R>G>B warm; this is B~G>R cool teal) rather than just a
  // brightness shift of the same palette. wall.base sits a full value TIER
  // above floor.base (avg ~183 vs ~105, a ~75% jump — deliberately a wider
  // gap than office's own floor/wall jump of ~145→~198/~37%) because this
  // theme's interior partitions are thin a5 "mullion" pieces (611/643) that
  // only paint a slice of each 16x16 tile; a same-tier floor/wall contrast
  // (the original [90,112,112]/[110,132,132] pairing) rendered those
  // partitions as a barely-there tonal gradient instead of a legible wall —
  // confirmed by rendering and cropping the actual tile output, not guessed.
  brooklyn99: {
    floor: { base: [90, 112, 112], mortar: [50, 66, 66], fleck: [138, 168, 166] },
    wall: { base: [172, 190, 188], line: [78, 98, 96] },
  },
  // Silicon Valley — the hacker-hostel incubator (tvshow-phase12c-
  // siliconvalley-structure): a "scrappy startup" exposed-concrete/whiteboard
  // floor with a burnt-orange accent line, deliberately NEUTRAL/desaturated
  // (R≈G>B by only a few points) rather than office's warm oak (R>G>B, warm)
  // or brooklyn99's cool teal (B~G>R, cool) — a concrete floor reads as
  // neither warm nor cool, clearly distinct in hue from both. wall.base sits
  // ~63% brighter than floor.base (avg ~227 vs ~139 — comfortably past the
  // >50% minimum this project settled on after brooklyn99's first attempt
  // rendered as a barely-visible tonal smear at ~20/channel apart; office's
  // own ~37% jump is the floor of what's acceptable, not a target). The
  // line color is burnt orange (not a shading neutral) so the a5 wall
  // partitions read as "whiteboard wall with a startup accent stripe."
  siliconvalley: {
    floor: { base: [142, 140, 136], mortar: [92, 90, 86], fleck: [172, 170, 166] },
    wall: { base: [230, 228, 222], line: [214, 102, 42] },
  },
  // Friends — the converted-apartment/"Central Perk" feel
  // (tvshow-phase12d-friends-structure): a deep, saturated TERRACOTTA floor
  // (R>>G>B, avg ~111) — deliberately more saturated/red than office's warm
  // tan (R>G>B, avg ~145) rather than a same-family hue nudge — paired with
  // a warm blush-cream wall (a pinkish cream, not office's neutral gray-
  // cream) and a rich burgundy/plum accent LINE (not a shading neutral, the
  // same "line color carries the theme's identity" trick siliconvalley's
  // burnt-orange line uses) for the wall panel band. wall.base sits ~90%
  // brighter than floor.base (avg ~211 vs ~111) — comfortably clear of the
  // >50% minimum this project settled on after brooklyn99's first attempt
  // rendered as a barely-visible tonal smear at ~20/channel apart, and above
  // even siliconvalley's own ~63% jump; confirmed by rendering an actual
  // wall tile and cropping it at zoom, not just computed on paper (see task
  // notes / phase12d-after.png).
  friends: {
    floor: { base: [176, 92, 64], mortar: [108, 52, 38], fleck: [222, 166, 108] },
    wall: { base: [232, 204, 196], line: [122, 46, 56] },
  },
};

// ─── floor ───────────────────────────────────────────────────────────────────
// office.tmj's floor layer is a single 2×2 meta-tile (gids 783/784/799/800,
// laid out top-left/top-right/bottom-left/bottom-right) repeated across the
// entire ~30×18 floor — i.e. exactly four distinct 16×16 stamps, each nearly
// solid color, cover the whole room. `variant` (0-3, matching that same
// top-left/top-right/bottom-left/bottom-right order) gets its own tone
// multiplier + fleck placement so the four stamps read as a natural, subtly
// uneven tile/plank floor instead of four identical color swatches.
export const FLOOR_VARIANT_TONE = [1.0, 0.93, 1.07, 0.98];
export const FLOOR_VARIANT_FLECKS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[3, 4], [11, 9]],
  [[7, 2], [12, 12]],
  [[2, 11], [9, 6]],
  [[5, 8], [13, 3]],
];

/** One procedural floor tile: an opaque tw×th RGBA buffer with a warm plank
 *  base tone (per-`variant` brightness nudge), a 1px mortar/grout line along
 *  the right + bottom edges (so two tiles sharing that edge form one
 *  continuous grid line rather than a doubled or missing one — every
 *  variant draws its own right/bottom edge only), a soft diagonal sheen
 *  catching light near the top-left corner, and a couple of fixed fleck
 *  pixels for grain — the same "shading + a little micro-detail beats a
 *  flat fill" idea portraitArt.ts uses for skin/hair, applied to a floor
 *  cell instead of a character. Deterministic: same (tw, th, variant,
 *  palette) always produces the same pixels, so callers can cache by those. */
export function drawFloorTile(tw: number, th: number, variant: number, pal: TilePalette): Buf {
  const tone = FLOOR_VARIANT_TONE[variant % FLOOR_VARIANT_TONE.length];
  const toned: RGB = [clamp(pal.floor.base[0] * tone), clamp(pal.floor.base[1] * tone), clamp(pal.floor.base[2] * tone)];
  const [hi, base, sh] = shades(toned, 1.16, 0.86);
  const buf = new Uint8ClampedArray(tw * th * 4);

  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) setPx(buf, tw, x, y, base);

  // grout border shared with the next tile to the right / below
  for (let y = 0; y < th; y++) setPx(buf, tw, tw - 1, y, pal.floor.mortar);
  for (let x = 0; x < tw; x++) setPx(buf, tw, x, th - 1, pal.floor.mortar);

  // ambient-occlusion shadow just inside the bottom grout line
  for (let x = 0; x < tw - 1; x++) setPx(buf, tw, x, th - 2, sh);

  // soft diagonal sheen near the top-left, catching light
  const sheenLen = Math.max(0, Math.min(tw, th) - 4);
  for (let i = 0; i < sheenLen; i++) {
    if ((i + variant) % 3 === 0) setPx(buf, tw, 1 + i, 1, hi);
  }

  // a couple of fixed grain flecks (stone/terrazzo speckle, not noise)
  for (const [fx, fy] of FLOOR_VARIANT_FLECKS[variant % FLOOR_VARIANT_FLECKS.length]) {
    if (fx < tw - 1 && fy < th - 1) setPx(buf, tw, fx, fy, pal.floor.fleck);
  }

  return buf;
}

// ─── walls ───────────────────────────────────────────────────────────────────
/** One procedural wall tile that PRESERVES the original tile's alpha
 *  silhouette exactly (`srcAlpha`, read from the base atlas before
 *  compositing — see patchTilesetCanvas below) rather than reshaping it:
 *  office.tmj's "walls" layer gids are a set of distinct pieces — rounded
 *  corners, straight edges, thin double-bar mullions — that already form
 *  the room's glass-partition boundary and the CEO office's divider walls.
 *  Repainting a flat-gray fill with a NEW opaque rectangle per gid would
 *  either poke new solid pixels outside the intended shape (a corner tile
 *  turning into a square block) or leave the shape but not its texture.
 *  Instead: wherever the source pixel was opaque, this paints a light-to-
 *  dark vertical gradient plus a couple of panel-line accents; wherever it
 *  was transparent, it stays transparent. Every corner/edge/bar keeps
 *  functioning exactly as office.tmj placed it — only the fill texture
 *  changes, from one flat RGB to actual shading. */
export function drawWallTile(tw: number, th: number, srcAlpha: Uint8ClampedArray | Uint8Array, pal: TilePalette): Buf {
  const [hi, , sh] = shades(pal.wall.base, 1.14, 0.8);
  const buf = new Uint8ClampedArray(tw * th * 4);
  const panelY = Math.round(th * 0.42);

  for (let y = 0; y < th; y++) {
    const t = th <= 1 ? 0 : y / (th - 1);
    const grad = mix(hi, sh, t);
    for (let x = 0; x < tw; x++) {
      const a = srcAlpha[y * tw + x];
      if (!a) continue;
      let c = grad;
      if (y === panelY || y === panelY + 1) c = pal.wall.line;
      else if (y === 0) c = hi;
      setPx(buf, tw, x, y, c, a);
    }
  }
  return buf;
}

// ─── atlas compositing ───────────────────────────────────────────────────────
/** One group of gids in an atlas to repaint with the same recipe. */
export interface TilesetPatchGroup {
  kind: 'floor' | 'wall';
  /** Global tile ids, in the exact order their `drawFloorTile` `variant` /
   *  positional role should follow (for floor: top-left, top-right,
   *  bottom-left, bottom-right of the repeating meta-tile). */
  gids: number[];
}

/** Just enough of TilesetEntry (themeRegistry.ts) for patching — declared
 *  structurally here instead of importing ThemeConfig's TilesetEntry, so
 *  tileArt.ts (pure drawing + compositing) never depends on the theme
 *  registry module. */
export interface PatchableTileset {
  firstgid?: number;
  columns?: number;
  tilewidth?: number;
  tileheight?: number;
  patches?: TilesetPatchGroup[];
  tilePaletteKey?: string;
}

/** The actual "compose over the base atlas" integration point: given a 2D
 *  context that already has the ORIGINAL tileset image drawn at (0,0) (via
 *  ctx.drawImage), stamp a freshly-drawn procedural tile over each floor/
 *  wall gid's cell described by `entry.patches`, leaving every other cell —
 *  desks, chairs, monitors, every other prop in the atlas — byte-identical
 *  to the source PNG. Call this BEFORE handing the canvas to Pixi's
 *  Texture.from(), once per tileset image load (see OfficeFloor.tsx's
 *  loadTilesetTexture). A no-op when `entry.patches` is absent/empty, so
 *  every atlas without patches (every theme besides `office`, and the other
 *  two office atlases) passes through completely untouched. */
export function patchTilesetCanvas(ctx: CanvasRenderingContext2D, entry: PatchableTileset): void {
  const patches = entry.patches;
  if (!patches || patches.length === 0) return;

  const firstgid = entry.firstgid ?? 1;
  const columns = entry.columns ?? 16;
  const tw = entry.tilewidth ?? 16;
  const th = entry.tileheight ?? 16;
  const pal = TILE_PALETTES[entry.tilePaletteKey ?? 'office'] ?? TILE_PALETTES.office;

  for (const group of patches) {
    group.gids.forEach((gid, idx) => {
      const local = gid - firstgid;
      if (local < 0) return;
      const col = local % columns;
      const row = Math.floor(local / columns);
      const px = col * tw, py = row * th;

      let tile: Buf;
      if (group.kind === 'floor') {
        tile = drawFloorTile(tw, th, idx, pal);
      } else {
        const src = ctx.getImageData(px, py, tw, th);
        const alpha = new Uint8ClampedArray(tw * th);
        for (let i = 0; i < tw * th; i++) alpha[i] = src.data[i * 4 + 3];
        tile = drawWallTile(tw, th, alpha, pal);
      }

      const out = ctx.createImageData(tw, th);
      out.data.set(tile);
      ctx.putImageData(out, px, py);
    });
  }
}
