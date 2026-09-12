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
 * READS NEVER WRITE: looking a pair up (`get`, `recentEvents`, `lastLines`)
 * returns a blank reading for an unknown direction instead of minting a row.
 * Only `note` / `setLastLines` create edges, so a chat that reads a pair and
 * then goes nowhere leaves nothing behind on disk or in the snapshot.
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
  /** The last generated exchange between these two, kept so the next one can
   *  avoid repeating itself. Dialogue is inherently mutual, so it is stored on
   *  both edges of the pair. */
  lastLines?: string[];
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
const SAVE_VERSION = 2;

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
      lastLines: Array.isArray(raw.lastLines) ? raw.lastLines.slice(0, 6) : undefined
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
    if (!from || !target || from === 'human' || target === 'human' || from === target) return;
    if (act === 'refuse') this.note(from, target, 'refusal');
    else if (act === 'agree' || act === 'done') this.note(from, target, 'reply');
    else this.note(from, target, 'handoff');
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

  /** The last generated exchange between these two. Dialogue is mutual, so the
   *  order of the arguments does not matter for reads or writes. */
  lastLines(a: string, b: string): string[] {
    return this.peek(a, b)?.lastLines ?? this.peek(b, a)?.lastLines ?? [];
  }

  setLastLines(a: string, b: string, lines: string[]): void {
    // Same guard as `note`: this is a write path, and a self-edge is a row the
    // loader throws away on the next launch — so never mint one.
    if (!a || !b || a === b) return;
    const trimmed = lines.slice(0, 6);
    this.edge(a, b).lastLines = trimmed;
    this.edge(b, a).lastLines = trimmed;
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
