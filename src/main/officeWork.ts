/**
 * officeWork — a READ-ONLY, privacy-scrubbed projection of what the office is
 * actually working on, for the break-room dialogue director to talk ABOUT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BOUNDARY. THIS IS INVIOLABLE AND THERE IS NO OPTION ON IT.
 *
 * Coworkers talk about work. That is the whole reason this file exists: two
 * agents at a café table should be able to trade an idea about the card one of
 * them is stuck on. But the dialogue is DECORATION, and decoration must never
 * become control. So:
 *
 *   • This module only ever READS. It exports pure functions over a ledger
 *     value someone else already read. It imports nothing that can write, holds
 *     no HiveManager, opens no file, and has no side effects at all.
 *   • The dialogue director receives a `WorkContext` — a plain, frozen data
 *     value. It is given no writer, no ipc handle and no hive reference, so
 *     there is no path from a café line to a task.
 *   • Nothing produced by the model from this context is ever routed back into
 *     the hive. A brew's only output is `string[]`, and its only destination is
 *     a thought cloud above a pixel avatar. It cannot change a decision, an
 *     assignment, a task status, a message, a file, or anything else
 *     operational. A café line that says "we should drop card 4" drops nothing.
 *   • The hidden-CLI brew route additionally runs with EVERY built-in tool
 *     disallowed — reads and network included, not just the writing ones (see
 *     brewSlot.BREW_DISALLOWED_TOOLS) — so a prompt-injected brew has nothing
 *     to act WITH either: no file to open, no command to run, no request to
 *     make. Its only output is text, and text only reaches a thought cloud.
 *     (That list forbids tools by name; tools a user's own MCP servers add
 *     cannot be named ahead of time, which is one more reason `scrubTitle`
 *     below exists rather than being left to the tool policy.)
 *
 * If a future change would let anything here flow back INTO the hive, that is
 * not an extension of this feature — it is a different feature, and it does not
 * belong behind a decoration's flag.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PRIVACY — the same rule officeVoice.ts already enforces on work messages:
 * only SUBJECT-grade text crosses to the model, never bodies. Task cards are
 * the same shape of thing. A card's `title` is a short human-authored header,
 * so titles (scrubbed) and statuses cross. Its `description`, `result`,
 * `humanQA`, `slack` thread ids and `webhook` token hash do NOT — descriptions
 * routinely carry repro steps with absolute paths, results carry output, and
 * humanQA carries whatever the operator typed. None of them are read here; they
 * are not merely filtered at the end, they never enter the projection.
 *
 * `scrubTitle` is the second line of that defence: even a title can have a path
 * or a token pasted into it, so path-shaped and token-shaped substrings are
 * replaced before the value leaves this module.
 */

/** A task card as this projection sees it: a header and a state, nothing else.
 *  Deliberately NOT a subset type of HiveTask — a structural subset would grow
 *  new fields the moment HiveTask did. */
export interface WorkNote {
  /** The card's title, scrubbed (see `scrubTitle`) and length-capped. */
  title: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  /** Whose card it is, relative to the two agents at the table. Ids are NOT
   *  included — the prompt names the two speakers itself, and a third agent's
   *  id adds nothing a café line can honestly use. */
  owner: 'a' | 'b' | 'other' | 'nobody';
}

/** Everything the dialogue director is told about the real work. Frozen: it is
 *  handed to a prompt builder, which has no business mutating it. */
export interface WorkContext {
  /** At most MAX_NOTES cards, most relevant to these two first. */
  notes: WorkNote[];
  /** Board-wide counts, so a line can register "it's a rough day" without
   *  naming cards neither of them owns. */
  blocked: number;
  doing: number;
}

/** The empty reading — no hive, no ledger, an unreadable ledger, or a board
 *  with nothing on it. Shared frozen constant, not a scratch object. */
export const EMPTY_WORK: WorkContext = Object.freeze({
  notes: Object.freeze([] as WorkNote[]) as WorkNote[], blocked: 0, doing: 0
});

/** How many cards a café conversation can plausibly be about. Four keeps the
 *  prompt short (this is a decoration on a token budget — see
 *  chatterOpenAI.ChatterTokenLedger) and keeps the model from reciting a board. */
export const MAX_NOTES = 4;
/** Titles are headers; anything longer is a description wearing a title's hat. */
const MAX_TITLE_CHARS = 72;

const STATUSES = new Set(['todo', 'doing', 'blocked', 'done']);

/**
 * Strip anything path-shaped or credential-shaped out of a title.
 *
 * Titles are supposed to be headers ("fix the flaky login test"), but they are
 * free text typed by an operator or written by an agent, so one can perfectly
 * well read "fix C:\Users\alex\keys\prod.pem". The dialogue model is a
 * background session — often, by design, a THIRD-PARTY endpoint (see
 * chatterProvider) — and a local path or a token has no business there.
 *
 * Replaced, not dropped: a title that becomes "fix …" still tells the model
 * something true about the shape of the work.
 */
