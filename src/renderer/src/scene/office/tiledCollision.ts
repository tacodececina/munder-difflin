// Pure Tiled-JSON parsing helpers — no pixi.js import, on purpose.
//
// Extracted out of TiledMapRenderer.ts (Phase 4, custom theme bundles) so the
// SAME collision/spawn-point/tileset-lookup logic can be shared by:
//   1. TiledMapRenderer itself (rendering — needs pixi.js Texture/Sprite), and
//   2. the theme-bundle validator (themeBundle.ts), which must run without a
//      renderer/GPU context — including under plain `node --test` — to check a
//      user-authored bundle BEFORE anything tries to render it.
//
// TiledMapRenderer.ts re-exports the types below for backward compatibility
// (other files already import `TiledMap` etc. from './TiledMapRenderer').
// Behavior is byte-for-byte identical to the pre-extraction private methods —
// this is a pure refactor, not a rewrite.

export const TILE_ID_MASK = 0x1fffffff;

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets: TiledTilesetRef[];
  /** Tiled's own grid-shape field. Absent or 'orthogonal' on every map this app
   *  shipped before the isometric prototype; 'isometric' is what makes
   *  TiledMapRenderer build the diamond projection instead of the square one.
   *  Nothing in THIS module reads it — collision, spawn points and zones are
   *  all indexed in tile space, which is projection-independent. */
  orientation?: string;
}

export interface TiledLayer {
  name: string;
  type: 'tilelayer' | 'objectgroup';
  data?: number[];
  objects?: TiledObject[];
}

export interface TiledObject {
  name: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface TiledTilesetRef {
  firstgid: number;
  source?: string;
  image?: string;
  columns?: number;
  tilewidth?: number;
  tileheight?: number;
  tilecount?: number;
}

export interface ZoneRect { x: number; y: number; width: number; height: number; }
export interface Point { x: number; y: number; }

export const COLLISION_LAYER = 'collision';
export const SPAWN_POINTS_LAYER = 'spawn-points';
export const ZONES_LAYER = 'zones';

/** Seat/desk spawn-point name prefixes that are always walkable even though the
 *  underlying chair/desk tile is painted non-walkable in the collision layer. */
export const WALKABLE_SPAWN_PREFIXES = ['desk-', 'pc-', 'warroom-', 'entrance'];

export function findLayer(
  layers: TiledLayer[],
  name: string,
  type: 'tilelayer' | 'objectgroup',
): TiledLayer | undefined {
  return layers.find((l) => l.name === name && l.type === type);
}

/** Builds the walkability grid from the map's `collision` tile layer. Every
 *  tile starts walkable; any tile painted with a non-empty gid in the
 *  collision layer becomes non-walkable. A map with no collision layer at all
 *  is fully walkable (matches the renderer's prior inline behavior). */
export function parseCollisionGrid(map: TiledMap): boolean[][] {
  const grid: boolean[][] = Array.from({ length: map.height }, () => Array(map.width).fill(true));
  const layer = findLayer(map.layers, COLLISION_LAYER, 'tilelayer');
  if (!layer?.data) return grid;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const rawId = layer.data[y * map.width + x];
      if (((rawId ?? 0) & TILE_ID_MASK) !== 0) grid[y][x] = false;
    }
  }
  return grid;
}

/** Named spawn points from the `spawn-points` object layer, tile coordinates. */
export function parseSpawnPoints(map: TiledMap): Map<string, Point> {
  const points = new Map<string, Point>();
  const layer = findLayer(map.layers, SPAWN_POINTS_LAYER, 'objectgroup');
  if (!layer?.objects) return points;
  for (const obj of layer.objects) {
    points.set(obj.name, {
      x: Math.floor(obj.x / map.tilewidth),
      y: Math.floor(obj.y / map.tileheight),
    });
  }
  return points;
}

/** Mutates `grid` in place, forcing seat/desk-prefixed spawn points walkable. */
export function markWalkableSpawnPoints(
  grid: boolean[][],
  spawnPoints: Map<string, Point>,
  width: number,
  height: number,
  prefixes: readonly string[] = WALKABLE_SPAWN_PREFIXES,
): void {
  for (const [name, point] of spawnPoints) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    if (point.y >= 0 && point.y < height && point.x >= 0 && point.x < width) {
      grid[point.y][point.x] = true;
    }
  }
}

/** Named rectangular zones from the `zones` object layer, tile coordinates. */
export function parseZones(map: TiledMap): Map<string, ZoneRect> {
  const zones = new Map<string, ZoneRect>();
  const layer = findLayer(map.layers, ZONES_LAYER, 'objectgroup');
  if (!layer?.objects) return zones;
  for (const obj of layer.objects) {
    zones.set(obj.name, {
      x: Math.floor(obj.x / map.tilewidth),
      y: Math.floor(obj.y / map.tileheight),
      width: Math.floor((obj.width ?? 0) / map.tilewidth),
      height: Math.floor((obj.height ?? 0) / map.tileheight),
    });
  }
  return zones;
}

/** The tileset a given (unmasked) tile id belongs to, by highest firstgid <=
 *  tileId. Pure index lookup — no texture involved, safe to call for
 *  validation before any image has been loaded. */
export function resolveTilesetIndex(tileId: number, tilesets: TiledTilesetRef[]): number | undefined {
  for (let i = tilesets.length - 1; i >= 0; i--) {
    if (tileId >= tilesets[i].firstgid) return i;
  }
  return undefined;
}

/** Convenience wrapper combining the three parses above into one walkability
 *  check function, matching `pathfinding.ts`'s `Walkable` shape — used by the
 *  bundle validator to confirm authored anchors sit on walkable tiles without
 *  re-implementing the walkability rules. */
export function buildWalkable(map: TiledMap): { width: number; height: number; isWalkable(x: number, y: number): boolean } {
  const grid = parseCollisionGrid(map);
  const spawnPoints = parseSpawnPoints(map);
  markWalkableSpawnPoints(grid, spawnPoints, map.width, map.height);
  return {
    width: map.width,
    height: map.height,
    isWalkable(x: number, y: number): boolean {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
      return grid[y][x];
    },
  };
}
