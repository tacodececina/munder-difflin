// The ONE place that knows how a tile coordinate becomes a world pixel.
//
// WHY THIS EXISTS: until now that conversion was `tx * tileSize` written out by
// hand in a dozen places across six files (TiledMapRenderer, Character,
// OfficeFloor, DeskScreen, DeskShelf, WorldClock). Every one of them silently
// assumed a top-down, axis-aligned grid, so a theme could swap art, anchors and
// cast but never the PROJECTION — the geometry was not a thing the code had a
// name for. This module gives it a name and exactly one orthogonal
// implementation whose arithmetic is byte-for-byte what those call sites did.
//
// Pixi-free on purpose, exactly like ./tiledCollision — the rules are pure
// arithmetic, so they can be unit-tested against the old inline formulas
// (test/office-projection.test.cjs) without a GPU or a bundler.
//
// SECOND IMPLEMENTATION (isometric prototype, this change): the promise above
// — "adding `createIsometricProjection` later must not require touching a
// single call site" — held for placement, and did NOT hold for two things the
// original interface had no name for:
//
//   1. DEPTH OF A TILE. `rowDepth(row)` takes a row and nothing else, which is
//      only a painter's key when screen depth depends on Y alone. On a diamond
//      grid depth runs along the tx+ty diagonal, so both coordinates matter —
//      hence `tileDepth(tx, ty)`, and hence `sortsTilesWithCharacters`, which
//      tells the renderer whether the map's own wall/furniture sprites have to
//      join the sorted character layer instead of sitting under it.
//   2. WHICH WAY A SPRITE FACES. `Math.abs(dx) > Math.abs(dy)` was written into
//      Character.updateWalk and a chain of `isWalkable` probes into
//      OfficeFloor.facingForSeat. Both are statements about the projection —
//      under 2:1 iso, EVERY cardinal tile step satisfies |dx| > |dy| — so they
//      move here as `facingForWorldStep` / `facingForTileStep`.
//
// Everything added is a pure function of the same arithmetic, and the
// orthogonal implementation reproduces the old formulas exactly (proven in
// test/office-projection.test.cjs).

export interface Point {
  x: number;
  y: number;
}

export interface WorldSize {
  width: number;
  height: number;
}

export type ProjectionKind = 'orthogonal' | 'isometric';

/** Which of the character sheet's four facings a movement reads as. Same four
 *  names as CharacterSprite's `Direction` and themeRegistry's `Facing`;
 *  redeclared here so this module keeps importing nothing. */
export type Facing = 'up' | 'down' | 'left' | 'right';

/**
 * How the office floor maps tile coordinates onto world pixels.
 *
 * "World" here is the coordinate space INSIDE the camera's container — the same
 * space every sprite, prop and avatar in the scene is positioned in. The camera
 * (Camera.ts) turns world into screen; it never needs to know the projection,
 * it only needs the map's world size.
 *
 * Depth (`rowDepth` / `depthAtWorldY`) lives here too, because painter's order
 * on a tiled floor is a geometric property: "further up the map draws behind"
 * is only true for a particular projection. Today both are the plain world-Y
 * the scene already sorted by.
 */
export interface Projection {
  readonly kind: ProjectionKind;
  /** Width of one tile cell in world pixels. */
  readonly tileWidth: number;
  /** Height of one tile cell in world pixels. */
  readonly tileHeight: number;

  /** World position of tile (tx,ty)'s ORIGIN corner — where its art is pinned.
   *  This is the anchor for every prop that sits "on" a tile. */
  tileToWorld(tx: number, ty: number): Point;

  /** World position of the CENTRE of tile (tx,ty)'s cell — the pivot a sprite
   *  rotates/mirrors around (the flipped-tile path in TiledMapRenderer). */
  tileCenterToWorld(tx: number, ty: number): Point;

  /** World position an avatar's FEET occupy while standing on tile (tx,ty):
   *  horizontally centred on the cell, vertically on its front edge. Every
   *  character position in the scene is one of these. */
  tileFootToWorld(tx: number, ty: number): Point;

  /** The tile containing world point (wx,wy). */
  worldToTile(wx: number, wy: number): Point;

  /** The tile an avatar whose FEET are at (wx,wy) is standing on — the inverse
   *  of `tileFootToWorld`. Not the same as `worldToTile`: a foot anchor sits
   *  exactly ON the boundary with the next cell, so it needs a hair of
   *  backtracking to land on the tile the avatar is actually occupying. */
  footToTile(wx: number, wy: number): Point;

  /** World size of a map that is `widthInTiles` x `heightInTiles` tiles. */
  mapSizeToWorld(widthInTiles: number, heightInTiles: number): WorldSize;

