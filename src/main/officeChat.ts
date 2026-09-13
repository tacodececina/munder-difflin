/**
 * OfficeChatDirector — LLM-generated café dialogue for the office floor.
 *
 * THE EXPERIMENT: when two agents share a break-room table, the floor plays
 * dialogue written LIVE by a model, given each agent's real persona, their
 * persistent relationship state (RelationshipBook — DIRECTIONAL, so the prompt
 * carries both A's reading of B and B's reading of A), both agents' live
 * operational status, the CONVERSATION THEY WERE ALREADY HAVING, and a
 * read-only view of the work actually on the board.
 * Feature-flagged off by default (`officeChatterEnabled`).
 *
 * NOTHING IS CANNED ANY MORE (v0.4.8). There used to be a fallback: ~200 hand-
 * written exchanges in the renderer's cafeteriaLines.ts, played whenever a brew
 * was not ready. They were the only fabricated thing on a floor where every
 * other visible detail corresponds to something real, and they were written in
 * English beside a UI the user had translated. They are gone. With the flag off
 * — or on, but with no brewed exchange waiting — the break room is SILENT: two
 * agents still walk there, still sit together, still carry mugs, still show
 * their real status and tool bubbles, they just do not speak. Silence is
 * honest; an invented quip is not.
 *
 * CONTINUITY: a pair's conversation is one thread, not a series of unrelated
 * quips. Every exchange handed to the floor is appended (ATTRIBUTED, via
 * RelationshipBook.noteTurns) to the pair's rolling transcript, and the next
 * brew for that pair gets it back. If they last spoke recently the prompt asks
 * the model to RESUME — same subject, later in the day; if it has been a while
 * it asks for something new that remembers the old one happened. The length of
 * an exchange is deliberately variable (2–6 beats, the model's choice from the
 * situation) instead of the old fixed two-beat shape, and the floor paces each
 * beat by how long its line takes to read.
 *
 * THAT WINDOW IS NOT A HISTORY. `lastTurns` holds six turns per pair and
 * overwrites the oldest in place, because it is a PROMPT INPUT. The durable
 * record — who said what to whom, when, and whether a model wrote it — is a
 * separate append-only, retention-bounded file (officeChatLog.ts), written from
 * the same hand-off through the optional `log` dep below. Nothing in this
 * director reads it back: continuity still comes from the window.
 *
 * TALKING ABOUT WORK, WITHOUT TOUCHING IT: the prompt also carries a read-only,
 * privacy-scrubbed projection of the task board (officeWork.ts — titles and
 * statuses only, never descriptions, results, operator answers or paths), so
 * two colleagues can trade an idea about the thing one of them is stuck on.
 * The boundary is absolute and documented at length in officeWork.ts: this
 * director can only READ. Its single output is `string[]`, and the only place
 * that string can go is a thought cloud. No café line has ever changed, or can
 * change, a decision, an assignment, a task status or any other operational
 * state.
 *
 * LATENCY & COST SHAPE — brew-ahead, never block:
 * A hidden Claude session (runHiddenClaude, the same mechanism reflect.ts uses —
 * spawn, prompt, capture, kill; draws on the user's interactive plan, no API key)
 * takes 10–40s end to end. A café exchange starts in under a second. So the
 * director never generates ON demand: `request()` returns instantly with a
 * previously-brewed exchange for that pair (or null → the floor plays canned
 * lines), and — budget permitting — starts brewing the NEXT one in the
 * background. The first meeting of a pair is always canned; every later meeting
 * can be live. This masks the whole latency and doubles as the rate limiter's
 * natural shape.
 *
 * MODEL TIERING — cheap by default, expensive only when it matters:
 * Routine chatter is the overwhelming majority of brews and is written by a
 * Haiku-class model (`officeChatterModel`). The expensive model
 * (`officeChatterMilestoneModel`, default Fable) is spent only on MILESTONES,
 * where the writing actually has to carry something new:
 *   • the pair's FIRST encounter (no recorded history in either direction), and
 *   • a relationship AXIS crossing a band boundary since this pair's last brew —
 *     warmth/tension/familiarity are directional, so either side's crossing
 *     counts (one of them souring on the other is exactly such a moment).
 * See `tierFor` / `bandsOf`; the band edges are the same ones `flavorFor` in
 * officeRel.ts branches on, so a tier bump means the DESCRIPTION of the
 * relationship just changed, not merely its third decimal.
 *
 * BUDGET (deliberately conservative — a decoration must never dominate spend):
 *   • one brew in flight at a time, ever — enforced by the SHARED BrewSlot, so
 *     this director and the work-message flavour director (officeVoice.ts)
 *     cannot both have a hidden session open at once
 *   • ≥ 60s between brews
 *   • ≤ 8 brews per rolling hour
 *   • ≥ 4 min between brews for the SAME pair
 *   • brewed exchanges expire after 45 min unused (stale status reads wrong)
 *   • a hung hidden session gives up after 25s and gets ONE short retry, rather
 *     than pinning the single brew slot for two minutes
 *   • and, since v0.4.7, a rolling-hour TOKEN ceiling shared with every other
 *     chatter lane (brewSlot's ChatterTokenLedger) — the continuity thread and
 *     the work context below make each prompt a little longer, and that ceiling
 *     is what keeps "a little longer" from becoming unbounded
 * Worst case is 8 short hidden sessions/hour, only while pairs actually meet,
 * only while the flag is on. The mechanics (slot, timeouts, retry, abort) live
 * in brewSlot.ts; only the café's own budget numbers are below.
 *
 * NOTHING PAID-FOR IS THROWN AWAY: an exchange that lands after the pair has
 * already left the table is handed back via `stash()` and replayed the next
 * time that SAME opener sits down with that SAME partner (see the directed
 * `returned` map — the exchange is written for a specific speaker order).
 */
