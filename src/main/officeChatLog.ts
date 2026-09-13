/**
 * OfficeChatterLog — the durable record of what the office actually SAID.
 *
 * WHY IT EXISTS. Since Phase 6 the break room is one continuous, model-written
 * conversation per pair, and `officeRel.ts` keeps the last six turns of it
 * (`lastTurns`) so the next brew can resume the thread. That window is a PROMPT
 * INPUT, not a history: it is capped at MAX_TURNS and every new exchange
 * overwrites the oldest turns in place. Nothing anywhere else keeps a line once
 * it scrolls out, so "show me the conversations, and a summary of them" has no
 * source to read. This file is that source, and nothing else: it is written to
 * and read back, it drives no decision, and no line in it can reach the work.
 *
 * ─── WHY A SEPARATE FILE AND NOT hive/log.jsonl ──────────────────────────────
 * The obvious move is the Phase 4 pattern — `observeTaskCompletions` appends a
 * `task_done` fact to `hive/log.jsonl` and the renderer projects it, so the log
 * stays the single source of truth and no second store appears. That pattern is
 * right for task closures and wrong for chatter, for four reasons:
 *
 *   1. VOLUME vs a file with no retention policy. Task closures are a handful a
 *      day. Chatter is bounded by the café brew budget at 8 exchanges/hour of up
 *      to 6 lines each — ~1,000 lines/day on a floor that talks, against a
 *      log.jsonl that is already ~600KB and has NO pruning at all. And it cannot
 *      get one: log.jsonl is the hive's operational audit trail (spawns, drops,
 *      routing, state-corruption alarms), so a retention policy there would
 *      delete operational history to make room for café gossip. The hard
 *      requirement that this record be BOUNDED is itself the argument for a
 *      separate file — you can only bound a file that is entirely disposable.
 *   2. `logTail` reads log.jsonl WHOLE (readFileSync + split + JSON.parse per
 *      line) on every call. Mixing a thousand daily gossip rows into it makes
 *      every operational read of that file proportionally slower and noisier.
 *   3. AGENTS READ log.jsonl. PROTOCOL.md points them at it as the event feed,
 *      and they quote it back in prompts. Café dialogue in there is context
 *      pollution aimed straight at the agents doing real work.
 *   4. LIFECYCLE. This belongs to the office-chatter feature, exactly like
 *      `office-relationships.json`: same flag, same home-root location, same
 *      obligation to ride a home MOVE and to be erased by a full RESET (a log of
 *      conversations between agents that a reset just retired is the same state
 *      leak `officeRel.purge()` exists to prevent). log.jsonl lives inside
 *      `hive/`, which the reset deletes wholesale — so a chatter record in there
 *      would be governed by the hive's lifecycle instead of the feature's.
 *
 * ─── RETENTION: BOUNDED TWICE, ON PURPOSE ────────────────────────────────────
 * A file that only ever grows, on a machine that runs 24/7, is a bug with a
 * delay fuse. So the log is bounded by AGE (`officeChatterLogDays`, default 7)
 * *and* by SIZE (`officeChatterLogMaxKb`, default 1 MB). Age alone is not a
 * bound: it is a bound on how far back the record goes, not on how big it gets,
 * and a chattier floor (or a lower brew budget raised in Settings) moves the
 * ceiling without anyone noticing. Size alone loses the property the tab wants
 * ("the last week"). Both, and the tighter one wins.
 *
 * PRUNING IS NOT ON A HOT PATH. It is triggered only from `record`, which runs
 * once per exchange handed to the floor — at most 8 times an hour, bounded by
 * the brew budget in officeChat.ts, and only while the flag is on. On top of
 * that it is throttled to at most once per PRUNE_INTERVAL_MS, or sooner only
 * when an eighth of the size ceiling has landed since the last pass (so a
 * pathological writer cannot outrun the bound by staying under the clock, and
 * the overshoot between passes stays proportional — see `pruneBytesFor`).
 * Everything else — the floor's polling, the IPC read path, message routing —
 * never prunes. The pass itself reads and rewrites a file that is capped at
 * ~1 MB by construction: a few milliseconds, twice an hour, at the very most.
 *
 * ─── RESILIENCE: WHY THE PHASE 5 NEVER-CLOBBER RULE DOES NOT APPLY HERE ──────
 * `readStateJson` in hive.ts refuses to overwrite a file that is PRESENT but
 * does not parse, because registry.json / tasks.json hold state nobody can
 * reconstruct and a default written over them destroys it silently. fleet.json
 * is explicitly exempt — it is a regenerable cache. This file is a third thing,
 * and it gets its own explicitly-argued policy rather than inheriting either:
 *
 *   • It is APPEND-ONLY JSONL, so the writer can never widen damage: a new line
 *     is appended after whatever is already there, never over it. The only
 *     corruption this format realistically produces is a half-written final line
 *     from a crash mid-append — self-limiting, and confined to one line.
 *   • PER-LINE tolerance instead of whole-file tolerance: a line that does not
 *     parse is skipped by the reader and dropped by the pruner. Refusing to
 *     prune a 1 MB file forever because one of its 8,000 lines is garbled would
 *     trade the bound (the actual bug being fixed) for one café line.
 *   • The pruner is the ONLY writer that rewrites, and it REFUSES to run when
 *     the file is present but cannot be READ at all (EACCES/EIO/EISDIR) — it
 *     skips the pass and leaves the bytes on disk, which is the never-clobber
 *     rule applied at the only point where it is actually at stake. Same shape
 *     as `observeTaskCompletions` skipping a tick on an unreadable ledger.
 *   • And the stake is low by construction: nothing reads this file to make a
 *     decision. It feeds one read-only panel. The prompt's continuity still
 *     comes from `officeRel.lastTurns`, which is untouched by any of this.
 *
 * ─── PRIVACY ────────────────────────────────────────────────────────────────
 * Recorded: who spoke to whom, the spoken line, when, and whether the line was
 * model-GENERATED. Nothing else. No local paths, no message bodies, no task
 * descriptions, no ids beyond the agent ids already on screen. The
 * subjects-never-bodies rule officeVoice.ts enforces toward the model is
 * enforced here toward DISK, and every line goes through officeWork's
 * `scrubTitle` on the way in — a model can echo a path back out of its context,
 * and the scrub is the reason it cannot then be persisted.
 *
 * The SAME lines are also persisted as `lastTurns` in `office-relationships.json`
 * (see the WHY A SEPARATE FILE note above — that window is a prompt input, this
 * file is the history), so that copy runs the identical scrub in
 * `officeRel.sanitizeTurns`. Scrubbing one destination and not the other would
 * have kept a path out of the record a human reads while leaving it in the file
 * that feeds the next prompt, which is the worse half to miss.
 *
 * ─── FEATURE FLAG ───────────────────────────────────────────────────────────
 * With `officeChatterEnabled` off, `record` returns before it resolves a path,
 * builds a row, or creates a directory: no file is created, none is opened, and
 * a floor that never speaks leaves nothing behind. This is the same flag-leak
 * bug Phases 2, 3 and 4 each had to fix once, so it is pinned by a test
 * (`office-chatter-log.test.cjs`) rather than asserted here.
 */
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

