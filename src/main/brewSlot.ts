/**
 * BrewSlot — the ONE hidden-Claude "cook ahead" slot every office decoration
 * shares.
 *
 * WHY IT EXISTS. `officeChat.ts` grew a careful little machine around its
 * break-room dialogue: never more than one hidden session in flight, a floor on
 * the gap between brews, a rolling-hour cap, a per-subject cooldown, a hard
 * timeout with exactly ONE short retry, and an abort handle so a brew can never
 * outlive the process that spawned it. That machine is not about café dialogue
 * at all — it is about spending a background Claude session safely. The moment a
 * SECOND decoration wanted the same trick (persona flavour on real work
 * messages, see officeVoice.ts) the "one in flight, ever" invariant stopped
 * being something one class could enforce on its own: two directors with two
 * private budgets are two concurrent hidden sessions.
 *
 * So the machine moved here and is shared. Global rules live on the slot:
 *   • one hidden session in flight across ALL lanes, ever
 *   • one abort handle, so `stop()` kills whatever is cooking
 * Per-feature rules live on a LANE (`LaneLimits`), so the café's budget and the
 * work-message flavour budget stay independently tunable and one cannot starve
 * the other's accounting — they just queue behind the same slot.
 *
 * Everything here is inert until someone calls `run`. The callers gate that on
 * their own feature flag; the slot has no opinion about flags.
 */
import { runHiddenClaude } from './hiddenClaude';

export interface BrewSlotDeps {
  /** The hive home to run the hidden session in; null → nothing can brew. */
  getHome: () => string | null;
  /** The agent CLI command (e.g. 'claude'). */
  getCommand: () => string;
}

/** One feature's spend envelope. Deliberately per-lane: a decoration must never
 *  be able to eat another decoration's budget, only its turn at the slot. */
export interface LaneLimits {
  /** Minimum time between two brews in this lane. */
  minGapMs: number;
  /** Rolling-hour ceiling for this lane. */
  maxPerHour: number;
  /** Minimum time between two brews for the SAME subject key in this lane
   *  (a pair, an agent — whatever the lane keys on). */
  keyCooldownMs: number;
}

/** First attempt's ceiling. Was 120s once, which let one wedged hidden session
 *  hold the slot for two minutes and then yield nothing at all. */
export const BREW_TIMEOUT_MS = 25_000;
/** The single retry is tighter still — if the first session hung, the second is
 *  a long shot and must not re-spend the slot. */
export const BREW_RETRY_TIMEOUT_MS = 20_000;
/** Breath between the two attempts, so a transient spawn failure isn't retried
 *  into the same bad moment. */
export const BREW_RETRY_DELAY_MS = 1_500;

/** Tools a brew may never reach for. Ambient flavour text has no business
 *  editing the user's repo or running commands. */
const BREW_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'];

const HOUR_MS = 3_600_000;

/** A sleep that resolves early when the brew is aborted (app quit / home
 *  change), so `stop()` is never delayed by the retry gap. */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const done = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

interface LaneState {
  lastAt: number;
  /** Start times inside the rolling hour. */
  times: number[];
  /** Subject key → when it last brewed. */
  keys: Map<string, number>;
}

export interface BrewRequest<T> {
  /** Which budget this brew spends. Free-form; one string per feature. */
  lane: string;
  limits: LaneLimits;
  /** The subject this brew is "about" — the per-key cooldown is keyed on it. */
  key: string;
  prompt: string;
  model: string;
  /** Turns the model's raw reply into the shape the caller wanted. Returning
   *  null means "unusable" and is treated exactly like a failed session — i.e.
   *  it earns the one retry. */
  parse: (text: string) => T | null;
}

export class BrewSlot {
  /** True from the synchronous start of `run` until that brew settles. Set
   *  before the first `await` so two calls in the same tick cannot both pass. */
  private inFlight = false;
  /** The in-flight brew's cancel handle, if any — see stop(). */
  private active: AbortController | null = null;
  private lanes = new Map<string, LaneState>();

  constructor(private deps: BrewSlotDeps) {}

  /** Is a brew cooking right now? */
  get busy(): boolean {
    return this.inFlight;
  }

  /** Kill any in-flight brew's hidden Claude PTY immediately, and short-circuit
   *  the wait between the two attempts. Called on app quit / home change /
   *  reset so a brew never outlives the process that spawned it. Safe to call
   *  when nothing is brewing; idempotent. */
  stop(): void {
    this.active?.abort();
    this.active = null;
  }

  /** Would a brew be allowed right now? Read-only — calling it never consumes
   *  budget, so a caller can pre-check before doing expensive prompt work. */
  allows(lane: string, limits: LaneLimits, key: string): boolean {
    if (this.inFlight) return false;
    if (!this.deps.getHome()) return false;
    const now = Date.now();
    const st = this.lanes.get(lane);
    if (!st) return true;
    if (now - st.lastAt < limits.minGapMs) return false;
    if (st.times.filter((t) => now - t < HOUR_MS).length >= limits.maxPerHour) return false;
    if (now - (st.keys.get(key) ?? 0) < limits.keyCooldownMs) return false;
    return true;
  }

  /**
   * Spend the slot on one brew: an attempt, then at most ONE short retry. A
   * hidden session that wedges, dies at spawn, or answers in an unparseable
   * shape is cut off at BREW_TIMEOUT_MS and tried once more before the caller
   * settles for whatever its fallback is.
   *
   * Resolves to null (never throws) when the budget refuses, when there is no
   * home, or when both attempts come up empty — callers cannot tell those apart
   * on purpose: in every case there is simply nothing to show.
   */
  async run<T>(req: BrewRequest<T>): Promise<T | null> {
    // Everything up to the first `await` runs synchronously, which is what makes
    // the "one in flight, ever" claim true for callers in the same tick.
    if (!this.allows(req.lane, req.limits, req.key)) return null;
    const home = this.deps.getHome();
    if (!home) return null;
    const now = Date.now();
    const st = this.lanes.get(req.lane) ?? { lastAt: 0, times: [], keys: new Map<string, number>() };
    st.lastAt = now;
    st.times = st.times.filter((t) => now - t < HOUR_MS);
    st.times.push(now);
    st.keys.set(req.key, now);
    this.lanes.set(req.lane, st);
    this.inFlight = true;
    const controller = new AbortController();
    this.active = controller;

    const attempt = async (timeoutMs: number): Promise<T | null> => {
      const res = await runHiddenClaude(req.prompt, {
        model: req.model,
        cwd: home,
        command: this.deps.getCommand(),
        disallowedTools: BREW_DISALLOWED_TOOLS,
        timeoutMs,
        signal: controller.signal
      });
      if (!res.ok || !res.text) return null;
      return req.parse(res.text);
    };

    try {
      try {
        const first = await attempt(BREW_TIMEOUT_MS);
        if (first) return first;
      } catch { /* fall through to the retry */ }
      // A deliberate abort (quit / home change / reset) is not a failure to retry.
      if (controller.signal.aborted) return null;
      await abortableDelay(BREW_RETRY_DELAY_MS, controller.signal);
      if (controller.signal.aborted) return null;
      try { return await attempt(BREW_RETRY_TIMEOUT_MS); } catch { return null; }
    } finally {
      this.inFlight = false;
      if (this.active === controller) this.active = null;
    }
  }
}
