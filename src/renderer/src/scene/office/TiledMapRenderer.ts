import { Container, Sprite, Texture, Rectangle } from 'pixi.js';
import {
  TILE_ID_MASK,
  parseCollisionGrid,
  parseSpawnPoints,
  markWalkableSpawnPoints,
  parseZones,
  resolveTilesetIndex,
  findLayer as findLayerPure,
  WALKABLE_SPAWN_PREFIXES,
  type TiledMap,
  type TiledLayer,
  type TiledObject,
  type TiledTilesetRef,
  type ZoneRect,
  type Point,
} from './tiledCollision';
import { createIsometricProjection, createOrthogonalProjection, type Projection, type WorldSize } from './projection';
import { readDeskVisualOffsets, monitorVisualOffsets, monitorDisplayGid } from './deskVisuals';
import { standingTileDepthRows } from './tileOcclusion';

// Trimmed port of shahar061/the-office (office/engine/TiledMapRenderer.ts):
// renders floor/walls/furniture tile layers and parses collision, spawn-points
// and zones. Interactive-object / war-room / monitor-glow extraction is dropped
// (we render every tile statically), so no tiles ever go missing.
//
// The collision/spawn-point/zone PARSING is pure logic with no pixi.js
// dependency — it lives in ./tiledCollision so the theme-bundle validator
// (Phase 4) can reuse the exact same rules without importing pixi.js. This
// class re-exports those types below for every existing importer
// (themeLoader.ts, DeskScreen.ts, Character.ts, OfficeFloor.tsx).

export type { TiledMap, TiledLayer, TiledObject, TiledTilesetRef, ZoneRect, Point };
// Tile→world geometry lives in ./projection (also pixi-free). The renderer owns
// the instance so every consumer reaches the SAME projection through it; see
// that file for why the conversion stopped being a hand-written multiplication.
export type { Projection, WorldSize };

const FLIPPED_H_FLAG = 0x80000000;
const FLIPPED_V_FLAG = 0x40000000;
const FLIPPED_D_FLAG = 0x20000000;

const TILE_LAYERS = ['floor', 'walls', 'furniture-below', 'furniture-above'] as const;

/** The only layer whose art can be TALL — see ./tileOcclusion for the rule and
 *  for why `walls` and `furniture-below` are deliberately not in this list. */
const STANDING_LAYER = 'furniture-above';

/** Alpha at or above which a pixel counts as drawn. Matches nothing in
 *  particular on purpose: the atlases are hard-edged pixel art with no
 *  antialiasing, so every pixel is 0 or 255 and the threshold only has to
 *  ignore the stray near-transparent value a PNG encoder might leave behind. */
const OPAQUE_ALPHA = 16;

/**
 * For each cell of one tileset atlas: does its art touch the cell's BOTTOM
 * edge? That single bit is what tells a tall prop's upper half apart from a
 * flat decal (./tileOcclusion explains why it is the right question).
 *
 * Read back ONCE per atlas at scene construction, one horizontal strip per
 * atlas row rather than the whole image, so the biggest shipped atlas costs 89
 * `getImageData` calls of 256x1 px — microseconds, and never again per frame.
 *
 * Returns null on any failure (no DOM, no 2D context, an unreadable source).
 * Null means "assume nothing is tall", which is exactly the rendering this app
 * shipped before — a degradation, never a broken floor.
 *
 * `cellW` / `cellH` are the ATLAS cell size, and they are named that way on
 * purpose: this addresses pixels inside a source image, it is not geometry on
 * the floor, and it must not read as one more hand-written scaling by a tile
 * size — the same reason `textureForGid` below slices with `tw` / `th`.
 */
function bottomEdgeOpaqueMask(
  texture: Texture,
  imageWidth: number,
  imageHeight: number,
  columns: number,
  cellW: number,
  cellH: number,
): Uint8Array | null {
  const source = (texture.source as { resource?: unknown } | undefined)?.resource;
  if (!source || typeof document === 'undefined' || columns <= 0 || cellH <= 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source as CanvasImageSource, 0, 0);
    const rows = Math.floor(imageHeight / cellH);
    const mask = new Uint8Array(rows * columns);
    for (let r = 0; r < rows; r++) {
      const strip = ctx.getImageData(0, (r + 1) * cellH - 1, imageWidth, 1).data;
      for (let c = 0; c < columns; c++) {
        for (let px = c * cellW; px < (c + 1) * cellW && px < imageWidth; px++) {
          if (strip[px * 4 + 3] >= OPAQUE_ALPHA) { mask[r * columns + c] = 1; break; }
        }
      }
    }
    return mask;
  } catch {
    return null;
  }
}

