interface Options {
  subscribe: (ptyId: string, callback: () => void) => () => void;
  disconnect: (agentId: string) => void;
  reconnect: (agentId: string) => void;
}

interface Connection {
  ptyId?: string;
  live: boolean;
  unsubscribe?: () => void;
}

/** Owns exit listeners for the current PTY incarnation of each avatar.
 * Construct only behind the stations flag; nothing is allocated at module load. */
export class StationConnections {
  private connections = new Map<string, Connection>();
  private active = true;

  constructor(private options: Options) {}

  bind(agentId: string, ptyId?: string): void {
    if (!this.active) return;
    const previous = this.connections.get(agentId);
    if (previous && previous.ptyId === ptyId) return;

    // Object identity is the generation. Invalidate before unsubscribe, which
    // may flush a queued exit from the old PTY synchronously.
    const connection: Connection = { ptyId, live: !!ptyId };
    this.connections.set(agentId, connection);
    if (previous) {
      previous.live = false;
      this.unsubscribe(previous);
      if (previous.ptyId) this.options.disconnect(agentId);
    }
    if (!ptyId) {
      if (!previous) this.options.disconnect(agentId);
      return;
    }

    this.options.reconnect(agentId);
    const unsubscribe = this.options.subscribe(ptyId, () => {
      if (!this.active || !connection.live || this.connections.get(agentId) !== connection) return;
      connection.live = false;
      this.options.disconnect(agentId);
      this.unsubscribe(connection);
    });
    connection.unsubscribe = unsubscribe;
    // A provider may report an already-ended PTY inside subscribe itself.
    if (!this.active || !connection.live || this.connections.get(agentId) !== connection) this.unsubscribe(connection);
  }

  remove(agentId: string): void {
    const connection = this.connections.get(agentId);
    if (!connection) return;
    this.connections.delete(agentId);
    connection.live = false;
    this.unsubscribe(connection);
    this.options.disconnect(agentId);
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    for (const agentId of this.connections.keys()) this.remove(agentId);
  }

  private unsubscribe(connection: Connection): void {
    const unsubscribe = connection.unsubscribe;
    connection.unsubscribe = undefined;
    unsubscribe?.();
  }
}
