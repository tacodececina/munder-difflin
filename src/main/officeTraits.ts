/**
 * TraitBook — the floor's PERSISTENT personality, derived by rules.
 *
 * WHAT PROBLEM THIS SOLVES. Until now an agent's "persona" was assembled fresh
 * for every single café brew: `ChatPersona` in officeChat.ts is name + character
 * + role + current status, four fields read off the live roster at the moment
 * two avatars sit down. Nothing about WHO AN AGENT TURNED OUT TO BE survived the
 * exchange. The relationship book remembers what a pair feels about each other;
 * nothing remembered that Dwight is the one who never stops asking questions and
 * Stanley is the one who answers in four words.
 *
 * This module is that memory, and it is derived ENTIRELY BY RULES — no model is
 * ever asked "what is this agent like?". Two reasons, and the second is the one
 * that actually matters:
 *
 *   1. COST. A trait panel that bills tokens every time you open it is a panel
 *      nobody opens. This one is free, forever, and works with the network down.
 *   2. FALSIFIABILITY. Every trait here is a RATIO OF THINGS THAT HAPPENED, and
 *      each reading carries the two numbers it came from (`evidence`). "Asks
 *      after people — 14 of their last 38 exchanges were check-ins" is a claim
 *      the user can audit. "Seems like a caring soul" is a vibe a model made up.
 *      A personality the floor cannot justify is not a personality, it is a
 *      horoscope.
 *
 * ─── WHY COUNTERS AND NOT A RE-READ OF THE CHATTER LOG ───────────────────────
 * The obvious implementation is to skip this file entirely and derive traits on
 * demand from `office-chatter.jsonl`. That log is deliberately RETENTION-BOUNDED
 * (7 days / 1 MB by default, and both bounds exist for good reasons argued at
 * the top of officeChatLog.ts). Deriving personality from it would mean an agent
 * who has been on the floor for two months has the personality of the last week,
 * and that whoever lowers `officeChatterLogDays` to save disk also silently
 * erases who everyone is. A trait is supposed to be the SLOW variable; reading
 * it out of the fast, disposable one gets the time constants exactly backwards.
 *
 * So: small, bounded per-agent COUNTERS, updated at the same moment the log row
 * is appended, and outliving every line that produced them.
 *
 * ─── HOW A PERSONALITY STILL CHANGES ────────────────────────────────────────
 * Lifetime counters alone would freeze a personality: after ten thousand lines,
 * a hundred new ones cannot move a ratio. So the counters are EXPONENTIALLY
 * FORGETFUL — when an agent's line weight crosses COUNTER_CEILING, every one of
 * that agent's weights is halved at once. Ratios are unchanged by the halving
 * (that is the point: forgetting must not itself be an opinion), but afterwards
 * recent evidence is never worth less than ~1/ceiling of the total, so an agent
 * who changes really does drift. `lifetimeLines` is kept separately and NEVER
 * scaled, because "has said 4,102 lines" is a fact and must not become 512.
 *
 * ─── PRIVACY: THIS FILE CONTAINS NO WORDS ───────────────────────────────────
 * Not one line of dialogue is stored here. `observe` receives the spoken lines
 * and keeps only their COUNT, their total LENGTH, and how many ended in a
 * question mark. Nothing written by this module can leak a sentence, a path or a
 * task title, because it never holds one — which is also why, unlike the chatter
 * log, it needs no scrubbing pass and no retention window.
 *
 * ─── THE BOUNDARY, RESTATED ─────────────────────────────────────────────────
 * READ-ONLY TOWARD THE WORK, exactly like officeWork.ts and officeChatLog.ts.
 * This module is handed lines and event kinds; it is never handed the hive, a
 * writer or an IPC handle. Traits are an output of conversation and an input to
 * conversation. No trait can move a card, an assignment or an agent's state.
 *
 * ─── FEATURE FLAG ──────────────────────────────────────────────────────────
 * `isEnabled` is checked FIRST in every write path, before a path is resolved or
 * a row is built — so with `officeChatterEnabled` off, this module never creates
 * a file, never opens one, and never costs a syscall.
 */
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

/** The save file's name at the hive home, beside `office-relationships.json`
 *  and `office-chatter.jsonl`. Exported because the home-migration and
 *  full-reset paths in index.ts have to move and erase this file alongside
 *  them — traits are keyed by the very agent ids those flows move or retire. */