export class TiledMapRenderer {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  /** How this map's tiles become world pixels — and how props on them sort.
   *  Orthogonal today; swapping in another projection is a one-line change
   *  here rather than an edit across the whole scene. */
  readonly projection: Projection;

  private walkabilityGrid: boolean[][] = [];
  private spawnPoints: Map<string, Point> = new Map();
  private zones: Map<string, ZoneRect> = new Map();
  private deskOffsets: Map<string, number> = new Map();
  private characterContainer: Container;
  private rootContainer: Container;
  /** Per-tileset "does this cell's art reach its bottom edge" bit, built on
   *  first use and kept for the renderer's lifetime. `null` = unreadable. */
  private bottomEdgeMasks: Map<number, Uint8Array | null> = new Map();

  constructor(private mapData: TiledMap, private tilesetTextures: Texture[]) {
    this.width = mapData.width;
    this.height = mapData.height;
    this.tileSize = mapData.tilewidth;
    // The map itself says which grid it is on — Tiled's own `orientation`
    // field, so a theme declares its projection by authoring an isometric map
    // rather than by carrying a second, separate flag that could disagree with
    // the geometry it ships. The test compares against 'isometric' rather than
    // switching on the field, so the orthogonal branch is the default for every
    // other value AND for a missing field: all four shipped maps write
    // "orientation":"orthogonal" explicitly (Tiled always emits it), and a
    // hand-written or generated map may omit it. Both land on the exact same
    // `createOrthogonalProjection(this.tileSize)` the scene always used.
    this.projection = mapData.orientation === 'isometric'
      ? createIsometricProjection({
        tileWidth: this.tileSize,
        tileHeight: mapData.tileheight,
        mapWidthInTiles: this.width,
        mapHeightInTiles: this.height,
      })
      : createOrthogonalProjection(this.tileSize);
    this.rootContainer = new Container();
    this.characterContainer = new Container();
    this.characterContainer.sortableChildren = true;

    // Collision/spawn-point/zone parsing is pure logic shared with the
    // theme-bundle validator — see ./tiledCollision.
    this.walkabilityGrid = parseCollisionGrid(mapData);
    this.spawnPoints = parseSpawnPoints(mapData);
    markWalkableSpawnPoints(this.walkabilityGrid, this.spawnPoints, this.width, this.height, WALKABLE_SPAWN_PREFIXES);
    this.zones = parseZones(mapData);
    this.deskOffsets = readDeskVisualOffsets(mapData);
    this.buildTileLayers();
  }

  getContainer(): Container { return this.rootContainer; }
  getCharacterContainer(): Container { return this.characterContainer; }

  isWalkable(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return false;
    return this.walkabilityGrid[ty][tx];
  }

  // NOTE: the old `tileToPixel` / `pixelToTile` helpers are gone. They were the
  // orthogonal formula spelled out on this class, and leaving them as aliases
  // would leave two doors onto the same geometry — exactly the drift that let
  // six files grow their own copy. Go through `projection` instead:
  // `tileToWorld` / `tileCenterToWorld` / `tileFootToWorld` / `worldToTile` /
  // `footToTile`.

  /** The whole map's size in world pixels — what the camera clamps to and what
   *  bounds the thought clouds. */
  worldSize(): WorldSize {
    return this.projection.mapSizeToWorld(this.width, this.height);
  }

  getSpawnPoint(name: string): Point | undefined { return this.spawnPoints.get(name); }
  getAllSpawnPoints(): Map<string, Point> { return this.spawnPoints; }
  getZone(name: string): ZoneRect | undefined { return this.zones.get(name); }
  getAllZones(): Map<string, ZoneRect> { return this.zones; }
  getDeskVisualOffset(seat: Point): number { return this.deskOffsets.get(`${seat.x},${seat.y}`) ?? 0; }

  /** The (flip-stripped) gid painted at a tile of a layer, 0 when empty.
   *  Lets the scene locate furniture by art — e.g. each desk's monitor block. */
  gidAt(layerName: string, tx: number, ty: number): number {
    const layer = this.findLayer(layerName, 'tilelayer');
    if (!layer?.data || tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) return 0;
    return (layer.data[ty * this.width + tx] ?? 0) & TILE_ID_MASK;
  }