import { BrewSlot, type LaneLimits } from './brewSlot';
import { chatterLanguageDirective } from './chatterLanguage';
import type { RelationshipBook, RelTurn } from './officeRel';
import { workContextProse, type WorkContext } from './officeWork';

export interface ChatPersona {
  id: string;
  name: string;
  /** The TV-show character fronting this agent on the floor (e.g. "Dwight"). */
  character: string;
  /** The agent's real hire role / job description. */
  role: string;
  /** Live operational status ('idle' | 'working' | 'blocked' | …). */
  status: string;
}

export interface OfficeChatRequest {
  a: ChatPersona;
  b: ChatPersona;
  mood: string;   // 'generic' | 'breaker-checkin' | 'celebration'
  spot: string;   // 'table' | 'coffee' | …
}

/** One direction's reading, flattened for the renderer bridge. */
export interface ChatRelView { warmth: number; tension: number; familiarity: number; flavor: string }

/** The reading handed back when the feature is off or the request is malformed.
 *  Frozen: it is a shared constant, not a scratch object. */
export const EMPTY_REL_VIEW: ChatRelView =
  Object.freeze({ warmth: 0, tension: 0, familiarity: 0, flavor: '' });

export interface OfficeChatResponse {
  /** Alternating beats (index 0 = persona `a`), or null → THE PAIR SAYS
   *  NOTHING. There is no canned fallback any more; null means the break room
   *  stays quiet for these two this time. */
  lines: string[] | null;
  /** How `a` reads `b`. */
  rel: ChatRelView;
  /** How `b` reads `a` — routinely different; see officeRel.ts. */
  relBack: ChatRelView;
}

/** The café's slice of the shared brew slot. */
const CAFE_LANE = 'cafe';
const CAFE_LIMITS: LaneLimits = {
  minGapMs: 60_000,
  maxPerHour: 8,
  keyCooldownMs: 4 * 60_000
};
const BREW_TTL_MS = 45 * 60_000;
const MAX_LINE_CHARS = 70;
/** Beats in one exchange. The floor used to get a fixed two-beat shape, which
 *  is what made every café chat feel like the same machine firing; the model now
 *  picks a length inside this range from the situation, and a six-beat argument
 *  reads nothing like a two-beat nod. */
const MIN_LINES = 2;
const MAX_LINES = 6;
/** How recently the pair must have spoken for the next exchange to be written
 *  as a CONTINUATION rather than a fresh subject. Roughly "still the same
 *  afternoon". Past it, the thread is context, not an open topic. */
const RESUME_WINDOW_MS = 40 * 60_000;

interface Brewed { lines: string[]; at: number }

/** Which spend tier a brew qualifies for — see the MODEL TIERING note above. */
export type ChatTier = 'routine' | 'milestone';

