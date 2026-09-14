export interface SpawnContext<Seat> {
  readonly id: string;
  readonly generation: number;
  readonly seat: Seat;
  isCurrent(): boolean;
}

export interface SpawnCoordinatorOptions<Item, Seat, Built> {
  keyOf(item: Item): string;
  reserve(item: Item): Seat | undefined;
  release(seat: Seat): void;
  build(item: Item, context: SpawnContext<Seat>): Promise<Built>;
  attach(item: Item, built: Built, context: SpawnContext<Seat>): void;
  detach?(id: string): void;
  discard?(built: Built): void;
  onError?(error: unknown, id: string): void;
}

export interface SpawnCoordinator<Item> {
  sync(items: readonly Item[]): void;
  remove(id: string): void;
  teardown(): void;
  has(id: string): boolean;
}

interface SpawnRecord<Item, Seat> {
  item: Item;
  generation: number;
  seat: Seat;
  attached: boolean;
  released: boolean;
}

export function createSpawnCoordinator<Item, Seat, Built>(
  options: SpawnCoordinatorOptions<Item, Seat, Built>
): SpawnCoordinator<Item> {
  const records = new Map<string, SpawnRecord<Item, Seat>>();
  let nextGeneration = 0;
  let tornDown = false;

  const isCurrent = (id: string, record: SpawnRecord<Item, Seat>): boolean =>
    !tornDown && records.get(id) === record;

  const release = (record: SpawnRecord<Item, Seat>): void => {
    if (record.released) return;
    record.released = true;
    options.release(record.seat);
  };

  const remove = (id: string): void => {
    const record = records.get(id);
    if (!record) return;
    records.delete(id);
    let detachError: unknown;
    try {
      if (record.attached) options.detach?.(id);
    } catch (error) {
      detachError = error;
    }
    release(record);
    if (detachError !== undefined) options.onError?.(detachError, id);
  };

  const start = (item: Item, id: string): void => {
    let seat: Seat | undefined;
    try {
      seat = options.reserve(item);
    } catch (error) {
      options.onError?.(error, id);
      return;
    }
    if (seat === undefined) return;
    const generation = ++nextGeneration;
    const record: SpawnRecord<Item, Seat> = {
      item, generation, seat, attached: false, released: false
    };
    records.set(id, record);
    const context: SpawnContext<Seat> = {
      id,
      generation,
      seat,
      isCurrent: () => isCurrent(id, record)
    };

    let pending: Promise<Built>;
    try {
      pending = options.build(item, context);
    } catch (error) {
      if (isCurrent(id, record)) records.delete(id);
      release(record);
      options.onError?.(error, id);
      return;
    }
    void pending.then((built) => {
      if (!isCurrent(id, record)) {
        options.discard?.(built);
        return;
      }
      try {
        // Mark it first: attach is allowed to synchronously remove this id, and
        // that removal must run detach before the seat can be reused.
        record.attached = true;
        options.attach(record.item, built, context);
      } catch (error) {
        if (isCurrent(id, record)) remove(id);
        else release(record);
        options.discard?.(built);
        options.onError?.(error, id);
      }
    }, (error) => {
      if (!isCurrent(id, record)) return;
      records.delete(id);
      release(record);
      options.onError?.(error, id);
    });
  };

  return {
    sync(items) {
      if (tornDown) return;
      const desired = new Map<string, Item>();
      for (const item of items) desired.set(options.keyOf(item), item);
      for (const id of records.keys()) {
        if (!desired.has(id)) remove(id);
      }
      for (const [id, item] of desired) {
        const record = records.get(id);
        if (record) record.item = item;
        else start(item, id);
      }
    },
    remove,
    teardown() {
      if (tornDown) return;
      tornDown = true;
      for (const id of [...records.keys()]) remove(id);
      records.clear();
    },
    has(id) {
      return records.has(id);
    }
  };
}
