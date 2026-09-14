import type { OfficeReading } from '@shared/officeReadings';
import type { Held } from './wallReadout';

export interface VisibleLedgerTask {
  id: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  assignee?: string;
  humanQA?: Array<{ q?: string; a?: string }>;
}

/** A canvas without provenance labels must not keep stale or guessed cards. */
export function visibleTaskLedger(
  reading: OfficeReading<unknown> | null | undefined, now: number, ttl: number
): VisibleLedgerTask[] | null {
  if (readingState(reading, now, ttl) !== 'available') return null;
  const value = reading?.value;
  if (!value || typeof value !== 'object' || !Array.isArray((value as { tasks?: unknown }).tasks)) return null;
  const tasks = (value as { tasks: unknown[] }).tasks;
  if (!tasks.every((task) => {
    if (!task || typeof task !== 'object') return false;
    const row = task as Record<string, unknown>;
    return typeof row.id === 'string' && !!row.id
      && typeof row.status === 'string' && ['todo', 'doing', 'blocked', 'done'].includes(row.status);
  })) return null;
  return tasks as VisibleLedgerTask[];
}

/** Convert a main-process reading into the existing TTL-held wall primitive. */
export function heldFromReading<T>(reading: OfficeReading<T> | null | undefined): Held<T> | null {
  if (!reading || reading.value === null || reading.lastValidAt === null
    || !Number.isFinite(reading.lastValidAt)) return null;
  return { value: reading.value, at: reading.lastValidAt };
}

export type FloorReadingState = 'available' | 'unavailable' | 'expired';

/**
 * The source's availability is separate from freshness. A recent held value
 * may still be painted after a transient failure, but it is never reported as
 * an available source; once its TTL lapses it becomes NO DATA.
 */
export function readingState<T>(
  reading: OfficeReading<T> | null | undefined,
  now: number,
  ttl: number
): FloorReadingState {
  if (!reading || reading.lastValidAt === null || !Number.isFinite(reading.lastValidAt)) {
    return 'unavailable';
  }
  if (now - reading.lastValidAt >= ttl) return 'expired';
  return reading.availability === 'available' ? 'available' : 'unavailable';
}