interface Deps {
  getHome: () => string | null;
  getCommand: () => string;
  /** The model to brew with AT THIS TIER. Routine chatter must resolve to a
   *  cheap model; only milestones get the expensive one. */
  getModel: (tier: ChatTier) => string;
  isEnabled: () => boolean;
  /** The UI language the user picked in Settings (the `language` field of the
   *  harness config, e.g. 'es'), read through the same `readConfig()` path as
   *  every other option above. The prompt below is English and used to say
   *  nothing about which language to ANSWER in, so brewed lines came back in
   *  English next to the TRANSLATED canned pools they alternate with. Optional:
   *  absent — or English, or any locale with no directive — leaves the prompt
   *  byte-for-byte as it was. See chatterLanguage.ts. */
  getLanguage?: () => string | null | undefined;
  /** A READ-ONLY view of what the office is actually working on, for the two
   *  agents about to talk (officeWork.ts). Optional: absent — or returning
   *  null — leaves the prompt with no work context at all, which is exactly
   *  what it had before, and is also the honest answer when no hive is open.
   *
   *  READ-ONLY IS STRUCTURAL, NOT A CONVENTION. The director is handed a getter
   *  that returns a frozen data value; it is never handed the hive, a writer, or
   *  an ipc handle, so there is no path from a café line back into the work.
   *  See the boundary note at the top of officeWork.ts. Called only at BREW
   *  time (a handful of times an hour), never on the request hot path. */
  getWork?: (aId: string, bId: string) => WorkContext | null;
  rel: RelationshipBook;
  /** WHO THIS AGENT HAS TURNED OUT TO BE, as a short clause ("asks a lot of
   *  questions; checks on people when they are struggling"), derived by rules
   *  from accumulated interaction — see officeTraits.ts. Optional, and it
   *  returns '' until an agent has actually earned a trait, which keeps the
   *  prompt BYTE-IDENTICAL to the pre-traits one for every quiet floor.
   *
   *  This is the feedback loop that makes the personality visible in the
   *  writing rather than only in a panel: the same clause the conversation tab
   *  shows the user is the clause the model is told about, so a claim on screen
   *  and the voice on the floor come from one source. Read at BREW time only. */
  getTraits?: (agentId: string) => string;
  /** Durable record of an exchange actually handed to the floor
   *  (officeChatLog.ts). Called at the SAME moment as `rel.noteTurns` and for
   *  the same reason the attribution there is derived rather than guessed: the
   *  lines alternate starting with `from`, and hand-off is the only moment this
   *  process hears about.
   *
   *  Optional, and it is the only thing this director does with the lines beyond
   *  returning them: a test (or any future caller) can construct a director
   *  without a log and the café behaves identically, just without a transcript.
   *  The relationship window (`lastTurns`) remains what feeds the prompt — this
   *  sink is write-only from here. */
  log?: (from: string, to: string, lines: string[]) => void;
  /** The process-wide brew slot, shared with every other feature that spends a
   *  hidden Claude session in the background (officeVoice.ts). Optional so a
   *  test can construct a director on its own; production always passes the one
   *  slot, which is what makes "one hidden session in flight, ever" true. */
  slot?: BrewSlot;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
/** ORDERED key — used where the speaker order is load-bearing (a brewed
 *  exchange opens with A, so it can only be replayed when A opens again). */
const dirKey = (from: string, to: string): string => `${from}|${to}`;

/** Band edges per axis. Crossing one of these is what counts as a "significant"
 *  move: they are the thresholds officeRel.ts's `flavorFor` itself branches on,
 *  so a crossing is exactly the point where how one agent READS the other gets
 *  described differently. */
const WARMTH_BANDS = [-0.2, 0.15, 0.35, 0.55] as const;
const TENSION_BANDS = [0.2, 0.35, 0.5] as const;
const FAMILIARITY_BANDS = [0.12, 0.3, 0.5] as const;

const bandOf = (v: number, edges: readonly number[]): number =>
  edges.reduce((n, e) => (v >= e ? n + 1 : n), 0);

/** A compact signature of which band each axis sits in. Equal signatures mean
 *  the relationship has only drifted within its current description. */
const bandsOf = (r: { warmth: number; tension: number; familiarity: number }): string =>
  `${bandOf(r.warmth, WARMTH_BANDS)}.${bandOf(r.tension, TENSION_BANDS)}.${bandOf(r.familiarity, FAMILIARITY_BANDS)}`;

export class OfficeChatDirector {
  /** Brewed-ahead exchanges, keyed by UNORDERED pair — the next meeting of these
   *  two, whoever opens it. */
  private cache = new Map<string, Brewed>();
  /** Exchanges the floor handed back because they arrived too late to play (see
   *  `stash`). Keyed by ORDERED (opener → partner): the lines alternate starting
   *  with the opener, so they are only valid for the same speaker order. */
  private returned = new Map<string, Brewed>();
  /** Last observed band signature per DIRECTED edge, sampled at brew time. The
   *  tier check compares against this; an absent mark is seeded, never treated
   *  as a crossing (a fresh process must not bill every pair as a milestone). */
  private relBands = new Map<string, string>();
  /** The shared "one hidden session in flight, ever" slot (brewSlot.ts) — it
   *  owns the timeouts, the single retry, the abort handle and this lane's
   *  budget counters. */
  private slot: BrewSlot;

