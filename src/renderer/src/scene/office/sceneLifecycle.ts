type Timer = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

export interface SceneLifecycle {
  readonly generation: number;
  /** Issue a token for one async channel; only its newest token remains valid. */
  issue(channel: string): number;
  isCurrent(channel: string, token: number): boolean;
  /** Invalidate pending responses for one channel without touching other work. */
  invalidate(channel: string): void;
  timeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  interval(callback: () => void, everyMs: number): ReturnType<typeof setInterval>;
  clear(timer: Timer): void;
  dispose(): void;
}

/**
 * Small ownership boundary for scene timers and asynchronous callbacks. The
 * floor can rebuild or disappear while IPC, CI, texture and choreography work
 * is still in flight; every callback must be owned by this lifecycle.
 */
export function createSceneLifecycle(generation: number): SceneLifecycle {
  let active = true;
  let sequence = 0;
  const channels = new Map<string, number>();
  const timers = new Set<Timer>();

  const issue = (channel: string): number => {
    const token = ++sequence;
    channels.set(channel, token);
    return token;
  };
  const isCurrent = (channel: string, token: number): boolean =>
    active && channels.get(channel) === token;
  const invalidate = (channel: string): void => {
    channels.set(channel, ++sequence);
  };
  const track = <T extends Timer>(timer: T): T => {
    timers.add(timer);
    return timer;
  };
  const timeout = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    let timer: ReturnType<typeof setTimeout>;
    timer = setTimeout(() => {
      timers.delete(timer);
      if (active) callback();
    }, delayMs);
    return track(timer);
  };
  const interval = (callback: () => void, everyMs: number): ReturnType<typeof setInterval> => {
    let timer: ReturnType<typeof setInterval>;
    timer = setInterval(() => { if (active) callback(); }, everyMs);
    return track(timer);
  };
  const clear = (timer: Timer): void => {
    clearTimeout(timer);
    clearInterval(timer);
    timers.delete(timer);
  };
  const dispose = (): void => {
    if (!active) return;
    active = false;
    ++sequence;
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    timers.clear();
  };

  return { generation, issue, isCurrent, invalidate, timeout, interval, clear, dispose };
}