export function scrubTitle(raw: string): string {
  let s = String(raw ?? '').replace(/[\r\n\t]+/g, ' ');
  // URLs FIRST — they can carry userinfo, query tokens and internal hostnames,
  // and a URL is one thing. Left until after the path rules, `https://host/a/b`
  // gets eaten from its middle out and what survives is a stump like "htt…"
  // rather than a clean "…". Same amount scrubbed, less nonsense sent.
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '…');
  // Windows paths that ANNOUNCE themselves — a drive letter (C:\dump.sql,
  // C:/dump.sql) or a UNC prefix (\\server\share). ONE separator is enough
  // here: the prefix already proves it is a path, so requiring a second
  // separator (as this rule used to) let "fix C:\secrets.pem" through intact —
  // a root-of-drive filename is exactly the kind of substring this function
  // promises to replace. The lookbehind keeps the drive letter from being read
  // out of the middle of a word.
  s = s.replace(/(?<![A-Za-z])(?:[A-Za-z]:[\\/]|\\\\)[^\s"']*/g, '…');
  // Backslash paths with no such prefix (src\main\officeWork.ts) still need two
  // separators, so a stray escape in ordinary prose is not mistaken for a path.
  s = s.replace(/[^\s"']*\\[^\s"']*\\[^\s"']*/g, '…');
  // ~-relative paths: one separator again, because `~/` is itself the prefix
  // that proves it ("~/prod.pem" used to survive the two-segment rule below).
  s = s.replace(/~\/[^\s"']*/g, '…');
  // POSIX absolute and dot-relative paths, two or more segments deep so a bare
  // "and/or" in prose survives.
  s = s.replace(/\.{0,2}\/[^\s"']*\/[^\s"']*/g, '…');
  // A single-segment absolute path is ambiguous ("and/or", "24/7"), so it is
  // only scrubbed when it starts a token AND carries a file extension —
  // "/dump.sql" is a path, "and/or" is not.
  s = s.replace(/(?<![^\s"'([])\/[^\s"'/]*\.[A-Za-z0-9]{1,8}\b/g, '…');
  // Long opaque runs: api keys, bearer tokens, hashes, base64 blobs.
  s = s.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '…');
  // Anything shaped like `KEY=value` / `TOKEN: value`.
  s = s.replace(/\b[A-Z][A-Z0-9_]{2,}\s*[:=]\s*\S+/g, '…');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s.length > MAX_TITLE_CHARS ? s.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + '…' : s;
}

/** How interesting a card is to THESE two, lowest sorts first. A card one of
 *  them owns beats a stranger's; a blocked card beats one merely in flight;
 *  a finished card is the least worth a coffee. */
function rank(note: WorkNote): number {
  const mine = note.owner === 'a' || note.owner === 'b' ? 0 : 4;
  const state = note.status === 'blocked' ? 0 : note.status === 'doing' ? 1 : note.status === 'todo' ? 2 : 3;
  return mine + state;
}

/**
 * Project a raw `hive/tasks.json` value into the read-only context.
 *
 * Takes the ALREADY-READ ledger rather than reading it, so this file stays
 * pure and the caller owns the I/O (and its caching — see index.ts, which keeps
 * one short-lived snapshot so a brew never puts a disk read on a hot path).
 *
 * Defensive throughout: the ledger is hand-edited by agents and can be any
 * shape at all. Anything unrecognised is skipped, never repaired, and the worst
 * case is an empty context — which simply means the pair talks about something
 * other than the board.
 */
export function projectWorkContext(ledger: unknown, aId: string, bId: string): WorkContext {
  const rows = (ledger && typeof ledger === 'object' && Array.isArray((ledger as { tasks?: unknown }).tasks))
    ? (ledger as { tasks: unknown[] }).tasks
    : null;
  if (!rows || rows.length === 0) return EMPTY_WORK;
  let blocked = 0;
  let doing = 0;
  const notes: WorkNote[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    // Read ONLY these two fields plus the assignee id. Everything else on the
    // card (description, result, humanQA, slack, webhook, …) is never touched;
    // see the privacy note at the top of this file.
    const { title, status, assignee } = row as { title?: unknown; status?: unknown; assignee?: unknown };
    if (typeof status !== 'string' || !STATUSES.has(status)) continue;
    if (status === 'blocked') blocked++;
    else if (status === 'doing') doing++;
    const clean = typeof title === 'string' ? scrubTitle(title) : '';
    if (!clean) continue;
    const owner: WorkNote['owner'] =
      assignee === aId ? 'a' : assignee === bId ? 'b'
        : typeof assignee === 'string' && assignee ? 'other' : 'nobody';
    notes.push({ title: clean, status: status as WorkNote['status'], owner });
  }
  notes.sort((x, y) => rank(x) - rank(y));
  return Object.freeze({ notes: notes.slice(0, MAX_NOTES), blocked, doing });
}

/** The context as prompt text, or '' when there is nothing worth saying. Kept
 *  here beside the projection so the only place that knows how work is PHRASED
 *  is the same place that knows what work is allowed to cross. */
export function workContextProse(work: WorkContext | null | undefined): string {
  if (!work || (work.notes.length === 0 && work.blocked === 0 && work.doing === 0)) return '';
  const lines: string[] = ['What the office is actually working on right now (READ-ONLY context):'];
  for (const n of work.notes) {
    const who = n.owner === 'a' ? "A's card" : n.owner === 'b' ? "B's card"
      : n.owner === 'other' ? "a colleague's card" : 'unassigned';
    lines.push(`  - [${n.status}] ${JSON.stringify(n.title)} (${who})`);
  }
  if (work.blocked || work.doing) {
    lines.push(`  Board: ${work.doing} card(s) in flight, ${work.blocked} blocked.`);
  }
  return lines.join('\n');
}
