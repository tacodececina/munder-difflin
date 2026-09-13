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
 *
 * TWO ROUTES, ONE SET OF GUARANTEES (v0.4.7). The slot originally knew exactly
 * one way to reach a model: `runHiddenClaude`, i.e. the user's own `claude` CLI
 * — the SAME subscription the agents doing real work draw on. So a chatty office
 * took resources from the agents resolving real incidents, which is precisely
 * what a decoration must never do. The slot can now also brew over plain HTTP
 * against any OpenAI-compatible `/chat/completions` endpoint (DeepSeek, MiniMax,
 * opencode-go, Ollama, LM Studio — see chatterOpenAI.ts), selected purely by
 * configuration (`chatterProvider`). The route is an implementation detail of
 * `attempt()`: EVERY promise the slot already made is unchanged and applies to
 * both routes identically —
 *   • one brew in flight across all lanes, ever
 *   • a hard timeout per attempt, and exactly ONE shorter retry
 *   • abortable by quit / home change / reset, including mid-request
 *   • per-lane gap / hourly / per-key budgets
 * and one guarantee is ADDED, shared by both routes: a rolling-hour TOKEN
 * ceiling (`ChatterTokenLedger`), so "how many brews" is no longer the only
 * thing bounding what the decoration spends.
 *
 * CAN THE CHATTER STARVE ANYTHING ELSE? (verified v0.4.8, when the café gained
 * continuity and work context and its prompts got longer.)
 *   • This slot has exactly two users, officeChat and officeVoice — both
 *     chatter, both behind the same flag. No feature that does real work takes
 *     a turn here, so there is nothing on this slot for the chatter to crowd
 *     out. The lanes bound the two decorations against EACH OTHER: 8 café
 *     brews/hour and 6 voice brews/hour, and `allows()` refuses everything
 *     while one is in flight.
 *   • The 'claude-hidden' route reaches further than this slot: runHiddenClaude
 *     keeps a PROCESS-WIDE fifo queue that reflect.ts's condense pass also
 *     joins. That queue is the one place a chatter brew can delay real work —
 *     and it is bounded: only one brew is ever in flight, so a condense that
 *     arrives mid-brew waits behind exactly ONE attempt (≤ BREW_TIMEOUT_MS),
 *     never behind a backlog, and the next chatter brew queues behind IT.
 *   • The 'openai-compatible' route (chatterProvider) removes even that: it
 *     never touches the CLI, the queue or the user's subscription.
 *   • Longer prompts are spend, not contention, and spend is what the token
 *     ledger below exists to cap.
 */
import { runHiddenClaude } from './hiddenClaude';
import {
  ChatterTokenLedger,
  DEFAULT_CHATTER_TOKEN_BUDGET_PER_HOUR,
  chatterHttpComplete,
  estimateTokens,
  type ChatterProvider
} from './chatterOpenAI';

/** Endpoint settings for the 'openai-compatible' route, read at brew time.
 *  Deliberately read fresh on every brew rather than captured: a key pasted in
 *  Settings must work on the next brew, with no restart. */
export interface ChatterEndpoint {
  /** Root or full completions URL — see chatterOpenAI.chatCompletionsUrl. */
  baseUrl?: string;
  /** Bearer credential. MAIN-PROCESS ONLY: it arrives here from config and
   *  leaves only inside one Authorization header. It is never logged, never put
   *  in an error string (chatterOpenAI redacts), and never crosses IPC. */
  apiKey?: string;
}

export interface BrewSlotDeps {
  /** The hive home to run the hidden session in; null → nothing can brew. */
  getHome: () => string | null;
  /** The agent CLI command (e.g. 'claude'). */
  getCommand: () => string;
  /** Which route a brew takes. Absent ⇒ 'claude-hidden', so every caller that
   *  predates the second route keeps its exact behaviour. */
  getProvider?: () => ChatterProvider;
  /** Where the 'openai-compatible' route posts, and with what credential.
   *  Absent or incomplete ⇒ that route refuses to brew at all (see `allows`). */
  getEndpoint?: () => ChatterEndpoint;
  /** Rolling-hour token ceiling for the whole chatter, across lanes and routes.
   *  Absent ⇒ DEFAULT_CHATTER_TOKEN_BUDGET_PER_HOUR; 0 ⇒ unlimited. */
  getTokenBudgetPerHour?: () => number;
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

/**
 * Tools a brew may never reach for — i.e. all of them.
 *
 * WHY IT IS NOT JUST THE WRITING TOOLS. This list used to be
 * Edit/Write/NotebookEdit/Bash, on the theory that a decoration only has to be
 * stopped from CHANGING things. That was true for exactly as long as the prompt
 * contained nothing but text the app itself wrote. It stopped being true when
 * the café prompt began carrying real task TITLES (officeWork.ts): a title is
 * free text that an agent, a Slack relay or a webhook can author, so it is
 * attacker-influenceable, and `runHiddenClaude` runs the session with
 * `--permission-mode bypassPermissions` — every tool NOT on this list runs with
 * no prompt at all.
 *
 * With reads and network left open, a hostile title that survived `scrubTitle`
 * could tell the session to Read/Grep/Glob arbitrary files on disk and carry
 * them out over WebFetch/WebSearch. That is a far wider channel than the few
 * short lines the caller's parser keeps, and it is not a channel a thought
 * cloud above a pixel avatar has any use for. The chatter's entire job is to
 * turn a prompt it was already handed into two sentences; it has never needed a
 * single tool, so the safe list is the empty one.
 *
 * Spelled out by name because the CLI takes an explicit list, not a wildcard.
 * Retired and alternate spellings (MultiEdit, NotebookRead, KillBash/KillShell,
 * LS) are kept so an older `claude` on the user's PATH is covered too — an
 * unrecognised name is inert, so over-listing costs nothing.
 *
 * WHAT THIS DOES NOT COVER: tools contributed by the user's own MCP servers,
 * which are named `mcp__<server>__<tool>` and cannot be enumerated ahead of
 * time. The brew runs in the hive home, so that only bites an install that put
 * an MCP config there; `scrubTitle` (which keeps paths, URLs and credentials
 * out of the prompt in the first place) and the lane budgets are what bound
 * that residue.
 */
export const BREW_DISALLOWED_TOOLS = [
  // Execution
  'Bash', 'BashOutput', 'KillBash', 'KillShell', 'Task', 'Agent',
  // Writing
  'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  // Reading — the half that used to be allowed
  'Read', 'NotebookRead', 'Glob', 'Grep', 'LS',
  // Network egress — the half that made reading worth attempting
  'WebFetch', 'WebSearch',
  // Everything else with a side effect or a resource behind it
  'TodoWrite', 'ExitPlanMode', 'SlashCommand', 'Skill', 'AskUserQuestion',
  'ListMcpResourcesTool', 'ReadMcpResourceTool'
];

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
  /** The chatter's rolling-hour token ceiling. ONE ledger for the whole slot,
   *  deliberately not per-lane: the lanes exist so two decorations cannot starve
   *  each other's TURN at the slot, but "what the office is allowed to spend in
   *  an hour" is a single number the user set, not two. */
  private ledger: ChatterTokenLedger;

