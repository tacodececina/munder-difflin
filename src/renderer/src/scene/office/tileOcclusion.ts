import { TILE_ID_MASK, findLayer, type TiledMap } from './tiledCollision';

// WHICH MAP TILES HAVE TO OCCLUDE THE CAST.
//
// THE PREMISE THAT EXPIRED. TiledMapRenderer used to say, correctly, that "a
// top-down floor can paint every tile under every avatar and be right: the art
// is flat, nothing is ever in front of a person." That held while the office
// was drawn as a floor plan. The tech-office redesign put objects with VISUAL
// HEIGHT on it — a desk PC is one object drawn across two cells, its screen in
// the upper cell and its keyboard in the lower one — and the upper cell stayed
// walkable, because you are meant to be able to walk BEHIND a monitor. So an
// agent crossing that cell was painted over the screen it was standing behind.
// That is the bug this module exists for.
//
// THE RULE, and why it is about pixels and not about names. There is no tile
// property, layer convention or gid range that says "this art is tall" — the
// four shipped maps carry none, and a user-authored bundle certainly will not.
// What DOES say it is the artwork: a cell whose art runs off the BOTTOM EDGE of
// its 16x16 box is not a thing lying on the floor, it is the top half of
// something standing in the row below. The desk PC's screen tile fills its
// bottom row (the casing continues into the keyboard tile); the flat wall trim
// in the brooklyn99 map ends two pixels down from the top and leaves its bottom
// row empty. One pixel test separates them with no authoring and no list.
//
// THREE CONDITIONS, all required, deliberately conservative — a tile joins the
// sorted layer only when every one holds:
//
//   1. the same layer has a tile directly BELOW it — the object it belongs to
//      actually continues there, so the art is not simply drawn low in its box;
//   2. its art touches the bottom edge — condition 1 alone promotes the bottom
//      row of a whiteboard that happens to have a floor sign under it, and the
//      seat of a chair that happens to have one under it, both of which would
//      then paint over the agent standing or sitting there;
//   3. the cell it is DRAWN on is walkable. Occluding is a statement about
//      someone standing on that cell; where nobody can stand, the tile has no
//      business in the sorted container at all. This is what keeps the cost
//      down (48 sprites on the biggest shipped map, not 235) and what keeps a
//      wall-hung prop from ever sorting against its own live readout.
//
// MEASURED against the four shipped orthogonal maps and their real atlases
// (test/office-tile-occlusion.test.cjs re-checks it on every run):
//
//   office          48 tiles — 15 desk PCs' screen halves + 18 chair backs
//   siliconvalley    9 tiles — the screen half of all 9 desk PCs
//   friends          9 tiles — likewise
//   brooklyn99       0 tiles — its desk PCs are walled off in `collision`,
//                              so that theme renders byte-for-byte as before
//
// The isometric projection does not come through here at all: it already folds
// every wall and furniture tile into the sorted container (Projection.
// sortsTilesWithCharacters), which is the general form of this fix.

export interface StandingTileInputs {
  /** The gid actually DRAWN at (tx,ty) — after any per-theme display swap
   *  (deskVisuals' rear-view monitor), because the drawn art is what occludes. */
  displayedGid(tx: number, ty: number): number;
  /** How many rows DOWN from its authored cell this tile is drawn (0 for all
   *  but the facing-island desks, which display their PC on the far side). */
  displayOffset(tx: number, ty: number): number;
  /** Can an avatar stand on (tx,ty)? The renderer's own walkability grid. */
  isWalkable(tx: number, ty: number): boolean;
  /** Does this gid's art touch the BOTTOM edge of its cell? */
  artRunsOffBottom(gid: number): boolean;
}

/**
 * The tiles of `layerName` that must draw OVER an avatar standing on them,
 * keyed by their authored cell ("x,y") and valued with the tile ROW their
 * painter's depth keys on — the row the object they belong to stands on, i.e.
 * one below where they are drawn.
 *
 * The caller turns that row into a zIndex with `projection.tileDepth(x, row)`
 * plus a one-unit nudge, which is what breaks the tie against an avatar whose
 * feet are on that same row boundary. Everything here is pure arithmetic over
 * the map plus the four callbacks, so it is unit-testable without pixi, a GPU
 * or a bundler — the same rule as ./tiledCollision and ./projection.
 */
export function standingTileDepthRows(
  map: TiledMap,
  layerName: string,
  io: StandingTileInputs,
): Map<string, number> {
  const out = new Map<string, number>();
  const layer = findLayer(map.layers, layerName, 'tilelayer');
  if (!layer?.data) return out;

  const { width, height } = map;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (((layer.data[y * width + x] ?? 0) & TILE_ID_MASK) === 0) continue;
      // 1. the object continues into the row below.
      if (y + 1 >= height) continue;
      if (((layer.data[(y + 1) * width + x] ?? 0) & TILE_ID_MASK) === 0) continue;
      // 3. somebody can stand where this is DRAWN (cheapest of the three that
      //    can fail, and the one that bounds the cost — checked before the
      //    pixel probe on purpose).
      const row = y + io.displayOffset(x, y);
      if (!io.isWalkable(x, row)) continue;
      // 2. the art itself runs off the bottom of its box.
      if (!io.artRunsOffBottom(io.displayedGid(x, y))) continue;
      out.set(`${x},${y}`, row + 1);
    }
  }
  return out;
}