  constructor(private deps: Deps) {
    this.slot = deps.slot
      ?? new BrewSlot({ getHome: deps.getHome, getCommand: deps.getCommand });
  }

  /** Kill any in-flight brew's hidden Claude PTY immediately. Called on app
   *  quit / home change / reset so a brew (now at most BREW_TIMEOUT_MS + the
   *  retry) never outlives the process that spawned it. Also short-circuits the
   *  wait between the two attempts. Safe to call when nothing is brewing;
   *  idempotent. */
  stop(): void {
    this.slot.stop();
  }

  /** Called when a pair sits down together. Returns a brewed exchange for them
   *  (consuming it) or null — null now means the pair simply says nothing, the
   *  canned pools having been deleted. Either way it may kick off a background
   *  brew for the pair's NEXT meeting. Never blocks on the model. */
  request(req: OfficeChatRequest): OfficeChatResponse {
    // Flag check FIRST: with the toggle off this feature must not so much as
    // read the relationship file, let alone create an edge for this pair.
    if (!this.deps.isEnabled()) return { lines: null, rel: EMPTY_REL_VIEW, relBack: EMPTY_REL_VIEW };
    const ab = this.deps.rel.get(req.a.id, req.b.id);
    const ba = this.deps.rel.get(req.b.id, req.a.id);
    const view = (r: typeof ab): ChatRelView =>
      ({ warmth: r.warmth, tension: r.tension, familiarity: r.familiarity, flavor: r.flavor });

    // An exchange this exact opener never got to say comes first: it was already
    // paid for and is the one the floor owes them. Only then the pair's regular
    // brew. (`??` short-circuits, so an unused cache entry is left in place.)
    const lines =
      this.take(this.returned, dirKey(req.a.id, req.b.id)) ??
      this.take(this.cache, pairKey(req.a.id, req.b.id));
    // APPEND to the pair's thread, attributed: the lines alternate starting
    // with `a`, which is the order the floor plays them in. This is the only
    // write here, and it is what the NEXT brew reads back as continuity.
    // Recorded at hand-off rather than after the last beat is spoken, because
    // hand-off is the only moment this process hears about: a break cut short
    // by real work would otherwise leave the thread permanently behind.
    if (lines) this.deps.rel.noteTurns(req.a.id, req.b.id, lines);
    // …and the same exchange goes to the durable transcript, which is what the
    // six-turn window above is NOT: it is overwritten in place, so without this
    // nothing survives the pair's next sitting. Best-effort — a transcript is
    // never worth failing a café beat over.
    if (lines) { try { this.deps.log?.(req.a.id, req.b.id, lines); } catch { /* noop */ } }
    this.maybeBrew(req);
    return { lines, rel: view(ab), relBack: view(ba) };
  }

