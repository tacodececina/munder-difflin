/**
 * Idle-time company seeking — who an agent drifts toward while it has nothing
 * to do.
 *
 * Phase 2 made affinity visible in WHO SITS WITH WHOM at the café (see
 * `startBreak` in OfficeFloor.tsx). This is the same idea one step earlier: on
 * a quiet floor, an agent with no task wanders, and who it wanders NEAR is no
 * longer uniform noise — it leans toward the colleagues it reads warmly and
 * keeps its distance from open friction.
 *
 * The read is DIRECTIONAL, deliberately and in the same way the seat pick is:
 * the only thing that decides whether A drifts toward B is how **A** reads B.
 * B may have gone quietly cold; A still keeps turning up. That unrequited case
 * is the whole reason the relationship book is keyed by an ordered (from → to)
 * edge — see src/main/officeRel.ts.
 *
 * This module is deliberately pure (no pixi, no store, no IPC): it takes the
 * candidate list a caller already filtered for "free to wander right now" plus
 * the directed relationship reads, and returns a choice. That keeps the social
 * rule unit-testable without a GPU — the scene only supplies positions.
 *
 * FEATURE FLAG: like everything else in the relationship experiment, the caller
 * gates this behind `officeChatterEnabled`. With the toggle off nothing here is
 * ever called and wandering stays exactly the pre-experiment random walk.
 */

/** One direction of the relationship book: how the wanderer reads a candidate. */
export interface DirectedRelRead {
  /** -1..1 — affection ↔ dislike. */
  warmth: number;
  /** 0..1 — live friction. */
  tension: number;
  /** 0..1 — shared history. */
  familiarity: number;
}

export interface CompanionCandidate {
  id: string;
  /** How the WANDERER reads this candidate (from → to). Absent = strangers. */
  rel?: DirectedRelRead;
}

export interface CompanionChoice {
  id: string;
  /** 0..1 — how often a wander waypoint should be steered toward them. */
  pull: number;
}

/** Below this warmth there is no affinity to express — the agent just roams. */
export const IDLE_MIN_WARMTH = 0.15;
/** Open friction: this much tension with no warmth to soften it means the
 *  wanderer would rather be elsewhere, so the candidate is dropped entirely. */
export const IDLE_AVOID_TENSION = 0.55;
export const IDLE_AVOID_WARMTH = 0.15;
/** Odds of seeking anyone at all, before the warmest candidate raises them. */
export const IDLE_SEEK_BASE_ODDS = 0.35;
export const IDLE_SEEK_WARMTH_BONUS = 0.35;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Weight one candidate exactly the way the café seat pick weights a table-mate
 * (`1 + warmth * 2.5 + familiarity`) so both behaviours read as one temperament
 * rather than two unrelated heuristics.
 */
export function companionWeight(rel: DirectedRelRead): number {
  return 1 + Math.max(0, rel.warmth) * 2.5 + Math.max(0, rel.familiarity);
}

/** How strongly a chosen companion bends the wander — warmer pulls harder. */
export function companionPull(rel: DirectedRelRead): number {
  return clamp01(0.35 + Math.max(0, rel.warmth) * 0.65);
}

/**
 * Pick who (if anyone) this agent drifts toward for its next stretch of idling.
 *
 * Returns null when nobody on the floor is warm enough to be worth crossing the
 * room for, or when the roll simply says "not this time" — an idle agent that
 * likes everyone should still spend plenty of time wandering alone.
 *
 * `rand` is injectable so the rule can be tested deterministically.
 */
export function pickIdleCompanion(
  candidates: readonly CompanionCandidate[],
  rand: () => number = Math.random
): CompanionChoice | null {
  const pool: Array<{ id: string; weight: number; pull: number }> = [];
  let warmest = 0;
  for (const c of candidates) {
    const rel = c.rel;
    if (!rel) continue;                               // strangers exert no pull
    // Open friction with nothing warm behind it: give them the other end of
    // the floor. Unlike the café seat pick this is a hard skip rather than a
    // 70% one — there is no scarcity here forcing a choice, so "keep away"
    // can simply mean keep away.
    if (rel.tension >= IDLE_AVOID_TENSION && rel.warmth < IDLE_AVOID_WARMTH) continue;
    if (rel.warmth < IDLE_MIN_WARMTH) continue;       // indifference → no pull
    pool.push({ id: c.id, weight: companionWeight(rel), pull: companionPull(rel) });
    warmest = Math.max(warmest, rel.warmth);
  }
  if (pool.length === 0) return null;
  // Deep affinity shows over time: the warmest colleague on the floor raises
  // the odds this agent goes looking for company at all.
  const odds = IDLE_SEEK_BASE_ODDS + Math.min(1, warmest) * IDLE_SEEK_WARMTH_BONUS;
  if (rand() >= odds) return null;
  let total = 0;
  for (const p of pool) total += p.weight;
  let roll = rand() * total;
  for (const p of pool) {
    roll -= p.weight;
    if (roll <= 0) return { id: p.id, pull: p.pull };
  }
  const last = pool[pool.length - 1];
  return { id: last.id, pull: last.pull };
}