  /** Painter's-order key for a prop anchored at tile row `row`. Callers add a
   *  small integer nudge to break ties within a row (±1, ±2), exactly as the
   *  hand-written `(y + 1) * tileSize - 2` forms did.
   *
   *  A ROW IS NOT ENOUGH INFORMATION under a projection whose depth runs along
   *  a diagonal — see `tileDepth`. Every caller that still uses this knows only
   *  a row (wall-hung props: the calendar, the task boards, the clocks), and
   *  every one of them is switched off for the isometric theme (see
   *  ThemeConfig.features). New code with both coordinates in hand should call
   *  `tileDepth`. */
  rowDepth(row: number): number;

  /** Painter's-order key for a prop that knows the FULL tile it sits on. This
   *  is the one depth function that is correct under every projection, and it
   *  is what the map renderer sorts wall/furniture tiles by. */
  tileDepth(tx: number, ty: number): number;

  /** Painter's-order key for something at an arbitrary world Y (a walking
   *  avatar, a carried note) rather than parked on a tile row. Contract shared
   *  with `tileDepth`: an avatar standing on tile (tx,ty) must compare equal to
   *  `tileDepth(tx, ty)` (orthogonal splits the difference the way it always
   *  did — see its note below). */
  depthAtWorldY(worldY: number): number;

  /** True when the map's own wall/furniture tile sprites cannot simply be
   *  painted UNDER the cast, because a tall tile in front of an avatar has to
   *  occlude it. The renderer folds those layers into the sorted character
   *  container when this is set. False for orthogonal: the scene has always
   *  drawn flat top-down art strictly beneath everyone. */
  readonly sortsTilesWithCharacters: boolean;

  /** How far DOWN from `tileToWorld(tx,ty).y` a tile sprite whose texture is
   *  `textureHeight` px tall must be drawn.
   *
   *  This is a PROJECTION decision, not a universal rule, which is exactly why
   *  it is asked here instead of being spelled out in the renderer. Tiled's own
   *  convention — bottom-align art taller than the cell — is what the isometric
   *  atlas needs (a 32x32 wall cube and a 32x16 floor diamond share one square
   *  atlas cell and differ only in how far they rise above the cell they stand
   *  on). The orthogonal projection deliberately does NOT adopt it: this app has
   *  always pinned orthogonal tile art to the cell origin regardless of the
   *  atlas' cell height (`sprite.y = y * tileSize`, unconditionally), and a
   *  user-authored theme bundle with a tall atlas must keep rendering exactly
   *  where it rendered before the projection was extracted. Pinned in
   *  test/office-projection.test.cjs. */
  tileArtOffsetY(textureHeight: number): number;

  /** Which sprite facing a step of (dx,dy) WORLD pixels reads as. Used once per
   *  frame per walking avatar (Character.updateWalk). */
  facingForWorldStep(dx: number, dy: number): Facing;

  /** Which sprite facing a step of (dtx,dty) TILES reads as — i.e. "the desk is
   *  one tile north of the chair, so which way does the sitter face?"
   *  (OfficeFloor.facingForSeat / faceFurniture). */
  facingForTileStep(dtx: number, dty: number): Facing;
}

/**
 * The projection the app has always used: a top-down square grid, one tile =
 * `tileSize` world pixels on both axes, tile (0,0) at world (0,0).
 *
 * Note both axes take the SAME `tileSize`. That is not an oversight — the scene
 * has always derived it from `map.tilewidth` alone and ignored `map.tileheight`
 * — and preserving it is the whole point of this extraction. A projection that
 * wants non-square cells is a different factory.
 */
