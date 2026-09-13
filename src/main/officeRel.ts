/**
 * RelationshipBook — persistent DIRECTIONAL relationship state for the office floor.
 *
 * State is keyed by an ORDERED (from → to) edge, not by an unordered pair: what
 * Dwight feels about Jim is a different row from what Jim feels about Dwight.
 * Every edge accumulates three CONTINUOUS axes rather than one score:
 *
 *   warmth      -1..1   affection ↔ dislike. Slow decay toward 0 (~days).
 *   tension      0..1   live friction. Fast decay (~hours) — grudges cool off.
 *   familiarity  0..1   how much shared history exists. Very slow decay (~weeks).
 *
 * Warmth and tension are deliberately NOT one axis with two ends: an edge can be
 * high-warmth AND high-tension at once (old colleagues who bicker constantly),
 * which a single score cannot represent. Nothing here scripts "romance at 80":
 * `flavorFor` only DESCRIBES the region of (warmth, tension, familiarity) space
 * one direction currently occupies, and the dialogue model writes from that
 * description — so closeness, rivalry, one-sided resentment, or something-more
 * all EMERGE from real interaction history (hive handoffs, refusals, shared café
 * breaks, breaker check-ins).
 *
 * WHY DIRECTIONAL: a single interaction lands differently on the two agents in
 * it. Being refused stings far more than refusing; being checked on while you're
 * stuck bonds harder than doing the checking. So `note()` takes the INITIATOR
 * first and writes BOTH edges with different impulses (`IMPULSES[kind].actor` for
 * initiator → other, `.subject` for other → initiator). Asymmetry is not injected
 * anywhere — it accumulates out of who kept initiating what.
 *
 * READS NEVER WRITE: looking a pair up (`get`, `recentEvents`, `lastTurns`,
 * `lastLines`) returns a blank reading for an unknown direction instead of
 * minting a row. Only `note` / `noteTurns` create edges, so a chat that reads a
 * pair and then goes nowhere leaves nothing behind on disk or in the snapshot.
 *
 * CONVERSATIONS ARE A THREAD, NOT A QUIP (v0.4.8). An edge also carries
 * `lastTurns`: the last few things these two actually said to each other, each
 * ATTRIBUTED to a speaker id and stamped with a time. It used to be a bare
 * `string[]` whose only job was "do not repeat these jokes" — which is all you
 * can do with lines nobody can attribute: stored identically on both edges of a
 * DIRECTIONAL book, `["…", "…"]` gives no way to tell who opened. Attributed
 * turns are what let a later meeting RESUME an earlier one instead of firing a
 * fresh isolated quip, so the same field now carries the conversation itself.
 * Old saves keep working: a legacy `lastLines` array is hydrated as-is and
 * still feeds the avoid-repetition read, just without attribution.
 *
 * TURNS ARE SCRUBBED BEFORE THEY LAND. `lastTurns` is the one field here that
 * holds model-written free text, it is written to disk, and it is fed back into
 * the next brew's prompt — so every turn passes officeWork's `scrubTitle` in
 * `sanitizeTurns`, on the load path as well as the write path. That is the same
 * filter officeChatLog applies to the copy of the same lines that goes to
 * `office-chatter.jsonl`; scrubbing only one of the two destinations would mean
 * a path a model echoed out of its context was kept out of the audited log and
 * kept in the file that feeds the prompts.
 *
 * Impulses saturate (each delta is scaled by remaining headroom), so no axis
 * ever runs away; decay is applied lazily on read/write, so an idle floor costs
 * nothing. State is one small JSON file at the hive home (same durability story
 * as the registry/log that live beside it — it is flushed on quit, rides along
 * with a home move, and is erased by a full reset), falling back to userData
 * when no hive is open. A pre-directional save file (symmetric `pairs`) is migrated on
 * load by seeding BOTH directions from the old shared value — see `ensureLoaded`.
 *
 * FEATURE FLAG: nothing in here runs on its own. Every entry point is called
 * behind `officeChatterEnabled` (the hive-message hook and both IPC handlers in
 * index.ts, and OfficeChatDirector's own gate), so with the toggle off this
 * module never reads or writes a byte.
 */
import { app } from 'electron';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

import { scrubTitle } from './officeWork';

