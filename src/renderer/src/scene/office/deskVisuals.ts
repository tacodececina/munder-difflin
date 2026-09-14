import { parseSpawnPoints, type TiledMap, type Point } from './tiledCollision';

// Logical monitor slots stay at seat + (0,-2). A facing island can display
// that block on the other side of the chair; screen, cup and shelf must all
// use this same offset. Unannotated maps retain their original placement.
export function readDeskVisualOffsets(map: TiledMap): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const obj of map.layers.find(l => l.name === 'spawn-points')?.objects ?? []) {
    const dy = obj.properties?.find(p => p.name === 'monitorOffsetY')?.value;
    if (typeof dy !== 'number' || !Number.isInteger(dy) || dy === 0 || Math.abs(dy) > 4) continue;
    if (!/^(desk-|pc-|warroom-)/.test(obj.name)) continue;
    offsets.set(`${Math.floor(obj.x / map.tilewidth)},${Math.floor(obj.y / map.tileheight)}`, dy);
  }
  return offsets;
}

export function monitorVisualOffsets(map: TiledMap): Map<string, number> {
  const offsets = readDeskVisualOffsets(map), tiles = new Map<string, number>();
  const above = map.layers.find(l => l.name === 'furniture-above')?.data;
  for (const seat of parseSpawnPoints(map).values()) {
    const dy = offsets.get(`${seat.x},${seat.y}`);
    if (!dy || above?.[(seat.y - 2) * map.width + seat.x] !== 365) continue;
    for (let y = -2; y <= -1; y++) for (let x = 0; x < 2; x++) tiles.set(`${seat.x + x},${seat.y + y}`, dy);
  }
  return tiles;
}

export function deskDisplayTop(seat: Point, offsetY = 0): Point {
  return { x: seat.x, y: seat.y - 2 + offsetY };
}

/** Both static OFF tiles and DeskScreen's ON tiles have a rear view. */
export function monitorDisplayGid(gid: number, offsetY: number): number {
  return offsetY > 0 && [365, 366, 381, 382, 367, 368, 383, 384].includes(gid) ? gid + 4 : gid;
}

export function deskCupPixelOffset(offsetY = 0): Point {
  // The rear casing occupies the old cup position. Use the free surface on
  // its right; the island reserves that column for both north-side sitters.
  return { x: offsetY > 0 ? 34 : 18, y: 23 };
}