import { scrubTitle } from './officeWork';

/** The log's name at the hive home, beside `office-relationships.json`.
 *  Exported because the home-migration and full-reset paths in index.ts have to
 *  move and erase this file alongside the relationship book — see the LIFECYCLE
 *  argument above. */
export const CHATTER_LOG_FILE_NAME = 'office-chatter.jsonl';

/** Default retention window. A week is what "show me the conversations" means
 *  in practice, and it is short enough that the size bound below is rarely the
 *  one doing the work. */
export const DEFAULT_CHATTER_LOG_DAYS = 7;
/** Default size ceiling, in KB. ~1 MB is roughly a week of a genuinely talkative
 *  floor at the café brew budget, and a rounding error next to the hive it sits
 *  beside. */
export const DEFAULT_CHATTER_LOG_MAX_KB = 1024;

/** Clamps, applied to whatever the config getters return. The bound must not be
 *  removable by hand-editing config.json to 0 or -1: an unbounded log is the
 *  failure mode this module exists to prevent, so the floor of each range is a
 *  real floor. */
const MIN_DAYS = 1;
const MAX_DAYS = 90;
const MIN_KB = 64;
const MAX_KB = 16 * 1024;

/** Prune at most this often… */
const PRUNE_INTERVAL_MS = 30 * 60_000;
/** …unless this many bytes have been appended since the last pass, in which case
 *  the clock is ignored. Belt and braces: the clock alone lets a caller with a
 *  much higher brew budget grow the file between passes.
 *
 *  Derived from the ceiling rather than fixed, because it IS the overshoot: the
 *  file can reach `maxBytes + PRUNE_BYTES` before a pass trims it, so a fixed
 *  64 KB trigger would let someone who asked for a 64 KB log get a 128 KB one.
 *  An eighth keeps the overshoot proportional (≤12.5%) at every setting, and the
 *  4 KB floor keeps a tiny log from pruning on every single append. */
