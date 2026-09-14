export type MovementOwner = 'wander' | 'errand' | 'cafe' | 'station' | 'card' | 'work' | 'blocked';
export type MovementCommandFailure = 'cancelled' | 'unreachable';

export const MOVEMENT_PRIORITY: Readonly<Record<MovementOwner, number>> = Object.freeze({
  wander: 100,
  errand: 200,
  cafe: 300,
  station: 400,
  card: 500,
  work: 600,
  blocked: 700,
});

interface ActiveCommand {
  owner: MovementOwner;
  serial: number;
  onArrive?: () => void;
  onFailure?: (reason: MovementCommandFailure) => void;
}

/** Pure command arbitration for a single avatar. It owns callbacks, not paths.
 * Constructed by Character only when coordinated movement is enabled. */
export class MovementCommands {
  private active: ActiveCommand | null = null;
  private floor: MovementOwner | null = null;
  private serial = 0;
  private disposed = false;

  get activeOwner(): MovementOwner | null { return this.active?.owner ?? null; }

  owns(owner: MovementOwner): boolean { return this.active?.owner === owner; }

  canRequest(owner: MovementOwner): boolean {
    return !this.disposed && this.admitted(owner)
      && (!this.active || MOVEMENT_PRIORITY[owner] >= MOVEMENT_PRIORITY[this.active.owner]);
  }

  setFloor(owner: MovementOwner | null): void {
    if (this.disposed) return;
    this.floor = owner;
    if (this.active && !this.admitted(this.active.owner)) this.finish('cancelled', this.active.owner);
  }

  request(owner: MovementOwner, onArrive?: () => void,
    onFailure?: (reason: MovementCommandFailure) => void): boolean {
    if (!this.canRequest(owner)) {
      onFailure?.('cancelled');
      return false;
    }

    const serial = ++this.serial;
    const replaced = this.active;
    this.active = null;
    replaced?.onFailure?.('cancelled');

    // A cancellation callback may synchronously install a newer command. It
    // wins; the interrupted request never becomes active afterward.
    if (this.active || serial !== this.serial || !this.canRequest(owner)) {
      onFailure?.('cancelled');
      return false;
    }
    this.active = { owner, serial, onArrive, onFailure };
    return true;
  }

  arrive(owner?: MovementOwner): boolean { return this.finish('arrived', owner); }

  fail(reason: MovementCommandFailure, owner?: MovementOwner): boolean {
    return this.finish(reason, owner);
  }

  cancel(owner?: MovementOwner): boolean { return this.finish('cancelled', owner); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.floor = null;
    this.finish('cancelled');
  }

  private admitted(owner: MovementOwner): boolean {
    return !this.floor || MOVEMENT_PRIORITY[owner] >= MOVEMENT_PRIORITY[this.floor];
  }

  private finish(outcome: 'arrived' | MovementCommandFailure, owner?: MovementOwner): boolean {
    const command = this.active;
    if (!command || (owner !== undefined && command.owner !== owner)) return false;
    this.active = null;
    ++this.serial;
    if (outcome === 'arrived') command.onArrive?.();
    else command.onFailure?.(outcome);
    return true;
  }
}