  /** Hand back an exchange the floor could not use in time, so it plays at this
   *  pair's NEXT meeting instead of being dropped. Direction matters: the lines
   *  alternate from `from`, so they are only replayed when `from` opens again.
   *  Inert while the feature flag is off, like every other entry point. */
  stash(from: string, to: string, lines: string[]): void {
    if (!this.deps.isEnabled()) return;
    if (!from || !to || from === to || !Array.isArray(lines)) return;
    const clean = lines
      .filter((l): l is string => typeof l === 'string')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS - 1).trimEnd() + '…' : l))
      .slice(0, MAX_LINES);
    if (clean.length < MIN_LINES) return;
    const now = Date.now();
    // Drop anything that went stale while it sat here, so the map cannot grow
    // past the handful of pairs currently on the floor.
    for (const [k, v] of this.returned) if (now - v.at > BREW_TTL_MS) this.returned.delete(k);
    this.returned.set(dirKey(from, to), { lines: clean, at: now });
  }

  /** Consume `key` from `map` if it is still fresh. Expired entries are dropped
   *  either way — a 45-minute-old exchange reads against the wrong statuses. */
  private take(map: Map<string, Brewed>, key: string): string[] | null {
    const brewed = map.get(key);
    if (!brewed) return null;
    map.delete(key);
    return Date.now() - brewed.at <= BREW_TTL_MS ? brewed.lines : null;
  }

  private hasFresh(map: Map<string, Brewed>, key: string): boolean {
    const brewed = map.get(key);
    return !!brewed && Date.now() - brewed.at <= BREW_TTL_MS;
  }

  private budgetAllows(key: string): boolean {
    if (this.cache.has(key)) return false; // already have one waiting
    return this.slot.allows(CAFE_LANE, CAFE_LIMITS, key);
  }

  /** Milestone or routine? Sampled (and the marks updated) exactly at brew time,
   *  so "crossed a threshold" means "since the last brew for this pair". */
  private tierFor(req: OfficeChatRequest): ChatTier {
    const ab = this.deps.rel.get(req.a.id, req.b.id);
    const ba = this.deps.rel.get(req.b.id, req.a.id);
    const abKey = dirKey(req.a.id, req.b.id);
    const baKey = dirKey(req.b.id, req.a.id);
    const abBands = bandsOf(ab);
    const baBands = bandsOf(ba);
    const seenAb = this.relBands.get(abKey);
    const seenBa = this.relBands.get(baKey);
    this.relBands.set(abKey, abBands);
    this.relBands.set(baKey, baBands);
    // First encounter — nothing has ever passed between them in either direction.
    // The one exchange that establishes who these two are to each other is worth
    // the good model.
    if (ab.interactions === 0 && ba.interactions === 0) return 'milestone';
    // A band crossing on either side. An unseen mark is only seeded here: on a
    // fresh process we have nothing to compare against, and guessing "milestone"
    // would bill the expensive model for every pair after every restart.
    if (seenAb !== undefined && seenAb !== abBands) return 'milestone';
    if (seenBa !== undefined && seenBa !== baBands) return 'milestone';
    return 'routine';
  }

  private maybeBrew(req: OfficeChatRequest): void {
    const key = pairKey(req.a.id, req.b.id);
    // Already owe this pair an exchange in EITHER direction — don't pay for a
    // second one. (The a→b entry is normally consumed by the request that got
    // here, so in practice this catches "b opened while a is still owed one".)
    if (this.hasFresh(this.returned, dirKey(req.a.id, req.b.id))
      || this.hasFresh(this.returned, dirKey(req.b.id, req.a.id))) return;
    if (!this.budgetAllows(key)) return;
    // Tier (and the relationship-band marks it updates) is sampled exactly here,
    // once the brew is actually going to happen — "crossed a threshold" has to
    // mean "since this pair's last BREW", not "since the last time anyone looked".
    const model = this.deps.getModel(this.tierFor(req));
    const prompt = this.buildPrompt(req);
    void this.slot
      .run({ lane: CAFE_LANE, limits: CAFE_LIMITS, key, prompt, model, parse: parseExchange })
      .then((lines) => { if (lines) this.cache.set(key, { lines, at: Date.now() }); })
      .catch(() => { /* a failed brew just means canned lines next time */ });
  }

  private buildPrompt(req: OfficeChatRequest): string {
    // Both directions, deliberately: A's reading of B and B's reading of A are
    // separate rows and are often lopsided (one keeps refusing, the other keeps
    // checking in). Handing the model both is the whole point of the feature —
    // an unrequited warmth or a one-sided grudge should show up in the writing.
    const ab = this.deps.rel.get(req.a.id, req.b.id);
    const ba = this.deps.rel.get(req.b.id, req.a.id);
    // Event history is read from A's side, where each entry knows whether A was
    // the one acting or the one on the receiving end.
    const events = this.deps.rel.recentEvents(req.a.id, req.b.id)
      .slice(-6)
      .map((e) => EVENT_PROSE[e.t]?.[e.role === 'subject' ? 'subject' : 'actor'] ?? e.t)
      .join('; ');
    // THE THREAD. Attributed turns, oldest first — who said what, and how long
    // ago. This is the whole continuity mechanism: the pair's own words come
    // back in, so the next sitting can pick one up instead of firing a fresh
    // isolated quip. Nothing new is stored for it; it is the same rolling
    // window officeRel.ts has kept since the feature existed, only attributed.
    const thread = this.deps.rel.lastTurns(req.a.id, req.b.id);
    const threadProse = renderThread(thread, req.a, req.b);
    const gapMs = thread.length ? Date.now() - thread[thread.length - 1].at : Infinity;
    const resuming = gapMs <= RESUME_WINDOW_MS;
    // WORK CONTEXT — read-only, privacy-scrubbed, titles and statuses only.
    // Optional dep: absent ⇒ empty string ⇒ the prompt is exactly what it was.
    const work = workContextProse(this.deps.getWork?.(req.a.id, req.b.id));
    // The user's UI language, turned into prompt text (empty for English and for
    // anything unrecognised, which is what keeps this a no-op by default).
    const lang = chatterLanguageDirective(this.deps.getLanguage?.());
    // A persona used to be assembled entirely from the LIVE roster — name,
    // character, role, current status — so nothing an agent had become over
    // weeks of talking ever reached the page. The trait clause is the durable
    // half: earned, rule-derived, and appended only when there is something
    // earned to say (see officeTraits.ts). No traits ⇒ the exact sentence this
    // prompt has always had.
    const persona = (p: ChatPersona, label: string): string => {
      const base = `${label}: "${p.name}" — presents as ${p.character} from The Office; real job: ${p.role || 'software agent'}; right now: ${statusProse(p.status)}.`;
      const traits = this.deps.getTraits?.(p.id);
      return traits ? `${base} Over time they have come across as someone who ${traits}.` : base;
    };
    return [
      'You are writing ambient dialogue for a pixel-art office where AI coding agents',
      'appear as characters from The Office (US). Two of them just sat down together',
      'in the break room. These two have an ongoing working relationship and an',
      'ongoing conversation — this is a moment in it, not a self-contained sketch.',
      '',
      persona(req.a, 'SPEAKER A (sat down first, opens)'),
      persona(req.b, 'SPEAKER B (already at the table)'),
      '',
      'Their relationship is tracked SEPARATELY in each direction, and the two',
      'sides do not have to agree:',
      `  A reads B as: ${ab.flavor}`,
      `    warmth ${ab.warmth.toFixed(2)} (-1..1), tension ${ab.tension.toFixed(2)} (0..1), familiarity ${ab.familiarity.toFixed(2)} (0..1), ${ab.interactions} past interactions.`,
      `  B reads A as: ${ba.flavor}`,
      `    warmth ${ba.warmth.toFixed(2)} (-1..1), tension ${ba.tension.toFixed(2)} (0..1), familiarity ${ba.familiarity.toFixed(2)} (0..1), ${ba.interactions} past interactions.`,
      events ? `Recent history, from A's side: ${events}.` : 'No notable recent history between them.',
      `Scene mood: ${req.mood === 'breaker-checkin' ? 'one of them has been struggling (looping/blocked) — the other checks in' : req.mood === 'celebration' ? 'one of them just finished a big task' : 'ordinary coffee-break small talk'}.`,
      '',
      threadProse,
      work,
      '',
      `Write a ${MIN_LINES}–${MAX_LINES} line exchange, alternating strictly A, B, A, B. Rules:`,
      // Rhythm first, because it is the rule that stops every exchange sounding
      // like the same machine: the LENGTH is a judgement call about this moment,
      // not a template to fill.
      '- Choose the LENGTH from the situation, not by habit. A passing nod is two',
      '  lines. Someone genuinely stuck, or an argument neither will drop, earns five',
      '  or six. Do not pad to a fixed shape and do not always land on the same one.',
      resuming
        ? '- They were talking about this MINUTES ago and are picking it straight back up.'
          + ' Continue that thread — no greetings, no re-introducing the subject, no'
          + ' restating what was already said. Move it somewhere new: agree, escalate,'
          + ' change their mind, or finally drop it.'
        : thread.length
          ? '- They have talked before (above) but not recently. Start something NEW.'
            + ' You may glance back at the old thread the way coworkers do — a callback,'
            + ' an outcome, an unfinished argument — but do not simply resume it.'
          : '- They have no conversation on record yet. This is where it starts.',
      `- Each line ≤ ${MAX_LINE_CHARS} characters. Lowercase-casual, dry, in character.`,
      '- Let the relationship SHOW through subtext, not exposition. If they are close,',
      '  it can read tender; if there is friction, let it snip. Never name the numbers.',
      '- If the two directions disagree, play the mismatch: the warmer one leans in,',
      '  the cooler one keeps it short. Do not flatten it into mutual feeling.',
      '- They are real coworkers (software agents): shipping code, breakers, reviews',
      '  and coffee are their world. No fourth-wall breaks about being AI models.',
      // The work context is there to be USED — but only ever talked about. This
      // is the model-facing half of the boundary enforced structurally in
      // officeWork.ts; the director has no writer, so a line that "decides"
      // something decides nothing.
      work
        ? '- They may absolutely talk shop: swap an idea about a card, grumble about a'
          + ' blocker, offer a hand. But this is a COFFEE BREAK, not a standup. You are'
          + ' writing overheard conversation — never a decision, an assignment, a status'
          + ' change or an instruction, and nothing here reaches the real board.'
        : '',
      // Deliberately the LAST content rule, immediately before the output-shape
      // line: the instruction that is easiest for a cheap model to forget is the
      // one about language, and the canned lines it plays beside are translated.
      lang,
      '- Output ONLY a JSON array of strings. No prose, no code fence.'
    ].filter(Boolean).join('\n');
  }
}