const pruneBytesFor = (maxBytes: number): number =>
  Math.min(64 * 1024, Math.max(4 * 1024, Math.floor(maxBytes / 8)));

/** A café line is a thought-cloud line. Capped here too, so a malformed caller
 *  cannot grow the file by the size of a paragraph. Matches MAX_TURN_CHARS in
 *  officeRel.ts — the same line is stored in both places. A BACKSTOP: `cleanText`
 *  runs `scrubTitle` first, whose own header cap (72) is tighter and normally
 *  gets there first. Kept because this module's bound must not depend on a
 *  constant that belongs to a different module's idea of "a title". */
const MAX_TEXT_CHARS = 90;

/** One SPOKEN LINE, the unit of the log. Deliberately flat and small: rows are
 *  appended one per line of JSON, so every byte is multiplied by ~1,000/day.
 *
 *  Grouping is by `conv` rather than by writing exchanges as nested arrays,
 *  because a conversation is exactly what a later sitting APPENDS to, and an
 *  append-only file cannot go back and grow a nested array. */
export interface ChatterLogRow {
  /** When the line was handed to the floor (ms). */
  ts: number;
  /** Exchange id — every line of one exchange shares it, so a panel can group
   *  the lines back into the conversation they were spoken in. */
  conv: string;
  /** The pair, in the order the exchange was played: `from` opened. */
  from: string;
  to: string;
  /** The SPEAKER's agent id — always `from` or `to`. The pair alone cannot say
   *  who said what, which is the same lesson `RelTurn.by` records. */
  by: string;
  /** What was said, scrubbed and length-capped. */
  text: string;
  /** Whether a model wrote this line.
   *
   *  Today it is always true — Phase 6 deleted the ~200 canned exchanges, so
   *  every line the floor speaks is model-written. The field is recorded anyway
   *  because the tab this log exists for SUMMARIZES these conversations, and a
   *  summary that silently blends authored text with generated text is a lie
   *  about its own provenance. When something non-generated speaks again, old
   *  rows already say which kind they were instead of having to be guessed. */
  gen: boolean;
}

export interface ChatterLogOptions {
  /** False for a line that was not written by a model. Defaults to true. */
  generated?: boolean;
  /** Timestamp override — tests only; production always uses the wall clock. */
  at?: number;
}

interface Deps {
  /** The harness home. No home ⇒ no log: unlike the relationship book (which
   *  falls back to userData because its rows are state the app must not lose
   *  between hive selections), a transcript with no hive to belong to is not
   *  worth minting a file for in a directory nothing else here writes to. */
  getHome: () => string | null | undefined;
  /** `officeChatterEnabled`. Checked FIRST in every write path. */
  isEnabled: () => boolean;
  getRetentionDays?: () => number | null | undefined;
  getMaxKb?: () => number | null | undefined;
}