export type RelEventKind =
  | 'handoff'     // a routed request/query/propose/inform between the pair
  | 'reply'       // agree/done — cooperation that landed
  | 'refusal'     // an explicit refuse act
  | 'cafe'        // shared a café table (generic small talk)
  | 'checkin'     // one checked in on the other while looping/blocked
  | 'celebrated'  // shared a celebration after a finished task
  | 'friction';   // something went visibly wrong between them

/** Which end of the interaction this edge's owner was on. Absent on rows
 *  migrated from the old symmetric format, where the question had no answer. */
export type RelRole = 'actor' | 'subject';

export interface RelEvent { t: RelEventKind; at: number; role?: RelRole }

/** One thing one of the pair actually said, attributed. `by` is the SPEAKER's
 *  agent id — the whole point of the shape: the two edges of a pair store the
 *  same transcript, so without an explicit speaker a reader of the `b → a` edge
 *  cannot tell who opened. */
export interface RelTurn { by: string; text: string; at: number }

/** How much of a pair's conversation is kept. Six turns is roughly two café
 *  sittings — enough for the next one to pick a thread back up, short enough
 *  that it stays a handful of lines in a prompt rather than a transcript. */
export const MAX_TURNS = 6;

/** One ORDERED edge: how `from` currently reads `to`. */
export interface DirectedRel {
  from: string;
  to: string;
  warmth: number;
  tension: number;
  familiarity: number;
  interactions: number;
  lastAt: number;
  recent: RelEvent[];
  /** LEGACY (pre-v0.4.8): the last generated exchange as bare, unattributed
   *  strings. Still hydrated from old save files and still read by
   *  `lastLines`, but nothing writes it any more — `lastTurns` replaced it. */
  lastLines?: string[];
  /** The running conversation between these two, oldest first, at most
   *  MAX_TURNS. Dialogue is mutual, so the same array is stored on both edges;
   *  `by` is what keeps it unambiguous in either direction. */
  lastTurns?: RelTurn[];
}

/** A decayed edge plus its derived flavor — always one direction's reading. */
export interface RelSummary {
  from: string;
  to: string;
  warmth: number;
  tension: number;
  familiarity: number;
  interactions: number;
  flavor: string;
}

/** Half-lives (ms) — the temperament of the whole system lives in these three. */
const TENSION_HALF_LIFE = 3 * 3_600_000;        // grudges cool within a workday
const WARMTH_HALF_LIFE = 48 * 3_600_000;        // affection persists across sessions
const FAMILIARITY_HALF_LIFE = 14 * 24 * 3_600_000; // shared history barely fades

const MAX_RECENT = 12;
const SAVE_DEBOUNCE_MS = 2_000;
/** 3 adds `lastTurns` (attributed conversation). Version 2 files load
 *  unchanged — their bare `lastLines` are kept and read, just unattributed. */
const SAVE_VERSION = 3;
/** A single spoken line is a thought-cloud line, not a paragraph. Enforced here
 *  too so a malformed caller cannot grow the save file without bound. */
const MAX_TURN_CHARS = 90;

/** The save file's name at the hive home. Exported because the home-migration
 *  and full-reset paths in index.ts have to move and erase this file alongside
 *  `hive/`, `palace/` and `roster.json` — a relationship history left behind by
 *  a move, or resurrected by a reset, is exactly the state leak those flows
 *  exist to prevent. */
export const REL_FILE_NAME = 'office-relationships.json';

/** [warmth, tension, familiarity] deltas. Each is scaled by headroom before
 *  applying, so repetition saturates instead of exploding — fifty handoffs make
 *  colleagues, not soulmates. */
type Impulse = readonly [number, number, number];

/** Impulse table, split by SIDE of the interaction:
 *    actor   — what the initiator comes to feel about the other
 *    subject — what the receiver comes to feel about the initiator
 *  Familiarity is near-symmetric (shared history is shared), warmth and tension
 *  are not: refusing costs the refuser little and the refused a lot. */
