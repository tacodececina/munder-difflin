import type { HookEvent } from '@shared/hookEvents';
import type { Walkable } from './pathfinding';
import { StationDirector } from './stationDirector';
import { MovementDirector } from './movementDirector';
import { StationConnections } from './stationConnections';

interface Options {
  map: Walkable;
  /** Phase 5 can own the scene-wide authority; never allocate a second one. */
  movement?: MovementDirector;
  director: ConstructorParameters<typeof StationDirector>[0];
  onHook: (callback: (event: HookEvent) => void) => () => void;
  onParser: (callback: (event: HookEvent) => void) => () => void;
  onExit: (ptyId: string, callback: () => void) => () => void;
}
export interface StationActivity {
  director: StationDirector;
  movement: MovementDirector;
  connections: StationConnections;
  dispose(): void;
}

/** Resolve no dependencies, subscribe to nothing, and allocate no scene cache
 * until explicitly enabled. The same boundary owns all teardown paths. */
export function startStationActivity(enabled: boolean, resolve: () => Options): StationActivity | null {
  if (!enabled) return null;
  const options = resolve();
  const director = new StationDirector(options.director);
  const movement = options.movement ?? new MovementDirector(options.map);
  const connections = new StationConnections({
    subscribe: options.onExit,
    disconnect: id => director.disconnect(id),
    reconnect: id => director.reconnect(id),
  });
  const offHook = options.onHook(event => director.observe(event));
  const offParser = options.onParser(event => director.observe(event));
  let active = true;
  return { director, movement, connections, dispose() {
    if (!active) return;
    active = false;
    director.dispose(); // late callbacks lose authority before unsubscribing
    offHook(); offParser(); connections.dispose();
    if (!options.movement) movement.dispose();
  } };
}