export const TRAITS_FILE_NAME = 'office-traits.json';

const SAVE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 2_000;

/** Weighted line count at which an agent's whole counter set is halved — see
 *  "HOW A PERSONALITY STILL CHANGES". Roughly a few hundred café lines, i.e.
 *  weeks of a talkative floor. */
const COUNTER_CEILING = 400;

/** Most partners tracked per agent. A floor has a dozen agents, not a thousand;
 *  the cap is a bound on a hand-editable file, not a product decision. When it
 *  is exceeded the LIGHTEST partners are dropped, since they are the ones whose
 *  removal changes no ratio that matters. */
const MAX_PARTNERS = 24;

/** Interaction kinds tallied per agent. Deliberately the same vocabulary as
 *  `RelEventKind` in officeRel.ts — this is the per-AGENT projection of the
 *  per-EDGE history that book already keeps, and a second vocabulary would let
 *  the two disagree about what happened. */
export type TraitEventKind =
  | 'handoff' | 'reply' | 'refusal' | 'cafe' | 'checkin' | 'celebrated' | 'friction';

const EVENT_KINDS: TraitEventKind[] = [
  'handoff', 'reply', 'refusal', 'cafe', 'checkin', 'celebrated', 'friction'
];

type EventTally = Partial<Record<TraitEventKind, number>>;

/** One agent's accumulated, weighted evidence. Everything here is a number. */
export interface TraitCounters {
  id: string;
  /** Weighted spoken lines (halved at the ceiling). The denominator of most
   *  ratios below. */
  lines: number;
  /** Weighted total characters spoken — `chars / lines` is verbosity. */
  chars: number;
  /** Weighted lines that ended in a question mark (any script). */
  questions: number;
  /** Weighted exchanges this agent took part in. */
  exchanges: number;
  /** Weighted exchanges this agent OPENED (spoke first in). */
  opened: number;
  /** partner id → weighted lines exchanged with them. Bounded by MAX_PARTNERS. */
  partners: Record<string, number>;
  /** Weighted interaction tallies where this agent was the INITIATOR… */
  acted: EventTally;
  /** …and where they were on the receiving end. Kept apart for the same reason
   *  officeRel splits its impulse table by side: being refused and refusing are
   *  not the same fact about a person. */
  received: EventTally;
  /** Never scaled: the honest lifetime count, for display only. */
  lifetimeLines: number;
  firstAt: number;
  lastAt: number;
}

/** One derived trait, with the arithmetic that produced it. */
export interface TraitReading {
  id: TraitId;
  /** 0..1 — how far past its threshold the evidence sits. Ranks the list; it is
   *  NOT a probability and nothing branches on its exact value. */
  strength: number;
  /** The two numbers behind the claim: `a` of `b`. Rendered by the panel so
   *  every trait on screen can be checked by the person reading it. */
  evidence: { a: number; b: number };
}

/** An agent's personality as this module understands it. */
export interface AgentTraits {
  id: string;
  /** Above-threshold traits, strongest first. Empty is a perfectly good answer
   *  and the common one for a quiet agent — see MIN_LINES. */
  traits: TraitReading[];
  /** Lifetime spoken lines — the "how much of a sample is this" number, shown
   *  beside the list so a thin one is visibly thin. */
  lines: number;
  /** Exchanges taken part in. */
  exchanges: number;
  /** Distinct conversation partners. */
  partners: number;
}

export type TraitId =
  | 'curious'      // asks things
  | 'terse'        // short lines
  | 'expansive'    // long lines
  | 'opener'       // starts conversations
  | 'listener'     // rarely starts them
  | 'social'       // spread across many partners
  | 'loyal'        // concentrated on one
  | 'caretaker'    // initiates check-ins
  | 'contrarian'   // initiates refusals
  | 'beloved'      // others read them warmly
  | 'abrasive'     // others read them tensely
  | 'veteran';     // deep shared history all round

/** Below this many weighted lines, NO trait is claimed at all. A personality
 *  read off four sentences is noise wearing a label, and the panel showing
 *  "not enough yet" is the honest state — not a failure. */
export const MIN_LINES_FOR_TRAITS = 12;
/** Same idea for the relationship-derived traits, which need edges rather than
 *  lines: one warm colleague is not a reputation. */
const MIN_EDGES_FOR_REL_TRAITS = 2;

