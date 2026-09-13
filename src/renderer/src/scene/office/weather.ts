/**
 * OFFICE WEATHER — the floor's sky as a readout of the CIRCUIT BREAKER.
 *
 * The office already had light and time of day; what it did not have was a way
 * to tell, at a glance and without reading a panel, that the guardrail is
 * holding agents back. This module is that reading. The sky is never random and
 * never decorative: it is a projection of the breaker states main already
 * broadcasts, and nothing else.
 *
 * WHERE THE DATA COMES FROM
 *   src/main/breaker.ts owns the policy (healthy → steering → constrained →
 *   stopped). Once every beat (30 s — `breakerBeatTimer` in src/main/index.ts)
 *   `runBreakerBeat` ticks it and sends ONE `BreakerState` per live, non-god
 *   agent on `control:breakerState`. The renderer already consumes that channel
 *   twice (useHive's status pin, useTelemetry's cost meter); this is a third,
 *   read-only consumer. No new IPC, no new file, no new source of truth.
 *
 * THE RULE (the whole thing)
 *   An agent is UNDER THE BREAKER when its latest level is anything other than
 *   `healthy` — i.e. the breaker is actively steering, constraining or has
 *   stopped it.
 *
 *     0 under the breaker ............................. clear
 *     1–2 under the breaker ........................... overcast
 *     3+ under the breaker, OR any agent `stopped` .... rain
 *
 *   The `stopped` clause is not an extra mood, it is the same scale read
 *   honestly: `hardStop` is OFF by default, so reaching `stopped` means a run
 *   was actually killed. One of those is a storm on its own.
 *
 * WHAT IT MUST NEVER DO
 *   Weather is an EFFECT of floor state and never a cause. Nothing here is
 *   allowed to feed back into an agent: no gating, no throttling, no status
 *   writes, no messages. Delete this module and every agent behaves identically
 *   — only the picture changes.
 *
 * FAILING CLEAR
 *   Readings expire. Main only pushes for agents that are live and unarchived,
 *   so a killed/archived agent simply stops being mentioned — if we kept its
 *   last reading the sky would stay wet forever over an empty floor. Anything
 *   older than READING_TTL_MS (three missed beats) is dropped, and callers may
 *   additionally pass the set of agents currently on the floor. Both roads lead
 *   to the same safe default: when in doubt, the sun comes out.
 *
 * Kept free of React and of Pixi (pure data in, pure enum out) so the rule above
 * is unit-testable on its own — same reasoning as legend.ts and idleAffinity.ts.
 */

/** Mirrors BreakerLevel in src/main/breaker.ts (kept in sync by hand, matching
 *  the codebase's local-redeclare pattern for cross-process contracts). */
export type BreakerLevel = 'healthy' | 'steering' | 'constrained' | 'stopped';

/** What the floor's sky can be. Ordered least → most severe. */
export type Weather = 'clear' | 'overcast' | 'rain';

/** One agent's latest breaker level, with the instant main stamped it. */
export interface BreakerReading {
  agentId: string;
  level: BreakerLevel;
  /** Epoch ms, as sent by main (`BreakerState.ts`). */
  ts: number;
}

/** The breaker beat's cadence in src/main/index.ts. */
export const BREAKER_BEAT_MS = 30_000;

/** How long a reading stays believable: three missed beats plus slack. Beyond
 *  that the agent is assumed gone (killed, archived, hive disabled) and its
 *  weather contribution lapses rather than haunting the sky. */
export const READING_TTL_MS = 3 * BREAKER_BEAT_MS + 5_000;

/** How many agents under the breaker it takes to turn overcast into rain. */
export const RAIN_AT = 3;

const LEVELS: readonly string[] = ['healthy', 'steering', 'constrained', 'stopped'];

/** Narrow an untrusted level (IPC payload, snapshot row) to a BreakerLevel.
 *  Returns null for anything unrecognized — an unknown level is not weather. */
export function asBreakerLevel(value: unknown): BreakerLevel | null {
  return typeof value === 'string' && LEVELS.includes(value) ? (value as BreakerLevel) : null;
}

/** What the sky is made of right now: the counts the rule is read from. */
export interface SkySummary {
  /** Agents whose latest fresh reading is anything but `healthy`. */
  armed: number;
  /** Of those, how many the breaker actually stopped. */
  stopped: number;
  weather: Weather;
}

/**
 * Apply the rule to a set of readings. Pure: no clock, no mutation.
 *
 * @param readings  latest reading per agent (duplicates for one agent are fine —
 *                  the last one wins, matching "latest level").
 * @param now       epoch ms used for the freshness test.
 * @param present   optional ids currently on the floor; readings for anyone else
 *                  are ignored outright (an archived agent has no weather).
 */
export function summarizeSky(
  readings: Iterable<BreakerReading>,
  now: number,
  present?: ReadonlySet<string>
): SkySummary {
  const latest = new Map<string, BreakerReading>();
  for (const r of readings) {
    if (!r || typeof r.agentId !== 'string' || !r.agentId) continue;
    if (!asBreakerLevel(r.level)) continue;
    if (!Number.isFinite(r.ts)) continue;
    if (now - r.ts >= READING_TTL_MS) continue;      // stale → lapsed
    if (present && !present.has(r.agentId)) continue; // off the floor → no weather
    latest.set(r.agentId, r);
  }
  let armed = 0;
  let stopped = 0;
  for (const r of latest.values()) {
    if (r.level === 'healthy') continue;
    armed++;
    if (r.level === 'stopped') stopped++;
  }
  const weather: Weather = armed === 0 ? 'clear'
    : (stopped > 0 || armed >= RAIN_AT) ? 'rain'
    : 'overcast';
  return { armed, stopped, weather };
}

/** The rule, when only the answer is wanted. */
export function deriveWeather(
  readings: Iterable<BreakerReading>,
  now: number,
  present?: ReadonlySet<string>
): Weather {
  return summarizeSky(readings, now, present).weather;
}

/**
 * Folds the live `control:breakerState` stream into a current sky.
 *
 * One instance per mounted floor. Holds at most one reading per agent, drops
 * stale ones on every read, and answers with an enum — it can neither reach an
 * agent nor be reached by one.
 */
export class FloorWeather {
  private readings = new Map<string, BreakerReading>();

  /** Fold one push (or one snapshot row). Malformed payloads are ignored rather
   *  than guessed at: a sky drawn from junk is worse than no sky. */
  record(state: { agentId?: unknown; level?: unknown; ts?: unknown }, now = Date.now()): void {
    const agentId = typeof state?.agentId === 'string' ? state.agentId : '';
    const level = asBreakerLevel(state?.level);
    if (!agentId || !level) return;
    const ts = typeof state?.ts === 'number' && Number.isFinite(state.ts) ? state.ts : now;
    this.readings.set(agentId, { agentId, level, ts });
  }

  /** Forget an agent outright (left the floor). */
  forget(agentId: string): void {
    this.readings.delete(agentId);
  }

  /** How many agents are currently remembered (readings not yet pruned). */
  get size(): number {
    return this.readings.size;
  }

  /** Current counts + weather, pruning anything that has lapsed. */
  summary(now = Date.now(), present?: ReadonlySet<string>): SkySummary {
    for (const [id, r] of this.readings) {
      if (now - r.ts >= READING_TTL_MS || (present && !present.has(id))) this.readings.delete(id);
    }
    return summarizeSky(this.readings.values(), now, present);
  }

  /** Current weather. */
  weather(now = Date.now(), present?: ReadonlySet<string>): Weather {
    return this.summary(now, present).weather;
  }
}
