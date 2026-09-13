/**
 * THE FLOOR'S LEGEND — a mythology the floor writes about itself.
 *
 * Every entry on this wall is a real, closed piece of work. Nothing here is
 * authored, templated, scored by a model, or invented: the whole list is a
 * PROJECTION of two files the hive already keeps, computed at read time.
 *
 *   - `hive/log.jsonl` — the append-only event feed. Main appends one
 *     `{ kind:'task_done', ts, taskId, title, assignee, from }` row each time it
 *     OBSERVES a card cross into `done` (HiveManager.observeTaskCompletions).
 *     That row is the durable record of the closure: it carries the title and
 *     the closer as they were at that moment, and it survives the card later
 *     being renamed, reassigned, or dismissed off the board.
 *   - `hive/tasks.json` — the live ledger. Used only as a FALLBACK, for cards
 *     that are `done` but have no event: closures that predate the observer, or
 *     that scrolled out of the log window we read. Those keep their title and
 *     closer but have no honest timestamp, and are shown without one rather
 *     than given a made-up date.
 *
 * No new file, no new store, no duplicated source of truth — delete this module
 * and nothing about the hive changes.
 *
 * Kept free of React and of the store (pure data in, pure data out) so the
 * derivation rules are unit-testable on their own — same reasoning as
 * `dundiesStats.ts` and `memoryGraph/buildGraph.ts`.
 */

/** How many consecutive closures by one agent make the streak worth calling out. */
export const STREAK_MILESTONE = 3;

/** One `task_done` row, after validation. `at` is the log row's own `ts`. */
export interface TaskDoneEvent {
  taskId: string;
  at: number;
  title: string;
  /** Agent id the card was assigned to when it closed; absent if nobody owned it. */
  who?: string;
}

/** The subset of a ledger card this module reads (see `parseTasks`). */
export interface LegendCard {
  id: string;
  title: string;
  assignee?: string;
  status: string;
}

/** One line on the wall. */
export interface LegendEntry {
  /** Task id — the join key between the log event and the ledger card. */
  id: string;
  title: string;
  /** Agent id that closed it, unresolved (the panel maps it to a display name
   *  through the same roster lookup the kanban uses). */
  who?: string;
  /** When the closure was recorded, epoch ms. Absent for a card whose closure
   *  the log never witnessed — the panel says so instead of guessing. */
  at?: number;
  /** 1-based position in the floor's history of witnessed closures. `1` is the
   *  first thing this floor ever finished. Absent when `at` is. */
  ordinal?: number;
  /** Length of the run of consecutive closures by `who` ending at this entry.
   *  1 for a lone closure (and for every untimed entry, which has no position
   *  in the sequence to form a run with). */
  streak: number;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Pull the valid `task_done` rows out of a raw `hiveLog()` payload.
 *
 * Defensive by design: `log.jsonl` is append-only and hand-inspectable, a line
 * that failed to parse comes back as `{ raw }`, and older rows predate this
 * event kind entirely. Anything without both a task id and a numeric timestamp
 * is dropped rather than repaired — a legend entry with an invented time would
 * be exactly the fiction this wall exists to avoid.
 */
export function readTaskDoneEvents(log: unknown): TaskDoneEvent[] {
  const rows = Array.isArray(log) ? log : [];
  const out: TaskDoneEvent[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const event = row as Record<string, unknown>;
    if (event.kind !== 'task_done') continue;
    const taskId = text(event.taskId);
    const at = typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : undefined;
    if (!taskId || at === undefined) continue;
    out.push({ taskId, at, title: text(event.title) ?? '(untitled)', who: text(event.assignee) });
  }
  return out;
}

/**
 * Build the wall: witnessed closures newest first, then the undated ones.
 *
 * A card can legitimately be reopened and closed again, so the LATEST event per
 * task id wins — one card is one legend entry, dated by its most recent close.
 *
 * @param log   raw payload from `window.cth.hiveLog(n)`.
 * @param cards the current ledger (any status; only `done` cards are read).
 */
export function buildLegend(log: unknown, cards: LegendCard[]): LegendEntry[] {
  const latest = new Map<string, TaskDoneEvent>();
  for (const event of readTaskDoneEvents(log)) {
    const prev = latest.get(event.taskId);
    if (!prev || event.at >= prev.at) latest.set(event.taskId, event);
  }

  // Oldest first so ordinals and streaks are counted in the order the work
  // actually happened; the id tiebreak keeps two same-millisecond closures in a
  // stable order across polls (no key churn, no flickering ordinals).
  const timeline = [...latest.values()].sort((a, b) => a.at - b.at || a.taskId.localeCompare(b.taskId));

  const witnessed: LegendEntry[] = [];
  let run = 0;
  let previousWho: string | undefined;
  timeline.forEach((event, index) => {
    run = event.who && event.who === previousWho ? run + 1 : 1;
    previousWho = event.who;
    witnessed.push({
      id: event.taskId,
      title: event.title,
      who: event.who,
      at: event.at,
      ordinal: index + 1,
      streak: run
    });
  });

  // One card is one entry, and `id` is the React key the panel renders with — so
  // a ledger that repeats an id must not produce two rows. `tasks.json` is
  // documented as hand-editable, which is exactly how a duplicate id gets in;
  // the hive's own observer defends against the same case with a "first card
  // wins" guard (hive.ts observeTaskCompletions), and this follows that rule so
  // the two never disagree about which copy is the real one.
  const seen = new Set<string>();
  const undated: LegendEntry[] = [];
  for (const card of cards) {
    if (!card || card.status !== 'done' || !card.id) continue;
    if (latest.has(card.id) || seen.has(card.id)) continue;
    seen.add(card.id);
    undated.push({
      id: card.id,
      title: text(card.title) ?? '(untitled)',
      who: text(card.assignee),
      streak: 1
    });
  }

  return [...witnessed.reverse(), ...undated];
}

/** The longest run of consecutive closures by one agent, across the whole wall.
 *  0 when nothing has been witnessed yet. */
export function longestStreak(entries: LegendEntry[]): number {
  return entries.reduce((best, entry) => (entry.at === undefined ? best : Math.max(best, entry.streak)), 0);
}
