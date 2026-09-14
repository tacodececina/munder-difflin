import type { MovementTile } from './movementDirector';

interface Claim { current: MovementTile; next: MovementTile | null; destination: MovementTile | null }
const same = (a: MovementTile, b: MovementTile) => a.x === b.x && a.y === b.y;

/** A moving body owns both endpoints and its undirected edge until arrival.
 * Home-seat allocation is intentionally separate from these transient claims. */
export class TileReservations {
  private claims = new Map<string, Claim>();

  available(id: string, tile: MovementTile): boolean {
    for (const [owner, claim] of this.claims) {
      if (owner === id) continue;
      if (same(tile, claim.current) || (claim.next && same(tile, claim.next))
        || (claim.destination && same(tile, claim.destination))) return false;
    }
    return true;
  }

  register(id: string, current: MovementTile): void {
    this.claims.set(id, { current: { ...current }, next: null, destination: null });
  }

  destination(id: string, tile: MovementTile | null): boolean {
    const claim = this.claims.get(id);
    if (!claim || (tile && !this.available(id, tile))) return false;
    claim.destination = tile && { ...tile };
    return true;
  }

  step(id: string, tile: MovementTile): boolean {
    const claim = this.claims.get(id);
    if (!claim || !this.available(id, tile)) return false;
    if (Math.abs(claim.current.x - tile.x) + Math.abs(claim.current.y - tile.y) !== 1) return false;
    // Both endpoints are claimed; this also excludes a reversed traversal of
    // an in-flight edge without storing an independently drifting edge table.
    claim.next = { ...tile };
    return true;
  }

  arrive(id: string, tile: MovementTile): void {
    const claim = this.claims.get(id);
    if (!claim?.next || !same(tile, claim.next)) return;
    claim.current = { ...tile };
    claim.next = null;
  }

  release(id: string): void { this.claims.delete(id); }
  clear(): void { this.claims.clear(); }
}
