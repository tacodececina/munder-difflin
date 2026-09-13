/**
 * "Dundies" end-of-day recap stats: how long each agent spent doing real work
 * this session, and (via the tasks board, read separately by the modal) how
 * many tasks got closed. This module only owns the active-time half.
 *
 * Kept out of the store, and structural rather than typed against the real
 * `Agent`, so the rules below are testable without dragging zustand into a
 * unit test — same reasoning as `focusMode.ts`. `store.ts` owns the one
 * long-lived `DundiesTrackState` instance and feeds it a snapshot on every
 * `updateAgent` call; this file only knows how to fold a snapshot in.
 *
 * No persistence: the tracker starts empty when the module first loads and
 * lives only in memory, so a fresh app launch is a fresh "day" on the floor —
 * which is exactly the framing the closing-time recap wants.
 */
import type { StatusKind } from '@/components/PixelBadge';

/** The subset of an agent this module needs. */
export interface DundiesAgentSnapshot {
  id: string;
  name: string;
  status: StatusKind;
}

/** Statuses that count as "actively working" for the recap — mirrors
 *  OfficeFloor.tsx's own `isBusy` check (used for the on-floor cheer /
 *  attention-semaphore feature), so "active time" means the same thing here
 *  as it already does elsewhere in the app. */
export const DUNDIES_BUSY_STATUSES: ReadonlySet<StatusKind> = new Set(['working', 'thinking', 'compacting']);

interface AgentTrack { name: string; status: StatusKind; since: number; activeMs: number; }

/** Opaque tracking state — one long-lived instance per renderer session. */
export type DundiesTrackState = Map<string, AgentTrack>;

export function createDundiesTrackState(): DundiesTrackState {
  return new Map();
}

/**
 * Record one agent's current (id, name, status) at time `now`, folding
 * elapsed busy time into its running total whenever the status actually
 * changed since the last call. Safe to call on every store update, including
 * ones that never touch status: a same-status call is a cheap no-op beyond
 * the Map lookup, so `updateAgent` (also the per-PTY-chunk hot path) can call
 * this unconditionally.
 */
export function noteDundiesAgent(state: DundiesTrackState, snap: DundiesAgentSnapshot, now: number): void {
  const t = state.get(snap.id);
  if (!t) {
    state.set(snap.id, { name: snap.name, status: snap.status, since: now, activeMs: 0 });
    return;
  }
  if (t.status !== snap.status) {
    if (DUNDIES_BUSY_STATUSES.has(t.status)) t.activeMs += Math.max(0, now - t.since);
    t.status = snap.status;
    t.since = now;
  }
  t.name = snap.name;
}

export interface DundiesAgentStat { id: string; name: string; activeMs: number; }

/**
 * Snapshot for the recap modal, most active first. Folds in time spent in the
 * CURRENT status up to `now` — without this, an agent still mid-task at the
 * exact moment the recap opens would read as having done nothing all day.
 * Does not mutate `state`.
 */
export function dundiesStatsSnapshot(state: DundiesTrackState, now: number): DundiesAgentStat[] {
  const out: DundiesAgentStat[] = [];
  for (const [id, t] of state) {
    const live = DUNDIES_BUSY_STATUSES.has(t.status) ? Math.max(0, now - t.since) : 0;
    out.push({ id, name: t.name, activeMs: t.activeMs + live });
  }
  return out.sort((a, b) => b.activeMs - a.activeMs);
}

/** Format a millisecond duration for the recap UI: "2h 14m", "9m", or "<1m". */
export function formatDundiesDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
