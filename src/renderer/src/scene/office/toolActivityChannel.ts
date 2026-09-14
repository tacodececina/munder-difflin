import type { HookEvent } from '@shared/hookEvents';

// No listener collection, history, timers or IPC while the feature is off.
let listeners: Set<(event: HookEvent) => void> | null = null;
export function observeParserTool(event: HookEvent): void {
  listeners?.forEach((listener) => listener(event));
}
export function subscribeParserTools(listener: (event: HookEvent) => void): () => void {
  (listeners ??= new Set()).add(listener);
  return () => { listeners?.delete(listener); if (!listeners?.size) listeners = null; };
}