/** The pair's running conversation, rendered for the prompt.
 *
 *  Attribution is the point. The transcript is stored identically on both edges
 *  of a DIRECTIONAL book, so "who is A here" changes with whoever sat down
 *  first; each turn carries its speaker id and is mapped onto the A/B labels of
 *  THIS scene. A turn by someone who is not at this table (the pair met, then
 *  one of them was replaced by a same-id respawn, say) is labelled neutrally
 *  rather than mis-attributed — a wrong attribution is worse than a vague one.
 *
 *  Empty thread ⇒ empty string, and the prompt simply has no such section. */
export function renderThread(turns: RelTurn[], a: ChatPersona, b: ChatPersona): string {
  if (!turns.length) return '';
  const now = Date.now();
  const lines = turns.map((t) => {
    const who = t.by === a.id ? 'A' : t.by === b.id ? 'B' : '?';
    return `  ${who}: ${JSON.stringify(t.text)}`;
  });
  return [
    `What they last said to each other (${agoProse(now - turns[turns.length - 1].at)}, oldest first):`,
    ...lines
  ].join('\n');
}

/** Coarse, human phrasing of an elapsed span. Coarse on purpose: the model only
 *  needs to know whether this is "still going" or "a while back". */
function agoProse(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'earlier';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'moments ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Event prose from the READER's side: `actor` when A did the thing, `subject`
 *  when it was done to A. The same event reads very differently either way. */
const EVENT_PROSE: Record<string, { actor: string; subject: string }> = {
  handoff:    { actor: 'A handed B work',                  subject: 'B handed A work' },
  reply:      { actor: 'A closed work out with B',         subject: 'B closed work out with A' },
  refusal:    { actor: 'A flatly refused B',               subject: 'B flatly refused A' },
  cafe:       { actor: 'they shared a coffee break',       subject: 'they shared a coffee break' },
  checkin:    { actor: 'A checked in while B was stuck',   subject: 'B checked in while A was stuck' },
  celebrated: { actor: 'they celebrated a finished task',  subject: 'they celebrated a finished task' },
  friction:   { actor: 'something went wrong between them', subject: 'something went wrong between them' }
};

function statusProse(status: string): string {
  switch (status) {
    case 'working': case 'thinking': return 'deep in real work, stealing a break';
    case 'blocked': return 'blocked, waiting on the human';
    case 'looping': return 'just got throttled by the circuit breaker';
    case 'waiting': return 'waiting on another agent';
    case 'success': return 'just finished a task';
    case 'compacting': return 'tidying up its own context';
    default: return 'between tasks';
  }
}

/** Pull a clean alternating exchange out of the model's reply. Defensive: any
 *  shape problem returns null and the floor falls back to canned lines. */
export function parseExchange(text: string): string[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const lines = parsed
    .filter((l): l is string => typeof l === 'string')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS - 1).trimEnd() + '…' : l))
    .slice(0, MAX_LINES);
  return lines.length >= MIN_LINES ? lines : null;
}
