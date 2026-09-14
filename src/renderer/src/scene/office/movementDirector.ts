import { findPath, type Walkable } from './pathfinding';
import { TileReservations } from './tileReservations';

export interface MovementTile { x: number; y: number }
export type MovementStatus = 'moving' | 'arrived' | 'cancelled' | 'unreachable';
export interface MovementRequestOptions { priority?: number }
export interface MovementDirectorOptions { now?: () => number; maxWaitMs?: number; cooperative?: boolean }
interface Journey { current: MovementTile; destination: MovementTile | null; step: MovementTile | null;
  status: MovementStatus; waitingSince: number | null; sequence: number; priority: number }
const same = (a: MovementTile, b: MovementTile) => a.x === b.x && a.y === b.y;
const copy = (tile: MovementTile): MovementTile => ({ ...tile });

/** Scene-local visual routing. Construct only behind a movement feature flag. */
export class MovementDirector {
  private active = true;
  private journeys = new Map<string, Journey>();
  private reservations = new TileReservations();
  private dirty = true;
  private nextPlanAt = 0;
  private sequence = 0;
  constructor(private map: Walkable, private options: MovementDirectorOptions = {}) {}

  register(id: string, current: MovementTile): MovementTile | null {
    if (!this.active) return null;
    const candidates = [current], seen = new Set<string>();
    let free: MovementTile | undefined;
    for (let i = 0; i < candidates.length; i++) {
      const tile = candidates[i], key = `${tile.x},${tile.y}`;
      if (seen.has(key) || !this.map.isWalkable(tile.x, tile.y)) continue;
      seen.add(key);
      if (this.reservations.available(id, tile)) { free = tile; break; }
      candidates.push({ x: tile.x, y: tile.y - 1 }, { x: tile.x, y: tile.y + 1 },
        { x: tile.x - 1, y: tile.y }, { x: tile.x + 1, y: tile.y });
    }
    if (!free) return null;
    current = copy(free);
    this.journeys.set(id, { current, destination: null, step: null, status: 'cancelled',
      waitingSince: null, sequence: 0, priority: 0 });
    this.reservations.register(id, current);
    this.dirty = true;
    return current;
  }

  request(id: string, destination: MovementTile, options: MovementRequestOptions = {}): boolean {
    const journey = this.journeys.get(id);
    if (!journey) return false;
    if (journey.destination && same(journey.destination, destination)) {
      const priority = Number.isFinite(options.priority) ? options.priority! : journey.priority;
      if (priority !== journey.priority) { journey.priority = priority; this.dirty = true; }
      return true;
    }
    if (!findPath(this.map, journey.step ?? journey.current, destination)) {
      this.cancel(id); journey.status = 'unreachable'; return false;
    }
    this.reservations.destination(id, null);
    if (!this.reservations.destination(id, destination) && !this.options.cooperative) {
      this.cancel(id); journey.status = 'unreachable'; return false;
    }
    journey.destination = copy(destination);
    journey.waitingSince = null;
    journey.sequence = ++this.sequence;
    journey.priority = Number.isFinite(options.priority) ? options.priority! : 0;
    journey.status = !journey.step && same(journey.current, destination) ? 'arrived' : 'moving';
    this.dirty = true;
    return true;
  }

  nextStep(id: string): MovementTile | null {
    const journey = this.journeys.get(id);
    if (journey?.step) return journey.step;
    if (!journey || journey.status !== 'moving') return null;
    const now = (this.options.now ?? Date.now)();
    if (journey.waitingSince !== null
      && now - journey.waitingSince >= (this.options.maxWaitMs ?? 5000)) {
      this.cancel(id);
      journey.status = 'unreachable';
      return null;
    }
    if (this.dirty || now >= this.nextPlanAt) this.plan(now);
    return journey.step;
  }

  private plan(now: number): void {
    this.dirty = false;
    this.nextPlanAt = now + 150;
    const moving = [...this.journeys.entries()]
      .filter(([, j]) => j.status === 'moving' && j.destination && !j.step)
      .sort(([aId, a], [bId, b]) => b.priority - a.priority || a.sequence - b.sequence || aId.localeCompare(bId));
    if (this.options.cooperative) this.planSwapYields(moving);
    for (const [id, journey] of moving) {
      if (journey.step || !journey.destination) continue;
      this.reservations.destination(id, journey.destination);
      const route = findPath({ width: this.map.width, height: this.map.height,
        isWalkable: (x, y) => this.map.isWalkable(x, y) && this.reservations.available(id, { x, y }),
      }, journey.current, journey.destination);
      const next = route?.[0];
      if (next && this.reservations.step(id, next)) {
        journey.step = copy(next); journey.waitingSince = null;
      } else {
        journey.waitingSince ??= now;
        if (now - journey.waitingSince >= (this.options.maxWaitMs ?? 5000)) {
          this.cancel(id); journey.status = 'unreachable';
        }
      }
    }
  }

  private planSwapYields(ranked: Array<[string, Journey]>): void {
    for (let winnerIndex = 0; winnerIndex < ranked.length; winnerIndex++) {
      const [, winner] = ranked[winnerIndex];
      if (!winner.destination) continue;
      for (let loserIndex = winnerIndex + 1; loserIndex < ranked.length; loserIndex++) {
        const [loserId, loser] = ranked[loserIndex];
        if (!loser.destination || loser.step || !same(winner.destination, loser.current)
          || !same(loser.destination, winner.current)) continue;
        const candidates = [{ x: loser.current.x, y: loser.current.y - 1 },
          { x: loser.current.x, y: loser.current.y + 1 }, { x: loser.current.x - 1, y: loser.current.y },
          { x: loser.current.x + 1, y: loser.current.y }];
        const side = candidates.find(tile => this.map.isWalkable(tile.x, tile.y)
          && !same(tile, winner.current) && this.reservations.available(loserId, tile));
        if (side && this.reservations.step(loserId, side)) loser.step = copy(side);
      }
    }
  }

  arriveStep(id: string, tile: MovementTile): void {
    const journey = this.journeys.get(id);
    if (!journey?.step || !same(journey.step, tile)) return;
    journey.current = copy(tile); journey.step = null;
    this.reservations.arrive(id, tile);
    if (journey.destination && same(tile, journey.destination)) journey.status = 'arrived';
    this.dirty = true;
  }
  status(id: string): MovementStatus { return this.journeys.get(id)?.status ?? 'cancelled'; }
  hasStep(id: string): boolean { return !!this.journeys.get(id)?.step; }
  position(id: string): MovementTile | undefined { const tile = this.journeys.get(id)?.current; return tile && copy(tile); }
  cancel(id: string): void {
    const journey = this.journeys.get(id); if (!journey) return;
    journey.destination = null; journey.waitingSince = null; journey.status = 'cancelled';
    this.reservations.destination(id, null); this.dirty = true;
  }
  release(id: string): void { this.journeys.delete(id); this.reservations.release(id); this.dirty = true; }
  dispose(): void { this.active = false; this.journeys.clear(); this.reservations.clear(); this.dirty = false; }
}

/** Flag gate: the map is not resolved and no reservations exist while disabled. */
export function createFloorMovement(enabled: boolean, resolveMap: () => Walkable): MovementDirector | null {
  return enabled ? new MovementDirector(resolveMap(), { cooperative: true }) : null;
}