const clampInt = (raw: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/** Write `text` to `path` atomically: temp sibling → fsync → rename over target.
 *  Mirrors officeRel.ts's atomicWriteFile / hive.ts's atomicWriteJson. The
 *  pruner is the only rewriter in this module and it must never be able to
 *  leave a truncated file behind — that would be the module manufacturing the
 *  very corruption its reader tolerates. */
function atomicWriteFile(path: string, text: string): void {
  const tmp = `${path}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* fsync best-effort; rename is the durability guarantee */ }
  renameSync(tmp, path);
}

/** One line, cleaned for disk. Returns '' for anything that should not be
 *  written at all. `scrubTitle` is reused rather than reimplemented: it is the
 *  same path/credential filter the work projection already applies to anything
 *  crossing to the model, and a line the model echoed a path into is exactly
 *  what must not then be persisted. */
function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // scrubTitle folds CR/LF/TAB to spaces itself, which also guarantees the one
  // structural invariant JSONL has: a row is exactly one line.
  const s = scrubTitle(raw);
  if (!s) return '';
  return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS - 1).trimEnd() + '…' : s;
}

export class OfficeChatterLog {
  /** Bytes appended since the last prune pass — the size half of the trigger. */
  private appendedSincePrune = 0;
  /** When the last pass ran. 0 means "never in this process", which forces one
   *  pass on the first append: a machine that has been running for a week, or
   *  one that was restarted after the retention window elapsed, must not have to
   *  wait out PRUNE_INTERVAL_MS before the bound is enforced again. */
  private lastPruneAt = 0;

  constructor(private deps: Deps) {}

  /** Where the log lives, or null when no home is open — or when the configured
   *  home does not exist yet, which is the pre-onboarding shape. Null means
   *  nothing is written, read or pruned: the transcript never creates the
   *  directory it would live in. */
  filePath(): string | null {
    const home = this.deps.getHome();
    if (!home || !existsSync(home)) return null;
    return join(home, CHATTER_LOG_FILE_NAME);
  }

  private retentionMs(): number {
    return clampInt(this.deps.getRetentionDays?.(), MIN_DAYS, MAX_DAYS, DEFAULT_CHATTER_LOG_DAYS)
      * 24 * 3_600_000;
  }

  private maxBytes(): number {
    return clampInt(this.deps.getMaxKb?.(), MIN_KB, MAX_KB, DEFAULT_CHATTER_LOG_MAX_KB) * 1024;
  }

  /**
   * Append one exchange, one row per spoken line.
   *
   * `lines` alternate starting with `from` — the same contract the floor plays
   * them on and `RelationshipBook.noteTurns` derives attribution from, so who
   * said what is derived here too rather than guessed.
   *
   * @returns how many rows were written (0 when the flag is off, there is no
   *          home, or nothing survived cleaning).
   */
  record(from: string, to: string, lines: string[], opts: ChatterLogOptions = {}): number {
    // INERTIA FIRST. With the chatter off there is no dialogue, so there is
    // nothing to record — and this must cost zero disk I/O, not "a cheap write".
    if (!this.deps.isEnabled()) return 0;
    if (!from || !to || from === to || !Array.isArray(lines) || lines.length === 0) return 0;
    const path = this.filePath();
    if (!path) return 0;

    const at = Number.isFinite(opts.at) ? Number(opts.at) : Date.now();
    const gen = opts.generated !== false;
    const conv = `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const rows: ChatterLogRow[] = [];
    for (let i = 0; i < lines.length; i++) {
      const text = cleanText(lines[i]);
      if (!text) continue;
      rows.push({ ts: at, conv, from, to, by: i % 2 === 0 ? from : to, text, gen });
    }
    if (rows.length === 0) return 0;

    // A crash mid-append leaves a final line with no newline on it. Appending
    // straight onto that would GLUE the next row to the damaged one, turning a
    // one-line loss into an unbounded run of them — the corruption would grow
    // with every later exchange instead of staying confined. So: if the file
    // does not end in a newline, start with one. Costs one stat + one byte read,
    // on a path that runs a handful of times an hour.
    const payload = (this.needsLeadingNewline(path) ? '\n' : '')
      + rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, payload, 'utf8');
    } catch {
      return 0; // best-effort: a transcript is never worth failing a café beat
    }
    this.appendedSincePrune += Buffer.byteLength(payload, 'utf8');
    this.maybePrune(at);
    return rows.length;
  }

  /** Does the file end mid-line? True only for a file that exists, is non-empty
   *  and whose last byte is not a newline — i.e. one a crash caught mid-append.
   *  Any error answers "no": a file we cannot stat or open is one `record` is
   *  about to fail on anyway, and guessing "yes" would prepend a stray newline. */
  private needsLeadingNewline(path: string): boolean {
    try {
      const size = statSync(path).size;
      if (size === 0) return false;
      const fd = openSync(path, 'r');
      try {
        const buf = Buffer.alloc(1);
        readSync(fd, buf, 0, 1, size - 1);
        return buf[0] !== 0x0a;
      } finally { closeSync(fd); }
    } catch { return false; }
  }

  /** Rows currently on disk, oldest first, at most `limit` (newest kept).
   *  Read-only and tolerant: unparseable lines are SKIPPED, never repaired and
   *  never a reason to return nothing. Safe to call with the flag off — reading
   *  a record that already exists writes nothing. */
  read(limit = 2_000): ChatterLogRow[] {
    const path = this.filePath();
    if (!path) return [];
    let raw: string;
    try { raw = readFileSync(path, 'utf8'); } catch { return []; }
    const out: ChatterLogRow[] = [];
    for (const line of raw.split('\n')) {
      const row = parseRow(line);
      if (row) out.push(row);
    }
    return limit > 0 && out.length > limit ? out.slice(-limit) : out;
  }

  /** Throttled trigger — see the PRUNING IS NOT ON A HOT PATH note above. */
  private maybePrune(now: number): void {
    const due = this.lastPruneAt === 0
      || this.appendedSincePrune >= pruneBytesFor(this.maxBytes())
      || now - this.lastPruneAt >= PRUNE_INTERVAL_MS;
    if (!due) return;
    this.prune(now);
  }

  /**
   * Enforce both bounds, keeping the NEWEST lines.
   *
   * Age first (a line older than the retention window goes whatever the size
   * says), then size (walking newest → oldest and stopping at the ceiling). A
   * row with no usable timestamp is dropped: it cannot be aged out, so keeping
   * it would mean a row that lives forever.
   *
   * Refuses to rewrite a file it could not read — see the RESILIENCE note. The
   * throttle marks are updated either way, so an unreadable file is not retried
   * on every single append.
   *
   * @returns true when the file was rewritten.
   */
  prune(now = Date.now()): boolean {
    this.lastPruneAt = now;
    this.appendedSincePrune = 0;
    const path = this.filePath();
    if (!path) return false;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      // Absent is the normal first-run shape; present-but-unreadable is an
      // incident. Neither is a reason to WRITE — in the second case writing is
      // precisely what must not happen.
      return false;
    }
    const cutoff = now - this.retentionMs();
    const maxBytes = this.maxBytes();
    const source = raw.split('\n');
    const kept: string[] = [];
    let bytes = 0;
    for (let i = source.length - 1; i >= 0; i--) {
      const line = source[i].trim();
      if (!line) continue;
      const row = parseRow(line);
      if (!row) continue;          // garbled line — dropped, never fatal
      if (row.ts < cutoff) continue; // aged out
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (bytes + size > maxBytes) break; // size ceiling reached; older lines go
      bytes += size;
      kept.push(line);
    }
    kept.reverse();
    const next = kept.length ? kept.join('\n') + '\n' : '';
    if (next === raw) return false; // nothing to do — do not touch the file
    try { atomicWriteFile(path, next); } catch { return false; }
    return true;
  }

  /** Erase the log. Called by the full reset for the same reason
   *  `officeRel.purge()` is: these rows are keyed by agent ids the reset just
   *  retired, so leaving the file in the home root would let re-selecting the
   *  folder resurrect a week of conversations belonging to agents whose sessions
   *  and memory are gone. */
  purge(): void {
    this.appendedSincePrune = 0;
    this.lastPruneAt = 0;
    const path = this.filePath();
    if (!path) return;
    try { rmSync(path, { force: true }); } catch { /* best-effort */ }
  }
}

/** Parse one JSONL line into a row, or null. Every field is validated: this
 *  reads a file a user can hand-edit and a crash can truncate. */
function parseRow(line: string): ChatterLogRow | null {
  const text = line.trim();
  if (!text) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Partial<ChatterLogRow>;
  const ts = Number(r.ts);
  if (!Number.isFinite(ts)) return null;
  if (typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.by !== 'string') return null;
  if (typeof r.text !== 'string' || !r.text) return null;
  if (!r.from || !r.to || !r.by) return null;
  return {
    ts,
    conv: typeof r.conv === 'string' ? r.conv : '',
    from: r.from,
    to: r.to,
    by: r.by,
    text: r.text,
    gen: r.gen !== false
  };
}
