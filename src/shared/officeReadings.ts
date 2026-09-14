/**
 * A read-layer answer that keeps the time of the attempt separate from the
 * time of the last value that actually parsed. A caller may hold `value` while
 * the source is unavailable, but it must never present that held value as a
 * freshly read answer.
 */
export type OfficeReadingAvailability = 'available' | 'unavailable';

/** A parsed JSON document is not necessarily a task ledger. */
export function isTaskLedger(value: unknown): value is { tasks: unknown[] } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray((value as { tasks?: unknown }).tasks);
}

export interface OfficeReading<T> {
  /** What system produced the answer, not a human-readable interpretation. */
  source: string;
  /** The bounded subject of the answer; never a secret or a prompt. */
  scope: string;
  /** The current answer, or the last valid answer held by the source. */
  value: T | null;
  /** When the source was last asked, including failed/corrupt reads. */
  lastAccessedAt: number | null;
  /** When `value` last parsed and passed the source's read boundary. */
  lastValidAt: number | null;
  /** Whether the current access produced a valid answer. */
  availability: OfficeReadingAvailability;
}