export function createOrthogonalProjection(tileSize: number): Projection {
  return {
    kind: 'orthogonal',
    tileWidth: tileSize,
    tileHeight: tileSize,

    tileToWorld(tx: number, ty: number): Point {
      return { x: tx * tileSize, y: ty * tileSize };
    },

    tileCenterToWorld(tx: number, ty: number): Point {
      return { x: tx * tileSize + tileSize / 2, y: ty * tileSize + tileSize / 2 };
    },

    tileFootToWorld(tx: number, ty: number): Point {
      return { x: tx * tileSize + tileSize / 2, y: ty * tileSize + tileSize };
    },

    worldToTile(wx: number, wy: number): Point {
      return { x: Math.floor(wx / tileSize), y: Math.floor(wy / tileSize) };
    },

    footToTile(wx: number, wy: number): Point {
      // The 1px backtrack is the historical one from Character.getTilePosition:
      // feet at y = (ty + 1) * tileSize would otherwise floor into row ty + 1.
      return { x: Math.floor(wx / tileSize), y: Math.floor((wy - 1) / tileSize) };
    },

    mapSizeToWorld(widthInTiles: number, heightInTiles: number): WorldSize {
      return { width: widthInTiles * tileSize, height: heightInTiles * tileSize };
    },

    rowDepth(row: number): number {
      return row * tileSize;
    },

    // A prop parked on tile row `ty` has always sorted at `ty * tileSize`
    // regardless of its column, so this is `rowDepth(ty)` and nothing else.
    // Note it is deliberately NOT equal to an avatar's depth on the same tile:
    // the avatar's foot anchor is the row's FAR edge ((ty+1) * tileSize), which
    // is exactly how a prop ends up behind the person standing at it. That
    // invariant is asserted in test/office-projection.test.cjs.
    tileDepth(_tx: number, ty: number): number {
      return ty * tileSize;
    },

    depthAtWorldY(worldY: number): number {
      return worldY;
    },

    sortsTilesWithCharacters: false,

    // Zero, always — the pre-extraction renderer wrote `sprite.y = y * tileSize`
    // with no reference to the texture's height, so ANY orthogonal map (the four
    // shipped ones, where the term would be zero anyway, and a user bundle with
    // a taller atlas, where it would not) keeps its exact historical placement.
    tileArtOffsetY(_textureHeight: number): number {
      return 0;
    },

    facingForWorldStep(dx: number, dy: number): Facing {
      // Character.updateWalk's own line, moved verbatim.
      return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    },

    facingForTileStep(dtx: number, dty: number): Facing {
      // Same rule — on a square grid a tile step and a world step differ only
      // by a positive scale factor, which |dx| vs |dy| is blind to.
      return Math.abs(dtx) > Math.abs(dty) ? (dtx > 0 ? 'right' : 'left') : (dty > 0 ? 'down' : 'up');
    },
  };
}

// ─── isometric ───────────────────────────────────────────────────────────────

export interface IsometricProjectionOptions {
  /** Width of one diamond in world pixels (32 — see isoTileArt.ts's ISO_TILE_W
   *  for why the ratio is exactly 2:1 and not 16*sqrt(2)). */
  tileWidth: number;
  /** Height of one diamond (16). */
  tileHeight: number;
  /** The map's size in tiles. Needed because the grid genuinely extends to
   *  NEGATIVE x around tile (0, height-1) — the west corner — and Camera.ts
   *  clamps to a world box that starts at (0,0). The projection absorbs that
   *  by shifting every tile east by half the map's depth, so no consumer ever
   *  sees a negative coordinate and the camera keeps working unchanged. */
  mapWidthInTiles: number;
  mapHeightInTiles: number;
  /** World pixels of headroom reserved above tile row 0 for art that is taller
   *  than its cell (a wall block is a 32x32 cube hanging off a 32x16 diamond).
   *  Defaults to one wall block's overhang, `tileHeight`. */
  topPadding?: number;
}

/**
 * A 2:1 isometric grid: +tx runs down-RIGHT on screen, +ty runs down-LEFT, and
 * the two together tile the plane with diamonds.
 *
 * The arithmetic is deliberately the same one isoTileArt.ts's `isoCellOrigin`
 * was designed against (that module's diamond silhouette only tiles seamlessly
 * against THIS placement rule), plus the world-origin shift described in
 * `IsometricProjectionOptions.mapWidthInTiles`.
 *
 * DEPTH. On a diamond grid "further up the screen draws behind" is false; what
 * is true is "further along tx+ty draws in front". So the depth unit here is
 * one diagonal step = `tileHeight`, and both `tileDepth` and `depthAtWorldY`
 * are expressed in it, agreeing exactly for an avatar standing on a tile. That
 * agreement is what makes it legal to put wall sprites and avatars in the same
 * sorted container, which is what `sortsTilesWithCharacters` asks for.
 *
 * FEET. An avatar stands in the MIDDLE of its diamond, not on its front edge:
 * a diamond has no front edge, it has a front corner, and anchoring there would
 * push every avatar a half-cell off the tile it is logically on. So
 * `tileFootToWorld` is `tileCenterToWorld`, and `footToTile` is `worldToTile`
 * with no backtrack — the orthogonal projection's 1px nudge exists purely to
 * undo its own bottom-edge anchoring.
 */
