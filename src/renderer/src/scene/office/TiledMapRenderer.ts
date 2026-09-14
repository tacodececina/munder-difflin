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
    const sortTiles = this.projection.sortsTilesWithCharacters;
    const monitorOffsets = monitorVisualOffsets(this.mapData);

    for (const layerName of TILE_LAYERS) {
      const layer = this.findLayer(layerName, 'tilelayer');
      const sorted = sortTiles && layerName !== 'floor';
      const container = sorted ? this.characterContainer : new Container();
      if (!sorted) container.label = layerName;

      if (layer?.data) {
        for (let y = 0; y < this.height; y++) {
          for (let x = 0; x < this.width; x++) {
            const raw = layer.data[y * this.width + x];
            if (raw === 0) continue;

            const flippedH = (raw & FLIPPED_H_FLAG) !== 0;
            const flippedV = (raw & FLIPPED_V_FLAG) !== 0;
            const flippedD = (raw & FLIPPED_D_FLAG) !== 0;
            const displayOffset = layerName === 'furniture-above' ? monitorOffsets.get(`${x},${y}`) ?? 0 : 0;
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

            if (sorted) sprite.zIndex = this.projection.tileDepth(x, y);
            if (displayOffset) {
              const from = this.projection.tileToWorld(x, y);
              const to = this.projection.tileToWorld(x, y + displayOffset);
              sprite.x += to.x - from.x;
              sprite.y += to.y - from.y;
              if (sorted) sprite.zIndex = this.projection.tileDepth(x, y + displayOffset);
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