const IMPULSES: Record<RelEventKind, { actor: Impulse; subject: Impulse }> = {
  // handing work off is neutral for the sender, mildly imposing for the receiver
  handoff:    { actor: [0.02,  0.00, 0.05], subject: [0.01,  0.02, 0.05] },
  // being agreed with lands a little better than agreeing
  reply:      { actor: [0.05, -0.02, 0.03], subject: [0.06, -0.03, 0.03] },
  // the sting is overwhelmingly on the refused side
  refusal:    { actor: [-0.02, 0.04, 0.02], subject: [-0.06, 0.14, 0.02] },
  // a shared table is genuinely mutual
  cafe:       { actor: [0.06,  0.00, 0.06], subject: [0.06,  0.00, 0.06] },
  // being checked on while stuck bonds harder than doing the checking
  checkin:    { actor: [0.06, -0.03, 0.04], subject: [0.12, -0.09, 0.04] },
  celebrated: { actor: [0.08, -0.02, 0.04], subject: [0.08, -0.02, 0.04] },
  friction:   { actor: [-0.02, 0.08, 0.02], subject: [-0.02, 0.08, 0.02] }
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Which interaction kind a routed hive message counts as. Extracted from
 *  `noteRoute` so the per-AGENT trait tallies (officeTraits.ts) can classify the
 *  same message the same way from the same call site — two copies of this
 *  mapping would eventually disagree about what a `refuse` is, and then the
 *  relationship book and the personality panel would be describing different
 *  offices. */
export function routeEventKind(act: string): RelEventKind {
  if (act === 'refuse') return 'refusal';
  if (act === 'agree' || act === 'done') return 'reply';
  return 'handoff';
}

/** Whether a routed message is between two agents at all. `human` is a router
 *  endpoint, not a colleague with feelings, and a self-message is a row the
 *  loader throws away on the next launch. */
export function routeIsNotable(from: string, target: string): boolean {
  return !!from && !!target && from !== 'human' && target !== 'human' && from !== target;
}

/** Coerce anything claiming to be a turn list into a well-formed, bounded one.
 *  Used on the load path (a hand-edited or truncated save must not crash the
 *  floor) and on the write path (a caller cannot grow the file without bound).
 *  Exported for the prompt builder's own defensive use.
 *
 *  SCRUBBED HERE, ONCE. `scrubTitle` is the same path/credential filter
 *  officeChatLog's `cleanText` applies to the copy of these lines that goes to
 *  `office-chatter.jsonl`. Applying it to only one of the two destinations was
 *  the asymmetry this function now closes: the log's own header argues that a
 *  model can echo a local path back out of its context and the scrub is the
 *  reason it cannot then be PERSISTED — and `lastTurns` is persisted too, in
 *  `office-relationships.json`, and is fed straight back into the next brew's
 *  prompt. Doing it in `sanitizeTurns` rather than in `noteTurns` covers the
 *  load path as well, so a pre-fix save file is scrubbed the first time it is
 *  read instead of carrying an unscrubbed line forever.
 *
 *  A line that scrubs away to nothing is dropped, exactly as `cleanText` drops
 *  it: an empty thought cloud is not a turn. */
export function sanitizeTurns(raw: unknown): RelTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: RelTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Partial<RelTurn>;
    if (typeof t.by !== 'string' || !t.by) continue;
    if (typeof t.text !== 'string') continue;
    // scrubTitle folds CR/LF/TAB to spaces and trims, so the explicit trim this
    // used to do is subsumed. Its own 72-char cap is tighter than MAX_TURN_CHARS
    // and normally gets there first; the cap below stays as this module's own
    // backstop, so the bound never depends on another module's idea of a title.
    const text = scrubTitle(t.text);
    if (!text) continue;
    out.push({
      by: t.by,
      text: text.length > MAX_TURN_CHARS ? text.slice(0, MAX_TURN_CHARS - 1).trimEnd() + '…' : text,
      at: Number(t.at) || Date.now()
    });
  }
  return out.slice(-MAX_TURNS);
}

/** Write `text` to `path` atomically: temp sibling → fsync → rename over target.
 *  Mirrors hive.ts's atomicWriteJson / reflect.ts's atomicWrite — a crash
 *  mid-write must never truncate the persisted relationship history. */