export function createIsometricProjection(opts: IsometricProjectionOptions): Projection {
  const tw = opts.tileWidth;
  const th = opts.tileHeight;
  const halfW = tw / 2;
  const halfH = th / 2;
  // The west corner of the grid is tile (0, mapHeight-1); shift east by its
  // depth so tile→world never goes negative.
  const originX = Math.max(0, opts.mapHeightInTiles - 1) * halfW;
  const originY = opts.topPadding ?? th;

  /** Continuous tile coordinates of a world point — the shared inverse. */
  const toTileSpace = (wx: number, wy: number): Point => {
    const a = (wx - originX - halfW) / halfW; // = tx - ty
    const b = (wy - originY - halfH) / halfH; // = tx + ty
    return { x: (a + b) / 2, y: (b - a) / 2 };
  };

  /** Nearest lattice cell. Diamond cells ARE the unit squares of tile space, so
   *  "which diamond contains this point" is a round, not a floor. */
  const nearestTile = (wx: number, wy: number): Point => {
    const t = toTileSpace(wx, wy);
    return { x: Math.floor(t.x + 0.5), y: Math.floor(t.y + 0.5) };
  };

  const facingForTileStep = (dtx: number, dty: number): Facing => {
    // The four cardinal tile steps land on the four screen diagonals:
    //   +tx = south-east (toward the viewer, right)  → front view, unmirrored
    //   +ty = south-west (toward the viewer, left)   → front view, mirrored
    //   -tx = north-west (away)                      → back view
    //   -ty = north-east (away)                      → back view
    // 'right'/'left' select the sheet's side row, which the cast generator
    // fills with the FRONT drawing (cast.ts: frames = [front, back, front]),
    // and 'left' is the mirrored one — so this mapping is exactly "show the
    // face when walking toward the camera, the back when walking away."
    if (Math.abs(dtx) >= Math.abs(dty)) {
      if (dtx === 0 && dty === 0) return 'down';
      return dtx > 0 ? 'right' : 'up';
    }
    return dty > 0 ? 'left' : 'up';
  };

  return {
    kind: 'isometric',
    tileWidth: tw,
    tileHeight: th,

    tileToWorld(tx: number, ty: number): Point {
      return { x: originX + (tx - ty) * halfW, y: originY + (tx + ty) * halfH };
    },

    tileCenterToWorld(tx: number, ty: number): Point {
      return { x: originX + (tx - ty) * halfW + halfW, y: originY + (tx + ty) * halfH + halfH };
    },

    tileFootToWorld(tx: number, ty: number): Point {
      return { x: originX + (tx - ty) * halfW + halfW, y: originY + (tx + ty) * halfH + halfH };
    },

    worldToTile(wx: number, wy: number): Point {
      return nearestTile(wx, wy);
    },

    footToTile(wx: number, wy: number): Point {
      return nearestTile(wx, wy);
    },

    mapSizeToWorld(widthInTiles: number, heightInTiles: number): WorldSize {
      // Exact bounding box of the diamond field after the origin shift: the
      // east corner sits at (w+h)*halfW, the south corner at (w+h)*halfH, and
      // `originY` is the headroom the tallest art needs above row 0.
      return {
        width: (widthInTiles + heightInTiles) * halfW,
        height: originY + (widthInTiles + heightInTiles) * halfH,
      };
    },

    rowDepth(row: number): number {
      // Best-effort: the diagonal a tile in column 0 of this row sits on. Only
      // wall-hung props call this, and they are off for the iso theme.
      return row * th;
    },

    tileDepth(tx: number, ty: number): number {
      return (tx + ty) * th;
    },

    depthAtWorldY(worldY: number): number {
      // Invert the foot anchor: worldY = originY + (tx+ty)*halfH + halfH, and
      // the depth unit is th = 2*halfH, so depth = 2*(worldY - originY) - th.
      // An avatar on tile (tx,ty) therefore lands on exactly (tx+ty)*th —
      // tileDepth's own value, which is the tie the sorted layer relies on.
      return 2 * (worldY - originY) - th;
    },

    sortsTilesWithCharacters: true,

    // Tiled's own rule for art taller than the cell: sit it on the cell's
    // bottom edge. The generated atlas is built to match (isoTileArt.ts
    // bottom-aligns every piece in its square cell), so one subtraction places
    // both the 32x16 floor diamond (offset 0) and the 32x32 wall cube
    // (offset -16, i.e. one tileHeight of overhang).
    tileArtOffsetY(textureHeight: number): number {
      return th - textureHeight;
    },

    facingForWorldStep(dx: number, dy: number): Facing {
      // Back out of screen space before deciding: under 2:1 every cardinal tile
      // step has |dx| = 2|dy|, so the orthogonal "|dx| > |dy| ⇒ sideways" test
      // would answer "sideways" for all four of them and an avatar walking away
      // from the camera would moonwalk with its face showing.
      const a = dx / halfW;
      const b = dy / halfH;
      return facingForTileStep((a + b) / 2, (b - a) / 2);
    },

    facingForTileStep,
  };
}