  constructor(private deps: BrewSlotDeps) {
    this.ledger = new ChatterTokenLedger(
      () => this.deps.getTokenBudgetPerHour?.() ?? DEFAULT_CHATTER_TOKEN_BUDGET_PER_HOUR
    );
  }

  /** Is a brew cooking right now? */
  get busy(): boolean {
    return this.inFlight;
  }

  /** Tokens charged inside the current rolling hour. Read-only; exists for tests
   *  and for a future "chatter spend" readout in Settings. */
  get tokensSpentThisHour(): number {
    return this.ledger.spent();
  }

  private provider(): ChatterProvider {
    return this.deps.getProvider?.() === 'openai-compatible' ? 'openai-compatible' : 'claude-hidden';
  }

  /** Is the HTTP route actually usable? An unconfigured endpoint (no base URL or
   *  no key) is a NORMAL state — the user flipped the provider before filling in
   *  Settings — and must cost nothing: no request, and no lane/per-key budget
   *  burnt on a brew that could only ever come back empty. */
  private endpointReady(): boolean {
    const ep = this.deps.getEndpoint?.();
    return !!ep && !!(ep.baseUrl ?? '').trim() && !!(ep.apiKey ?? '').trim();
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
    // The hourly TOKEN ceiling, checked before any per-lane counter so an
    // exhausted budget stops every lane at once. Nothing queues: a brew refused
    // here simply never happens, and the window reopens as spend ages out.
    if (!this.ledger.allows()) return false;
    // An unconfigured HTTP endpoint can only produce "no line", so it must not
    // spend the lane's hourly slot or a key's cooldown finding that out.
    if (this.provider() === 'openai-compatible' && !this.endpointReady()) return false;
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

    // One attempt on whichever route is configured. Both routes charge the
    // shared token ledger and both hand back raw text or null; the retry,
    // timeout and abort machinery below does not care which one ran.
    const attempt = async (timeoutMs: number): Promise<T | null> => {
      const text = this.provider() === 'openai-compatible'
        ? await this.brewHttp(req, timeoutMs, controller.signal)
        : await this.brewHidden(req, home, timeoutMs, controller.signal);
      if (!text) return null;
      return req.parse(text);
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

  /** ROUTE A (default, historical): a hidden `claude` CLI session. Spends the
   *  user's interactive plan — the same quota their working agents draw on,
   *  which is exactly why route B exists. */
  private async brewHidden(
    req: BrewRequest<unknown>, home: string, timeoutMs: number, signal: AbortSignal
  ): Promise<string | null> {
    const res = await runHiddenClaude(req.prompt, {
      model: req.model,
      cwd: home,
      command: this.deps.getCommand(),
      disallowedTools: BREW_DISALLOWED_TOOLS,
      timeoutMs,
      signal
    });
    // The CLI reports no usage at all, so this route is ALWAYS estimated:
    // ceil(chars/4) over the prompt plus whatever came back. See
    // chatterOpenAI.estimateTokens for the arithmetic and its error bars. It is
    // charged even on failure, because a session that timed out still burnt the
    // prompt upstream.
    this.ledger.note(estimateTokens(req.prompt) + estimateTokens(res.text ?? ''));
    if (!res.ok || !res.text) return null;
    return res.text;
  }

  /** ROUTE B: one POST to an OpenAI-compatible endpoint. Independent of the
   *  user's Claude subscription, which is the whole point.
   *
   *  DEGRADATION: every failure mode — no key, unreachable host, 500, garbage
   *  body, timeout — resolves to null here. Null is indistinguishable from "the
   *  model had nothing to say", so the caller takes its existing no-line path
   *  (canned café dialogue, a message with no aside). Nothing is invented, the
   *  slot is released either way, and no network error can reach the app as an
   *  unhandled rejection. */
  private async brewHttp(
    req: BrewRequest<unknown>, timeoutMs: number, signal: AbortSignal
  ): Promise<string | null> {
    const ep = this.deps.getEndpoint?.() ?? {};
    const res = await chatterHttpComplete({
      baseUrl: ep.baseUrl ?? '',
      apiKey: ep.apiKey ?? '',
      model: req.model,
      prompt: req.prompt,
      timeoutMs,
      signal
    });
    this.ledger.note(res.tokens);
    return res.ok && res.text ? res.text : null;
  }
}