function atomicWriteFile(path: string, text: string): void {
  const tmp = `${path}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* fsync best-effort; rename is the durability guarantee */ }
  renameSync(tmp, path);
}

function decayFactor(elapsedMs: number, halfLifeMs: number): number {
  if (elapsedMs <= 0) return 1;
  return Math.pow(0.5, elapsedMs / halfLifeMs);
}

/** A short human description of how ONE agent currently reads the other.
 *  Descriptive only — the dialogue model interprets it; nothing branches on it.
 *  Phrased one-way on purpose: the other direction gets its own sentence, and
 *  the two are routinely different. */
export function flavorFor(rel: Pick<DirectedRel, 'warmth' | 'tension' | 'familiarity'>): string {
  const { warmth: w, tension: t, familiarity: f } = rel;
  if (f < 0.12) return 'barely knows them yet — still feeling them out';
  if (w > 0.55 && t < 0.2 && f > 0.5) {
    return 'genuinely attached to them — fonder than a colleague strictly needs to be';
  }
  if (w > 0.3 && t > 0.35) return 'bickers with them constantly and keeps sitting back down — prickly and fond';
  if (t > 0.5 && w < 0) return 'openly rivalrous toward them, with real edge to it';
  if (t > 0.35) return 'carrying some friction from recent work with them';
  if (w > 0.35 && f > 0.3) return 'easy with them — a solid work friend';
  if (w > 0.15) return 'friendly toward them, warming up';
  if (w < -0.2) return 'cool and distant toward them — keeps it professional, barely';
  return 'polite toward them, without much history';
}

export class RelationshipBook {
  /** Key: `${from}|${to}` — ORDERED. Both directions of a pair live here as two
   *  independent rows. */
  private edges = new Map<string, DirectedRel>();
  private loadedFrom: string | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private getHome: () => string | null) {}

  /** Where the book currently persists. Public so the teardown paths (home
   *  migration, full reset) can act on the very file this instance would write,
   *  including the userData fallback used when no hive is open. */
  filePath(): string {
    const home = this.getHome();
    const base = home && existsSync(home) ? home : app.getPath('userData');
    return join(base, REL_FILE_NAME);
  }

  /** The directional storage key. Order is meaning here, never normalized. */
  private key(from: string, to: string): string {
    return `${from}|${to}`;
  }

  private blank(from: string, to: string, at: number): DirectedRel {
    return { from, to, warmth: 0, tension: 0, familiarity: 0, interactions: 0, lastAt: at, recent: [] };
  }

  /** Coerce one persisted row (either format) into a directed edge. */
  private hydrate(from: string, to: string, raw: Partial<DirectedRel>): DirectedRel {
    return {
      from, to,
      warmth: clamp(Number(raw.warmth) || 0, -1, 1),
      tension: clamp(Number(raw.tension) || 0, 0, 1),
      familiarity: clamp(Number(raw.familiarity) || 0, 0, 1),
      interactions: Number(raw.interactions) || 0,
      lastAt: Number(raw.lastAt) || Date.now(),
      recent: Array.isArray(raw.recent) ? raw.recent.slice(-MAX_RECENT) : [],
      lastLines: Array.isArray(raw.lastLines) ? raw.lastLines.slice(0, MAX_TURNS) : undefined,
      lastTurns: Array.isArray(raw.lastTurns) ? sanitizeTurns(raw.lastTurns) : undefined
    };
  }

  private ensureLoaded(): void {
    const path = this.filePath();
    if (this.loadedFrom === path) return;
    this.edges = new Map();
    this.loadedFrom = path;
    try {
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: number;
        edges?: Array<Partial<DirectedRel>>;
        /** Pre-directional format: one symmetric row per unordered pair. */
        pairs?: Array<Partial<DirectedRel> & { a?: string; b?: string }>;
      };
      if (Array.isArray(raw.edges)) {
        for (const e of raw.edges) {
          if (!e || typeof e.from !== 'string' || typeof e.to !== 'string' || e.from === e.to) continue;
          this.edges.set(this.key(e.from, e.to), this.hydrate(e.from, e.to, e));
        }
        return;
      }
      // ── One-time migration from the symmetric format ──────────────────────
      // An old save has a single shared value per unordered pair. The honest
      // reading of it is "both of them felt this", so seed BOTH directions with
      // the old value and let subsequent real events pull them apart. No save is
      // scheduled here: rewriting the file on a mere read would be a disk write
      // the caller did not ask for. The next note() persists the new format.
      for (const p of raw.pairs ?? []) {
        if (!p || typeof p.a !== 'string' || typeof p.b !== 'string' || p.a === p.b) continue;
        this.edges.set(this.key(p.a, p.b), this.hydrate(p.a, p.b, p));
        this.edges.set(this.key(p.b, p.a), this.hydrate(p.b, p.a, p));
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
    try {
      const path = this.filePath();
      mkdirSync(dirname(path), { recursive: true });
      atomicWriteFile(path, JSON.stringify({ version: SAVE_VERSION, edges: [...this.edges.values()] }, null, 2));
    } catch { /* best-effort persistence */ }
  }

  /** Persist any debounced change immediately (app quit, home change, tests).
   *  Every write is deferred by SAVE_DEBOUNCE_MS, so any teardown that ends in
   *  `app.quit()` / `app.exit(0)` has to call this or it silently drops the last
   *  two seconds of relationship history. Called from teardownAndQuit,
   *  config:changeHome and the reset path in index.ts. */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.writeNow();
  }

  /** Erase the book — pending save cancelled, memory dropped, file removed.
   *  The full reset wipes the hive and archives the roster so re-selecting the
   *  same folder cannot resurrect agents whose sessions are gone; relationship
   *  rows are the same state keyed by the same agent ids, so they retire with
   *  them rather than coming back attached to nobody. */
  purge(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const path = this.filePath();
    this.edges = new Map();
    // Forget which file was loaded so a later read re-resolves (and re-misses)
    // instead of trusting an in-memory image of a file that no longer exists.
    this.loadedFrom = null;
    try { rmSync(path, { force: true }); } catch { /* best-effort */ }
  }

  private decayed(rel: DirectedRel, now: number): DirectedRel {
    const elapsed = now - rel.lastAt;
    if (elapsed <= 0) return rel;
    rel.warmth *= decayFactor(elapsed, WARMTH_HALF_LIFE);
    rel.tension *= decayFactor(elapsed, TENSION_HALF_LIFE);
    rel.familiarity *= decayFactor(elapsed, FAMILIARITY_HALF_LIFE);
    rel.lastAt = now;
    return rel;
  }

  /** The (from → to) edge, created empty if this direction is unknown.
   *  WRITE PATHS ONLY. Reads go through `peek` — merely LOOKING at a pair must
   *  not mint a row, because `writeNow` serializes the whole map: a café chat
   *  that reads a pair and then ends before anything is noted would otherwise
   *  persist two all-zero edges and report them in every later snapshot. */
  private edge(from: string, to: string): DirectedRel {
    this.ensureLoaded();
    const k = this.key(from, to);
    let rel = this.edges.get(k);
    if (!rel) {
      rel = this.blank(from, to, Date.now());
      this.edges.set(k, rel);
    }
    return rel;
  }

  /** The (from → to) edge if it exists — never creates one. The read-side twin
   *  of `edge`. */
  private peek(from: string, to: string): DirectedRel | undefined {
    this.ensureLoaded();
    return this.edges.get(this.key(from, to));
  }

  private applyImpulse(
    from: string, to: string, imp: Impulse, kind: RelEventKind, role: RelRole, now: number
  ): void {
    const rel = this.decayed(this.edge(from, to), now);
    const [dw, dt, df] = imp;
    // Saturating application: deltas shrink as the axis approaches its bound.
    rel.warmth = clamp(rel.warmth + dw * (dw > 0 ? 1 - Math.max(0, rel.warmth) : 1 - Math.max(0, -rel.warmth)), -1, 1);
    rel.tension = clamp(rel.tension + dt * (dt > 0 ? 1 - rel.tension : rel.tension), 0, 1);
    rel.familiarity = clamp(rel.familiarity + df * (1 - rel.familiarity), 0, 1);
    rel.interactions += 1;
    rel.recent.push({ t: kind, at: now, role });
    if (rel.recent.length > MAX_RECENT) rel.recent.splice(0, rel.recent.length - MAX_RECENT);
  }

  /** Record one real interaction, INITIATED by `from` and RECEIVED by `to`.
   *  Writes both directions with side-specific impulses, so the two agents can
   *  come out of the same event feeling different things about each other. */
  note(from: string, to: string, kind: RelEventKind): void {
    if (!from || !to || from === to || !(kind in IMPULSES)) return;
    const now = Date.now();
    const { actor, subject } = IMPULSES[kind];
    this.applyImpulse(from, to, actor, kind, 'actor', now);
    this.applyImpulse(to, from, subject, kind, 'subject', now);
    this.scheduleSave();
  }

  /** A routed hive message, folded into the edge it travelled along. `from` is
   *  the sender, so it is the initiator of every kind below. */
  noteRoute(from: string, target: string, act: string): void {
    if (!routeIsNotable(from, target)) return;
    this.note(from, target, routeEventKind(act));
  }

  private summarize(rel: DirectedRel): RelSummary {
    return {
      from: rel.from, to: rel.to,
      warmth: rel.warmth, tension: rel.tension, familiarity: rel.familiarity,
      interactions: rel.interactions,
      flavor: flavorFor(rel)
    };
  }

  /** How `from` currently reads `to` (decayed), with its derived flavor.
   *  Directional: `get(a, b)` and `get(b, a)` are independent readings.
   *  A pair with no history reads as a blank edge that is NOT stored — two
   *  strangers who have not interacted yet have no row, on disk or in memory. */
  get(from: string, to: string): RelSummary {
    const rel = this.peek(from, to);
    if (!rel) return this.summarize(this.blank(from, to, Date.now()));
    return this.summarize(this.decayed(rel, Date.now()));
  }

  /** Recent event kinds along the `from → to` edge, newest last — prompt
   *  context. Each carries the role `from` played in it. */
  recentEvents(from: string, to: string): RelEvent[] {
    return [...(this.peek(from, to)?.recent ?? [])];
  }

  /** The running conversation between these two, oldest first, each turn
   *  ATTRIBUTED to its speaker. Read-only: an unknown pair reads as an empty
   *  thread and no row is minted. Argument order does not matter — the same
   *  transcript is stored on both edges and `by` carries the direction.
   *
   *  This is the seed of continuity: the dialogue director feeds it back into
   *  the prompt so a later sitting can pick a thread up rather than fire a
   *  fresh, isolated quip. */
  lastTurns(a: string, b: string): RelTurn[] {
    const turns = this.peek(a, b)?.lastTurns ?? this.peek(b, a)?.lastTurns ?? [];
    return turns.map((t) => ({ ...t }));
  }

  /** The texts of the last conversation, unattributed — the older
   *  "don't repeat yourself" read. Falls back to a pre-v0.4.8 save's bare
   *  `lastLines` for pairs that have not spoken since the upgrade. */
  lastLines(a: string, b: string): string[] {
    const turns = this.peek(a, b)?.lastTurns ?? this.peek(b, a)?.lastTurns;
    if (turns?.length) return turns.map((t) => t.text);
    return this.peek(a, b)?.lastLines ?? this.peek(b, a)?.lastLines ?? [];
  }

  /** APPEND an exchange to the pair's conversation. `lines` alternate starting
   *  with `from` (the opener), which is exactly the contract the floor plays
   *  them back on, so attribution is derived rather than guessed.
   *
   *  Append, not replace: that is what makes the thread a conversation across
   *  sittings instead of a snapshot of the last one. The window is capped at
   *  MAX_TURNS, oldest dropped first. */
  noteTurns(from: string, to: string, lines: string[]): void {
    // Same guard as `note`: this is a write path, and a self-edge is a row the
    // loader throws away on the next launch — so never mint one.
    if (!from || !to || from === to || !Array.isArray(lines)) return;
    const now = Date.now();
    const fresh = sanitizeTurns(
      lines.map((text, i) => ({ by: i % 2 === 0 ? from : to, text, at: now }))
    );
    if (fresh.length === 0) return;
    const merged = [...(this.peek(from, to)?.lastTurns ?? []), ...fresh].slice(-MAX_TURNS);
    // One shared array would alias two rows through JSON round-trips in
    // memory-only tests; give each edge its own copy.
    this.edge(from, to).lastTurns = merged.map((t) => ({ ...t }));
    this.edge(to, from).lastTurns = merged.map((t) => ({ ...t }));
    this.scheduleSave();
  }

  /** Every known DIRECTED edge's decayed state — the floor's ambient poll.
   *  A fully-formed pair appears twice, once per direction. */
  snapshot(): RelSummary[] {
    this.ensureLoaded();
    const now = Date.now();
    const out: RelSummary[] = [];
    for (const rel of this.edges.values()) {
      this.decayed(rel, now);
      out.push(this.summarize(rel));
    }
    return out;
  }
}
