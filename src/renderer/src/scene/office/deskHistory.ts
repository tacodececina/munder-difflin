/**
 * DESK HISTORY — every desk on the floor slowly becomes a record of what the
 * agent sitting at it has actually finished.
 *
 * The rule is deliberately small and deliberately honest. There is exactly ONE
 * input: the number of cards in `hive/tasks.json` that are `status: 'done'` and
 * carry this agent's id as `assignee`. That is the same ledger the wall boards,
 * the archive pile and the boss-aura suck-up lines already read (see
 * OfficeFloor.tsx's `pollTaskBoard` / `doneByAssignee`), so a desk can never
 * show a trophy for work the board does not also show as closed.
 *
 * Nothing here is random, cosmetic-only or per-session: reload the app, switch
 * themes, restart the machine — the desk redraws to the same state, because the
 * state IS the ledger. An agent that has closed nothing sits at a bare desk, and
 * that is the point. A fresh hire should look like a fresh hire.
 *
 * THE LADDER
 *   1st closure   → a stack of paper            (you shipped something)
 *   2nd           → a small desk plant          (you've been here a while)
 *   3rd           → a framed photo              (you're settled in)
 *   5th           → a taller plant
 *   8th           → a trophy
 *
 * Five milestones, not one per closure: a desk fills up over a long stretch of
 * real work and then STOPS, so a veteran's desk is visibly richer than a new
 * hire's without twenty agents turning the floor into a junk shop. Past the last
 * milestone the only thing that keeps growing is the paper stack, one sheet per
 * further closure up to `MAX_SHEETS` — a quiet "still going" that costs no extra
 * floor space.
 *
 * Kept free of React and of Pixi (numbers in, plain data out) so the ladder is
 * unit-testable on its own — same reasoning as `weather.ts` and `legend.ts`.
 * `DeskShelf.ts` is the only thing that knows how any of this is drawn.
 */

/** The trinkets a desk can accumulate, in unlock order. */
export type DeskPropKind = 'papers' | 'plant' | 'photo' | 'plantBig' | 'trophy';

/** How many closed tasks each prop costs. Ascending, one entry per prop. */
export const DESK_PROP_LADDER: ReadonlyArray<{ readonly at: number; readonly kind: DeskPropKind }> = [
  { at: 1, kind: 'papers' },
  { at: 2, kind: 'plant' },
  { at: 3, kind: 'photo' },
  { at: 5, kind: 'plantBig' },
  { at: 8, kind: 'trophy' }
];

/** Hard ceiling on props per desk — the ladder's own length. The renderer lays
 *  them out along a 16px desk tile, so this is a layout guarantee, not a taste
 *  call: more props than this would not fit without covering the keyboard. */
export const MAX_DESK_PROPS = DESK_PROP_LADDER.length;

/** Sheets the paper stack can reach before it, too, stops growing. */
export const MAX_SHEETS = 4;

/** What one desk should be showing. */
export interface DeskHistory {
  /** Closed cards credited to this agent — the raw number the rest derives from. */
  done: number;
  /** Unlocked props, in unlock order. Never longer than `MAX_DESK_PROPS`. */
  props: readonly DeskPropKind[];
  /** Height of the paper stack, 0 when no paper is unlocked yet. */
  sheets: number;
}

/** An empty desk — the state every agent starts at, and the state anything
 *  unknown or malformed falls back to. */
export const EMPTY_DESK: DeskHistory = { done: 0, props: [], sheets: 0 };

function cleanCount(done: unknown): number {
  if (typeof done !== 'number' || !Number.isFinite(done) || done <= 0) return 0;
  return Math.floor(done);
}

/**
 * Fold a closed-task count into the desk it earns. Monotonic by construction:
 * a higher count never removes a prop, so a desk only ever gains.
 */
export function deskHistoryFor(done: unknown): DeskHistory {
  const n = cleanCount(done);
  if (n === 0) return EMPTY_DESK;
  const props: DeskPropKind[] = [];
  for (const step of DESK_PROP_LADDER) {
    if (n >= step.at) props.push(step.kind);
  }
  // The stack starts at one sheet with the first closure and gains one more per
  // closure past the final milestone, so the visible growth never fully stops
  // while the ladder itself stays capped.
  const last = DESK_PROP_LADDER[DESK_PROP_LADDER.length - 1].at;
  const extra = Math.max(0, n - last);
  const sheets = props.includes('papers') ? Math.min(MAX_SHEETS, 1 + extra) : 0;
  return { done: n, props, sheets };
}

/** True when `a` and `b` would draw identically — lets the renderer skip a
 *  repaint on the (very common) poll that changed nothing. */
export function sameDesk(a: DeskHistory, b: DeskHistory): boolean {
  if (a.sheets !== b.sheets || a.props.length !== b.props.length) return false;
  for (let i = 0; i < a.props.length; i++) if (a.props[i] !== b.props[i]) return false;
  return true;
}

/** The subset of a ledger card this module reads. */
export interface DeskLedgerCard {
  status?: unknown;
  assignee?: unknown;
}

/**
 * Count closed cards per assignee out of a raw `hive/tasks.json` card list.
 *
 * Defensive on purpose — the ledger is a hand-editable JSON file, and a card
 * with a missing/blank assignee belongs to nobody rather than to a desk.
 */
export function countDoneByAssignee(
  cards: readonly DeskLedgerCard[] | null | undefined
): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(cards)) return out;
  for (const card of cards) {
    if (!card || card.status !== 'done') continue;
    const who = typeof card.assignee === 'string' ? card.assignee.trim() : '';
    if (!who) continue;
    out.set(who, (out.get(who) ?? 0) + 1);
  }
  return out;
}
