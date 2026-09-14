import { findPath, type Walkable } from './pathfinding';
import { TileReservations } from './tileReservations';

export interface MovementTile { x: number; y: number }
export type MovementStatus = 'moving' | 'arrived' | 'cancelled' | 'unreachable';
interface Journey {
  current: MovementTile;
  destination: MovementTile | null;
  step: MovementTile | null;
  status: MovementStatus;
  waitingSince: number | null;
  nextPlanAt: number;
}
const same = (a: MovementTile, b: MovementTile) => a.x === b.x && a.y === b.y;

/** Scene-local visual routing. Construct only behind the stations flag. */
export class MovementDirector {
  private active = true;
  private journeys = new Map<string, Journey>();
  private reservations = new TileReservations();
  constructor(private map: Walkable, private options: { now?: () => number; maxWaitMs?: number } = {}) {}

  register(id: string, current: MovementTile): MovementTile | null {
    if (!this.active) return null;
    const candidates = [current];
    const seen = new Set<string>();
    let free: MovementTile | undefined;
    for (let i = 0; i < candidates.length; i++) {
      const tile = candidates[i];
      const key = `${tile.x},${tile.y}`;
      if (seen.has(key) || !this.map.isWalkable(tile.x, tile.y)) continue;
      seen.add(key);
      if (this.reservations.available(id, tile)) { free = tile; break; }
      candidates.push({ x: tile.x, y: tile.y - 1 }, { x: tile.x, y: tile.y + 1 },
        { x: tile.x - 1, y: tile.y }, { x: tile.x + 1, y: tile.y });
    }
    if (!free) return null;
    current = { ...free };
    this.journeys.set(id, { current, destination: null, step: null, status: 'cancelled', waitingSince: null, nextPlanAt: 0 });
    this.reservations.register(id, current);
    return current;
  }

  request(id: string, destination: MovementTile): boolean {
    const journey = this.journeys.get(id);
    if (!journey) return false;
    if (journey.destination && same(journey.destination, destination)) return true;
    if (!findPath(this.map, journey.step ?? journey.current, destination)
      || !this.reservations.destination(id, destination)) {
      this.cancel(id);
      journey.status = 'unreachable';
      return false;
    }
    journey.destination = { ...destination };
    journey.waitingSince = null;
    journey.nextPlanAt = 0;
    journey.status = !journey.step && same(journey.current, destination) ? 'arrived' : 'moving';
    return true;
  }

  nextStep(id: string): MovementTile | null {
    const journey = this.journeys.get(id);
    if (journey?.step) return journey.step;
    if (!journey || journey.status !== 'moving' || !journey.destination) return null;
    const now = (this.options.now ?? Date.now)();
    if (journey.waitingSince !== null && now - journey.waitingSince >= (this.options.maxWaitMs ?? 5000)) {
      this.cancel(id);
      journey.status = 'unreachable';
      return null;
    }
    if (now < journey.nextPlanAt) return null;
    journey.nextPlanAt = now + 150;
    const route = findPath({ width: this.map.width, height: this.map.height,
      isWalkable: (x, y) => this.map.isWalkable(x, y) && this.reservations.available(id, { x, y }),
    }, journey.current, journey.destination);
    const next = route?.[0];
    if (next && this.reservations.step(id, next)) {
      journey.step = next;
      journey.waitingSince = null;
    } else {
      journey.waitingSince ??= now;
    }
    return journey.step;
  }

  arriveStep(id: string, tile: MovementTile): void {
    const journey = this.journeys.get(id);
    if (!journey?.step || !same(journey.step, tile)) return;
    journey.current = tile;
    journey.step = null;
    journey.nextPlanAt = 0;
    this.reservations.arrive(id, tile);
    if (journey.destination && same(tile, journey.destination)) journey.status = 'arrived';
  }

  status(id: string): MovementStatus { return this.journeys.get(id)?.status ?? 'cancelled'; }
  hasStep(id: string): boolean { return !!this.journeys.get(id)?.step; }

  position(id: string): MovementTile | undefined {
    const tile = this.journeys.get(id)?.current;
    return tile && { ...tile };
  }

  cancel(id: string): void {
    const journey = this.journeys.get(id);
    if (!journey) return;
    journey.destination = null;
    journey.waitingSince = null;
    journey.status = 'cancelled';
    this.reservations.destination(id, null);
  }

  release(id: string): void {
    this.journeys.delete(id);
    this.reservations.release(id);
  }

  dispose(): void {
    this.active = false;
    this.journeys.clear();
    this.reservations.clear();
  }
}