  /** A sub-texture for one tileset tile, addressed by gid — for dynamic props
   *  that reuse map art (e.g. the lit monitor variant overlaid when an agent
   *  sits down). Returns undefined for gid 0 / out-of-range.
   *  NOTE: allocates a fresh Texture per call and the CALLER owns its lifetime
   *  (fine for constructor-time use, kept alive by sprites; do NOT call this
   *  per frame or the textures leak). */
  textureForGid(gid: number): Texture | undefined {
    const tileId = gid & TILE_ID_MASK;
    if (tileId === 0) return undefined;
    const resolved = this.resolveTileset(tileId);
    if (!resolved) return undefined;
    const { tileset, texture } = resolved;
    const cols = tileset.columns ?? 16;
    const tw = tileset.tilewidth ?? this.tileSize;
    const th = tileset.tileheight ?? this.tileSize;
    const localId = tileId - tileset.firstgid;
    const frame = new Rectangle((localId % cols) * tw, Math.floor(localId / cols) * th, tw, th);
    return new Texture({ source: texture.source, frame });
  }

  private resolveTileset(tileId: number): { tileset: TiledTilesetRef; texture: Texture } | undefined {
    const i = resolveTilesetIndex(tileId, this.mapData.tilesets);
    if (i === undefined) return undefined;
    return { tileset: this.mapData.tilesets[i], texture: this.tilesetTextures[i] };
  }

  /** Does the art drawn for `gid` touch the bottom edge of its cell? Backed by
   *  one lazily-built mask per atlas (see `bottomEdgeOpaqueMask`); an atlas we
   *  could not read back answers `false` for every gid, which reproduces the
   *  pre-occlusion rendering exactly. */
  private artRunsOffBottom(gid: number): boolean {
    const tileId = gid & TILE_ID_MASK;
    if (tileId === 0) return false;
    const i = resolveTilesetIndex(tileId, this.mapData.tilesets);
    if (i === undefined) return false;
    let mask = this.bottomEdgeMasks.get(i);
    if (mask === undefined) {
      const ts = this.mapData.tilesets[i];
      const cols = ts.columns ?? 16;
      const tw = ts.tilewidth ?? this.tileSize;
      const th = ts.tileheight ?? this.tileSize;
      mask = bottomEdgeOpaqueMask(
        this.tilesetTextures[i],
        ts.imagewidth ?? cols * tw,
        ts.imageheight ?? Math.ceil((ts.tilecount ?? cols) / cols) * th,
        cols, tw, th,
      );
      this.bottomEdgeMasks.set(i, mask);
    }
    if (!mask) return false;
    const local = tileId - this.mapData.tilesets[i].firstgid;
    return local >= 0 && local < mask.length && mask[local] === 1;
  }

