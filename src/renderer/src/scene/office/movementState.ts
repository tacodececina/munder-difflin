import type { MovementOwner } from './movementCommands';

/** Visual precedence only. The breaker observation is independent of parser
 * status refreshes and cannot be cleared by a terminal saying "working". */
export function operationalMovementFloor(status: string, breakerBlocked: boolean): MovementOwner | null {
  return breakerBlocked || ['blocked', 'looping', 'compacting', 'ghost'].includes(status) ? 'blocked' : null;
}