/** The one directional summary shape this module reads — structurally the
 *  `RelSummary` officeRel.ts exports, restated as a minimal input so the
 *  derivation can be unit-tested without constructing a RelationshipBook. */
export interface TraitRelEdge {
  from: string;
  to: string;
  warmth: number;
  tension: number;
  familiarity: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How far `value` sits past `threshold` on its way to `ceiling`, as 0..1.
 *  Used for every trait's strength so they rank against each other on a common
 *  scale instead of on the raw units of whatever ratio produced them. */
function over(value: number, threshold: number, ceiling: number): number {
  if (value < threshold) return 0;
  if (ceiling <= threshold) return 1;
  return clamp01((value - threshold) / (ceiling - threshold));
}

/** Same, mirrored: how far `value` sits BELOW `threshold` toward `floor`. */
function under(value: number, threshold: number, floor: number): number {
  if (value > threshold) return 0;
  if (threshold <= floor) return 1;
  return clamp01((threshold - value) / (threshold - floor));
}

const sumTally = (t: EventTally): number => {
  let n = 0;
  for (const k of EVENT_KINDS) n += t[k] ?? 0;
  return n;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Derive every agent's traits from their counters and the current relationship
 * edges. PURE: same inputs, same output, no clock, no disk, no randomness — so
 * the rules can be tested as arithmetic, which is the whole reason the panel is
 * allowed to state them as facts.
 *
 * @param counters per-agent evidence (TraitBook.snapshot(), or a literal in a test)
 * @param edges    DIRECTED relationship edges (officeRel.snapshot())
 */
export function deriveTraits(
  counters: readonly TraitCounters[],
  edges: readonly TraitRelEdge[] = []
): AgentTraits[] {
  // Incoming edges are the interesting ones for reputation: how OTHERS read
  // this agent is a fact about them that they do not get a vote on. Outgoing
  // edges say how they read others, which is a different trait entirely.
  const incoming = new Map<string, TraitRelEdge[]>();
  const outgoing = new Map<string, TraitRelEdge[]>();
  for (const e of edges) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string' || e.from === e.to) continue;
    (incoming.get(e.to) ?? incoming.set(e.to, []).get(e.to)!).push(e);
    (outgoing.get(e.from) ?? outgoing.set(e.from, []).get(e.from)!).push(e);
  }
  const mean = (list: TraitRelEdge[] | undefined, pick: (e: TraitRelEdge) => number): number => {
    if (!list || list.length === 0) return 0;
    let total = 0;
    for (const e of list) total += pick(e);
    return total / list.length;
  };

  const out: AgentTraits[] = [];
  for (const c of counters) {
    if (!c || typeof c.id !== 'string' || !c.id) continue;
    const traits: TraitReading[] = [];
    const partnerIds = Object.keys(c.partners ?? {});
    const partnerWeights = partnerIds.map((p) => c.partners[p]).sort((a, b) => b - a);
    const partnerTotal = partnerWeights.reduce((n, w) => n + w, 0);

    // ── Traits from what they SAY ─────────────────────────────────────────
    // Gated on sample size: a trait claimed off a handful of lines would be the
    // panel inventing a person, which is the failure mode this module is built
    // to avoid.
    if (c.lines >= MIN_LINES_FOR_TRAITS) {
      const questionRate = c.questions / c.lines;
      const avgChars = c.chars / c.lines;
      const push = (id: TraitId, strength: number, a: number, b: number): void => {
        if (strength > 0) traits.push({ id, strength: round2(strength), evidence: { a: Math.round(a), b: Math.round(b) } });
      };
      // "The one who always asks if you're okay" starts here: a fifth of their
      // lines being questions is already well above conversational baseline.
      push('curious', over(questionRate, 0.2, 0.5), c.questions, c.lines);
      push('terse', under(avgChars, 28, 12), avgChars, c.lines);
      push('expansive', over(avgChars, 52, 70), avgChars, c.lines);

      if (c.exchanges >= 4) {
        const openRate = c.opened / c.exchanges;
        push('opener', over(openRate, 0.65, 0.95), c.opened, c.exchanges);
        push('listener', under(openRate, 0.25, 0), c.opened, c.exchanges);
      }
      if (partnerIds.length >= 2 && partnerTotal > 0) {
        const topShare = partnerWeights[0] / partnerTotal;
        push('loyal', over(topShare, 0.6, 0.9), partnerWeights[0], partnerTotal);
        if (partnerIds.length >= 3) {
          push('social', Math.min(over(partnerIds.length, 3, 6), under(topShare, 0.5, 0.25)), partnerIds.length, partnerIds.length);
        }
      }
    }

    // ── Traits from what they DO ─────────────────────────────────────────
    // Event tallies are their own sample: an agent can be a relentless
    // check-in-er while barely speaking at the café, and that is exactly the
    // sort of person the line counters above would miss.
    const actedTotal = sumTally(c.acted ?? {});
    if (actedTotal >= 4) {
      const checkins = c.acted?.checkin ?? 0;
      const refusals = c.acted?.refusal ?? 0;
      if (checkins >= 2) {
        traits.push({
          id: 'caretaker',
          strength: round2(over(checkins / actedTotal, 0.12, 0.45)),
          evidence: { a: Math.round(checkins), b: Math.round(actedTotal) }
        });
      }
      if (refusals >= 2) {
        traits.push({
          id: 'contrarian',
          strength: round2(over(refusals / actedTotal, 0.12, 0.4)),
          evidence: { a: Math.round(refusals), b: Math.round(actedTotal) }
        });
      }
    }

    // ── Traits from how OTHERS read them ─────────────────────────────────
    const inEdges = incoming.get(c.id);
    if (inEdges && inEdges.length >= MIN_EDGES_FOR_REL_TRAITS) {
      const warmth = mean(inEdges, (e) => e.warmth);
      const tension = mean(inEdges, (e) => e.tension);
      const fam = mean(outgoing.get(c.id), (e) => e.familiarity);
      const w = over(warmth, 0.35, 0.8);
      if (w > 0) traits.push({ id: 'beloved', strength: round2(w), evidence: { a: Math.round(warmth * 100), b: inEdges.length } });
      const t = over(tension, 0.4, 0.8);
      if (t > 0) traits.push({ id: 'abrasive', strength: round2(t), evidence: { a: Math.round(tension * 100), b: inEdges.length } });
      const v = over(fam, 0.5, 0.85);
      if (v > 0) traits.push({ id: 'veteran', strength: round2(v), evidence: { a: Math.round(fam * 100), b: inEdges.length } });
    }

    // Strongest first; the id tiebreak keeps the order stable across polls so
    // the panel does not reshuffle two equally-strong traits on every refresh.
    traits.sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
    out.push({
      id: c.id,
      traits: traits.filter((t) => t.strength > 0),
      lines: Math.round(c.lifetimeLines ?? c.lines),
      exchanges: Math.round(c.exchanges),
      partners: partnerIds.length
    });
  }
  out.sort((a, b) => b.lines - a.lines || a.id.localeCompare(b.id));
  return out;
}

/** How many traits are fed back into the dialogue prompt. Three: enough to make
 *  an agent recognisable, few enough that the persona line stays one line. */
const PROMPT_TRAITS = 3;

/** English clauses for the prompt. NOT user-facing — the panel renders traits
 *  through i18n; this is the model-facing wording, which is why it stays in the
 *  prompt's own language rather than the UI's. */
const TRAIT_PROSE: Record<TraitId, string> = {
  curious: 'asks a lot of questions',
  terse: 'answers in very few words',
  expansive: 'talks at length',
  opener: 'is usually the one who starts a conversation',
  listener: 'rarely opens a conversation, mostly responds',
  social: 'talks with everyone on the floor',
  loyal: 'mostly talks to one particular colleague',
  caretaker: 'checks on people when they are struggling',
  contrarian: 'pushes back and says no more than most',
  beloved: 'is well liked by the rest of the floor',
  abrasive: 'rubs people the wrong way',
  veteran: 'has long history with everyone here'
};

/**
 * The persona line's trait clause, or '' when there is nothing earned to say.
 *
 * Empty string is load-bearing: `buildPrompt` filters falsy entries, so an
 * agent with no traits yields a prompt BYTE-IDENTICAL to one built before this
 * module existed. Nothing about the café changes until a personality has
 * actually accumulated.
 */
export function traitProse(reading: AgentTraits | null | undefined): string {
  if (!reading || reading.traits.length === 0) return '';
  return reading.traits.slice(0, PROMPT_TRAITS).map((t) => TRAIT_PROSE[t.id]).filter(Boolean).join('; ');
}

interface Deps {
  /** The harness home. No home ⇒ no traits file, same rule as the chatter log:
   *  a personality with no hive to belong to is not worth minting a file for. */
  getHome: () => string | null | undefined;
  /** `officeChatterEnabled`. Checked FIRST in every write path. */
  isEnabled: () => boolean;
}

/** Write `text` to `path` atomically — temp sibling → fsync → rename. Mirrors
 *  officeRel.ts and officeChatLog.ts; a crash mid-write must never truncate a
 *  personality into a half-parsed object. */
function atomicWriteFile(path: string, text: string): void {
  const tmp = `${path}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* fsync best-effort; rename is the durability guarantee */ }
  renameSync(tmp, path);
}

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Coerce a persisted tally into a well-formed one. A hand-edited file must not
 *  be able to introduce an unknown key or a negative weight. */
function hydrateTally(raw: unknown): EventTally {
  const out: EventTally = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of EVENT_KINDS) {
    const v = num(r[k]);
    if (v > 0) out[k] = v;
  }
  return out;
}

export class TraitBook {
  private agents = new Map<string, TraitCounters>();
  private loadedFrom: string | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private deps: Deps) {}

  /** Where the book persists, or null when no home is open (or the configured
   *  home does not exist yet — the pre-onboarding shape). Null means nothing is
   *  written or read: this module never creates the directory it would live in. */
  filePath(): string | null {
    const home = this.deps.getHome();
    if (!home || !existsSync(home)) return null;
    return join(home, TRAITS_FILE_NAME);
  }

  private blank(id: string, at: number): TraitCounters {
    return {
      id, lines: 0, chars: 0, questions: 0, exchanges: 0, opened: 0,
      partners: {}, acted: {}, received: {}, lifetimeLines: 0, firstAt: at, lastAt: at
    };
  }

  private ensureLoaded(): void {
    const path = this.filePath();
    // No home: keep whatever is in memory but never claim it came from a file,
    // so the first append after a home appears re-resolves instead of silently
    // writing this process's scratch state over a real one.
    if (path === null) { this.loadedFrom = null; return; }
    if (this.loadedFrom === path) return;
    this.agents = new Map();
    this.loadedFrom = path;
    try {
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: number;
        agents?: Array<Partial<TraitCounters>>;
      };
      for (const a of raw.agents ?? []) {
        if (!a || typeof a.id !== 'string' || !a.id) continue;
        const partners: Record<string, number> = {};
        if (a.partners && typeof a.partners === 'object') {
          for (const [k, v] of Object.entries(a.partners as Record<string, unknown>)) {
            const w = num(v);
            if (k && w > 0) partners[k] = w;
          }
        }
        this.agents.set(a.id, {
          id: a.id,
          lines: num(a.lines),
          chars: num(a.chars),
          questions: num(a.questions),
          exchanges: num(a.exchanges),
          opened: num(a.opened),
          partners,
          acted: hydrateTally(a.acted),
          received: hydrateTally(a.received),
          lifetimeLines: num(a.lifetimeLines, num(a.lines)),
          firstAt: num(a.firstAt, Date.now()),
          lastAt: num(a.lastAt, Date.now())
        });
      }
    } catch { /* corrupt file — start fresh, never crash the floor */ }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private writeNow(): void {
    const path = this.filePath();
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      atomicWriteFile(path, JSON.stringify({ version: SAVE_VERSION, agents: [...this.agents.values()] }, null, 2));
    } catch { /* best-effort persistence */ }
  }

  /** Persist any debounced change immediately (app quit, home change, tests).
   *  Every write is deferred, so a teardown that ends in `app.quit()` has to
   *  call this or it drops the last couple of seconds — same contract as
   *  RelationshipBook.flush(). */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.writeNow();
  }

  /** Erase the book — pending save cancelled, memory dropped, file removed.
   *  The full reset retires the agent ids these counters are keyed by, so a
   *  personality that outlived its agent is the same state leak
   *  `officeRel.purge()` exists to prevent. */
  purge(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const path = this.filePath();
    this.agents = new Map();
    this.loadedFrom = null;
    if (!path) return;
    try { rmSync(path, { force: true }); } catch { /* best-effort */ }
  }

  private entry(id: string, at: number): TraitCounters {
    let c = this.agents.get(id);
    if (!c) {
      c = this.blank(id, at);
      this.agents.set(id, c);
    }
    return c;
  }

  /** Exponential forgetting — see the header. Ratios survive the halving
   *  unchanged; only the WEIGHT of the past drops, which is what lets an agent
   *  who changes actually read as changed. `lifetimeLines` is deliberately not
   *  touched: it is a fact, not a weight. */
  private forget(c: TraitCounters): void {
    if (c.lines < COUNTER_CEILING) return;
    c.lines /= 2; c.chars /= 2; c.questions /= 2; c.exchanges /= 2; c.opened /= 2;
    for (const k of Object.keys(c.partners)) c.partners[k] /= 2;
    for (const tally of [c.acted, c.received]) {
      for (const k of EVENT_KINDS) if (tally[k]) tally[k] = tally[k]! / 2;
    }
  }

  /** Drop the lightest partners once the map exceeds its bound. */
  private trimPartners(c: TraitCounters): void {
    const keys = Object.keys(c.partners);
    if (keys.length <= MAX_PARTNERS) return;
    keys.sort((a, b) => c.partners[b] - c.partners[a]);
    for (const k of keys.slice(MAX_PARTNERS)) delete c.partners[k];
  }

  /**
   * Fold one exchange into both speakers' counters.
   *
   * `lines` alternate starting with `from` — the same contract the floor plays
   * them on, that `RelationshipBook.noteTurns` derives attribution from, and
   * that `OfficeChatterLog.record` writes rows with. Attribution is derived
   * here for the same reason it is derived there: it is the only thing this
   * process actually knows.
   *
   * ONLY COUNTS ARE KEPT. The strings are read for their length and their final
   * character and then dropped on the floor.
   */
  observe(from: string, to: string, lines: readonly string[], at = Date.now()): void {
    if (!this.deps.isEnabled()) return;
    if (!from || !to || from === to || !Array.isArray(lines) || lines.length === 0) return;
    this.ensureLoaded();
    const a = this.entry(from, at);
    const b = this.entry(to, at);
    a.exchanges += 1; b.exchanges += 1;
    a.opened += 1;                 // `from` opened, by the alternation contract
    a.partners[to] = (a.partners[to] ?? 0) + 1;
    b.partners[from] = (b.partners[from] ?? 0) + 1;
    for (let i = 0; i < lines.length; i++) {
      const text = typeof lines[i] === 'string' ? lines[i].trim() : '';
      if (!text) continue;
      const who = i % 2 === 0 ? a : b;
      who.lines += 1;
      who.lifetimeLines += 1;
      who.chars += text.length;
      // '?' and the Arabic question mark '؟' — the floor speaks four languages
      // and a question is a question in all of them.
      if (text.endsWith('?') || text.endsWith('؟')) who.questions += 1;
      who.lastAt = at;
    }
    for (const c of [a, b]) { this.forget(c); this.trimPartners(c); }
    this.scheduleSave();
  }

  /**
   * Fold one INTERACTION into both sides' tallies — the same call site and the
   * same argument order as `RelationshipBook.note`: `from` INITIATED it.
   *
   * This is what makes "the one who checks on everybody" knowable. That agent
   * may hardly speak at the café at all; the evidence for who they are lives in
   * what they DO, and `observe` above can never see it.
   */
  noteEvent(from: string, to: string, kind: TraitEventKind, at = Date.now()): void {
    if (!this.deps.isEnabled()) return;
    if (!from || !to || from === to) return;
    if (!EVENT_KINDS.includes(kind)) return;
    this.ensureLoaded();
    const a = this.entry(from, at);
    const b = this.entry(to, at);
    a.acted[kind] = (a.acted[kind] ?? 0) + 1;
    b.received[kind] = (b.received[kind] ?? 0) + 1;
    a.lastAt = at; b.lastAt = at;
    for (const c of [a, b]) this.forget(c);
    this.scheduleSave();
  }

  /** Every agent's counters. Read-only: looking never mints a row, and calling
   *  this with the flag off simply reads whatever is already on disk. */
  snapshot(): TraitCounters[] {
    this.ensureLoaded();
    return [...this.agents.values()].map((c) => ({
      ...c,
      partners: { ...c.partners },
      acted: { ...c.acted },
      received: { ...c.received }
    }));
  }

  /** The derived personalities — counters + the current relationship edges run
   *  through `deriveTraits`. The single place the derivation happens, so the
   *  panel and the dialogue prompt can never disagree about who someone is. */
  read(edges: readonly TraitRelEdge[] = []): AgentTraits[] {
    return deriveTraits(this.snapshot(), edges);
  }
}