  private buildTileLayers(): void {
    if (this.mapData.tilesets.length === 0) return;

    // Y-SORTING THE MAP ITSELF.
    //
    // A top-down floor can paint every tile under every avatar and be right:
    // the art is flat, nothing is ever "in front of" a person. A diamond grid
    // cannot — a wall block or a desk one tile closer to the camera has to hide
    // the legs of whoever is standing behind it, and that is a comparison
    // between a TILE and a CHARACTER, so they have to live in the same sorted
    // container. `projection.sortsTilesWithCharacters` is the projection saying
    // which world it is.
    //
    // The floor layer always stays in its own unsorted container underneath:
    // it is what everything else stands on, it can never occlude anyone, and
    // leaving ~hundreds of floor sprites out of the sort keeps the per-frame
    // zIndex pass cheap.
    //
    // ORTHOGONAL DID NOT STAY EXEMPT. The premise above — flat art, nothing
    // ever in front of a person — died with the tech-office redesign, which put
    // monitors and chair backs on WALKABLE cells. So a top-down floor now hands
    // the sorted container a strictly-bounded minority of its tiles: the ones
    // whose art is the upper half of something standing in the row below, on a
    // cell somebody can actually stand on. ./tileOcclusion owns that rule and
    // the evidence for it; the counts it yields are 48 sprites on the biggest
    // shipped map and ZERO on brooklyn99, against 235 for "sort the whole
    // furniture-above layer" and 2544 for "sort everything". The per-frame
    // zIndex pass stays the cheap thing the paragraph above promised.
    const sortTiles = this.projection.sortsTilesWithCharacters;
    const monitorOffsets = monitorVisualOffsets(this.mapData);
    const standingRows = sortTiles
      ? new Map<string, number>()
      : standingTileDepthRows(this.mapData, STANDING_LAYER, {
        displayedGid: (tx, ty) => monitorDisplayGid(
          this.gidAt(STANDING_LAYER, tx, ty),
          monitorOffsets.get(`${tx},${ty}`) ?? 0,
        ),
        displayOffset: (tx, ty) => monitorOffsets.get(`${tx},${ty}`) ?? 0,
        isWalkable: (tx, ty) => this.isWalkable(tx, ty),
        artRunsOffBottom: (gid) => this.artRunsOffBottom(gid),
      });

    for (const layerName of TILE_LAYERS) {
      const layer = this.findLayer(layerName, 'tilelayer');
      const sorted = sortTiles && layerName !== 'floor';
      const container = sorted ? this.characterContainer : new Container();
      if (!sorted) container.label = layerName;
      const standing = layerName === STANDING_LAYER ? standingRows : undefined;

      if (layer?.data) {
        for (let y = 0; y < this.height; y++) {
          for (let x = 0; x < this.width; x++) {
            const raw = layer.data[y * this.width + x];
            if (raw === 0) continue;

            const flippedH = (raw & FLIPPED_H_FLAG) !== 0;
            const flippedV = (raw & FLIPPED_V_FLAG) !== 0;
            const flippedD = (raw & FLIPPED_D_FLAG) !== 0;
            const displayOffset = layerName === STANDING_LAYER ? monitorOffsets.get(`${x},${y}`) ?? 0 : 0;
            const tileId = monitorDisplayGid(raw & TILE_ID_MASK, displayOffset);

            const resolved = this.resolveTileset(tileId);
            if (!resolved) continue;

            const { tileset, texture } = resolved;
            const cols = tileset.columns ?? 16;
            const tw = tileset.tilewidth ?? this.tileSize;
            const th = tileset.tileheight ?? this.tileSize;
            const localId = tileId - tileset.firstgid;
            const srcX = (localId % cols) * tw;
            const srcY = Math.floor(localId / cols) * th;

            const frame = new Rectangle(srcX, srcY, tw, th);
            const sprite = new Sprite(new Texture({ source: texture.source, frame }));

            if (flippedH || flippedV || flippedD) {
              // Mirrored/rotated tiles pivot about the cell's centre.
              const c = this.projection.tileCenterToWorld(x, y);
              sprite.anchor.set(0.5, 0.5);
              sprite.x = c.x;
              sprite.y = c.y;
              if (flippedD) {
                if (flippedH && !flippedV) {
                  sprite.rotation = Math.PI / 2;
                } else if (!flippedH && flippedV) {
                  sprite.rotation = -Math.PI / 2;
                } else if (flippedH && flippedV) {
                  sprite.rotation = Math.PI / 2;
                  sprite.scale.y = -1;
                } else {
                  sprite.rotation = Math.PI / 2;
                  sprite.scale.x = -1;
                }
              } else {
                if (flippedH) sprite.scale.x = -1;
                if (flippedV) sprite.scale.y = -1;
              }
            } else {
              const p = this.projection.tileToWorld(x, y);
              sprite.x = p.x;
              // Where art taller than the cell hangs is the PROJECTION's call,
              // not this loop's — see Projection.tileArtOffsetY. Orthogonal
              // returns 0 for every texture height, so this line is literally
              // the `sprite.y = y * tileSize` it replaced, for the four shipped
              // maps AND for any user-authored bundle with a taller atlas. The
              // isometric projection bottom-aligns (Tiled's rule), which is how
              // a 32x32 wall cube and a 32x16 floor diamond share one square
              // atlas cell.
              sprite.y = p.y + this.projection.tileArtOffsetY(th);
            }

            if (displayOffset) {
              const from = this.projection.tileToWorld(x, y);
              const to = this.projection.tileToWorld(x, y + displayOffset);
              sprite.x += to.x - from.x;
              sprite.y += to.y - from.y;
            }
            if (sorted) sprite.zIndex = this.projection.tileDepth(x, y + displayOffset);

            // A TALL tile under a projection that otherwise leaves the map out
            // of the sort. Its depth keys on the row the object STANDS on (one
            // below where the art is drawn) plus one, and that +1 is the whole
            // fix: an avatar standing on this very cell anchors its feet on
            // exactly that row boundary, so without the nudge the two tie and
            // insertion order — tiles first, cast later — hands the avatar the
            // front. With it, the monitor wins and the agent walks BEHIND the
            // screen. An avatar one row further down still has the larger depth
            // and still walks in front, which is why a seated agent keeps
            // drawing over its own keyboard exactly as before.
            const standingRow = standing?.get(`${x},${y}`);
            if (standingRow !== undefined) {
              sprite.zIndex = this.projection.tileDepth(x, standingRow) + 1;
              this.characterContainer.addChild(sprite);
              continue;
            }
            container.addChild(sprite);
          }
        }
      }

      if (container !== this.characterContainer) this.rootContainer.addChild(container);
    }

    // Characters render above every tile layer — and, under a projection that
    // sorts tiles with them, the wall/furniture sprites are already inside this
    // container, interleaved by zIndex rather than stacked under it.
    this.rootContainer.addChild(this.characterContainer);
  }

  private findLayer(name: string, type: 'tilelayer' | 'objectgroup'): TiledLayer | undefined {
    return findLayerPure(this.mapData.layers, name, type);
  }
}
