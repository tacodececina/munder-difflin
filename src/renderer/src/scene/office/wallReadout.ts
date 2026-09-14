/**
 * WHAT THE OFFICE WALLS ARE ALLOWED TO SAY.
 *
 * The rebuilt floor hung two instrument surfaces on the wall: a panoramic
 * display over 01/OPERATIONS and a planning whiteboard in 04/BRIEFING. Both
 * shipped with INVENTED content — a "99.98 UPTIME", a nine-bar chart whose
 * heights were a literal array in the art, an API→CORE→DB service topology
 * describing services that do not exist, and four sticky notes under a
 * PLAN / BUILD / SHIP header that corresponded to no card anywhere.
 *
 * That is the same defect the canned café dialogue had, and it gets the same
 * treatment. This module is the honest replacement: every mark those two
 * surfaces now draw is DERIVED, here, from something the app already knows, and
 * anything that cannot be derived is drawn as an explicit "no data" rather than
 * as a plausible value.
 *
 * WHERE EACH READING COMES FROM (no new infrastructure, no new source of truth)
 *
 *   AGENTS  ← `control:breakerState`. Main's breaker beat (src/main/breaker.ts,
 *             every 30 s) already pushes one state per live agent, and this
 *             scene already subscribes for the weather. One pip per reporting
 *             agent, coloured by level. Cost: zero — a second reader of a
 *             stream that was already flowing.
 *   CI      ← `window.cth.githubCIRuns(repo)` → `listCIRuns` → the `gh` CLI.
 *             A NETWORK call, so it runs on the slowest cadence on the floor
 *             (see CI_POLL_MS) and degrades silently: no repo registered, no
 *             `gh`, not authenticated, not a repo — all of them are `null`,
 *             which the wall draws as NO DATA.
 *   SHIPPED ← `window.cth.hiveLog()` → `hive/log.jsonl`, filtered through the
 *             legend's own `readTaskDoneEvents`. One bar per hour of real
 *             closures. NOT re-implemented here: the legend tab and this wall
 *             read the same rows through the same parser. The read is a TAIL of
 *             the feed, so it can be shorter in TIME than the chart is wide —
 *             see SHIPPED_LOG_WINDOW and `bucketShipped`, which report the hours
 *             the tail did not reach as unmeasured rather than as quiet ones.
 *   PLAN /  ← `window.cth.hiveTasks()` → `hive/tasks.json`, on the 5 s poll the
 *   BUILD /   cork boards already run. Zero additional IPC.
 *   SHIP
 *
 *   (`listIssues` was the fourth candidate and is deliberately NOT used. GitHub
 *   issues are not a statement about this floor — they become work only once
 *   somebody assigns one, at which point they are a ledger card and already on
 *   the boards. A second surface counting un-ingested issues would be a number
 *   about a repository, dressed as a number about the room.)
 *
 * THE HARD RULE
 *   `null` means "this surface could not read its source" and MUST render as
 *   NO DATA. It is deliberately distinct from a real zero: a repo with no
 *   workflow runs returns `[]`, an hour with no closures returns `0`, an empty
 *   ledger column returns `0`. Those are facts and are drawn as facts. Only a
 *   failure is blank.
 *
 *   The rule is applied PER BAR as well as per panel: a single hour of the
 *   SHIPPED chart is `null` when the slice of the feed we read does not reach
 *   back that far. Drawing that hour as a measured zero would be the same
 *   invention as the uptime number this module deleted, only smaller and much
 *   harder to notice.
 *
 * LEGIBILITY
 *   These are 16px-cell pixel props. A six-digit number does not fit and a
 *   five-pixel-tall glyph stops being a glyph when the camera pulls back, so
 *   the wall prefers SHAPE to DIGITS: pips, chips and bars carry the readings,
 *   and the only numbers anywhere are the three ledger column counts, capped at
 *   three digits (`countLabel`) because that is what fits inside one column.
 *
 * Kept free of React and of Pixi — pure data in, pure data out — so every rule
 * above is unit-testable on its own. Same discipline as weather.ts,
 * idleAffinity.ts and wingFraming.ts. (The Pixi side is WallPanel.ts, spelled
 * differently on purpose: this repo is built on a case-insensitive filesystem,
 * where `wallReadout.ts` and `WallReadout.ts` are the same file.)
 */
import { readTaskDoneEvents } from '@/store/legend';
import { levelsOf, type BreakerLevel, type BreakerReading } from './weather';

/** How a finished (or unfinished) GitHub Actions run reads on the wall. */
export type CIState = 'pass' | 'fail' | 'running' | 'other';

/** How many recent runs the CI strip has room for. `listCIRuns` asks for 5. */
export const CI_SLOTS = 5;

/** One bar per hour. Nine of them, which is exactly the number of bars the
 *  invented chart drew — the slot in the composition was fine, its contents
 *  were the problem. The art draws the same nine (techOfficeArt's `BARS`); the
 *  readout tests pin the two to each other. */
export const SHIPPED_BUCKETS = 9;
export const SHIPPED_BUCKET_MS = 60 * 60 * 1000;

/** Cadence for the two polled sources. The breaker needs neither — it is
 *  pushed. `hive/log.jsonl` is a local file read; `gh` is a network call and a
 *  subprocess, so it runs five times slower still and is allowed to fail. */
export const SHIPPED_POLL_MS = 60_000;
export const CI_POLL_MS = 5 * 60_000;

/** How much of the append-only event feed to read for the SHIPPED bars.
 *
 *  `hive:log` answers with the LAST n rows of `log.jsonl`, and the file carries
 *  every kind of hive event — every routed message, every ledger write, every
 *  spawn and drain — not just the closures this chart counts. So on a talkative
 *  floor these 400 rows can span less wall time than the nine hours the chart
 *  draws, and the hours off the top of the tail were never actually measured.
 *  `bucketShipped` detects exactly that case (a full window whose oldest row is
 *  younger than a bucket) and returns those hours as `null`. Raising this number
 *  buys more history; it cannot make the truncation impossible, which is why the
 *  guard exists rather than a bigger constant. */
export const SHIPPED_LOG_WINDOW = 400;

/** Everything the operations wall displays, or `null` per panel where the
 *  source could not be read. */
export interface OpsReadout {
  /** One level per agent currently reporting to the breaker beat, stably
   *  ordered. `null` when nobody is reporting — see levelsOf's note on why an
   *  empty floor is not an all-clear. */
  agents: BreakerLevel[] | null;
  /** Up to CI_SLOTS recent workflow runs, OLDEST FIRST (so the newest sits at
   *  the end of the strip, where a log reads). `[]` is a real answer: the repo
   *  has no runs. `null` is "could not ask". */
  ci: CIState[] | null;
  /** Closures per hour, oldest bucket first, the last one being the hour in
   *  progress. The whole field is `null` when the event feed could not be read;
   *  an individual hour is `null` when the slice of the feed we read did not
   *  reach back to it (see `bucketShipped`). */
  shipped: ShippedBuckets | null;
}

/** The ledger as the PLAN / BUILD / SHIP board reads it. */
export interface PlanBoard {
  /** `todo` — written down, not started. */
  plan: number;
  /** `doing` — picked up by somebody. */
  build: number;
  /** `blocked` — picked up and stuck. Drawn inside the BUILD column, in the
   *  blocked colour: work in flight that stopped is still work in flight, and
   *  the floor already has a dedicated BLOCKERS cork board for the roll-call. */
  blocked: number;
  /** `done`. */
  ship: number;
}

/** An empty wall: every panel unreadable. The state a surface starts in, before
 *  its first poll answers. */
export const NO_READOUT: OpsReadout = { agents: null, ci: null, shipped: null };

function rows(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * One workflow run → one chip.
 *
 * `gh run list` reports `status` (queued / in_progress / completed / …) and,
 * once complete, `conclusion` (success / failure / cancelled / skipped / …).
 * Anything not recognised is `other` — a grey chip — rather than being guessed
 * into pass or fail.
 */
export function ciStateOf(run: { status?: unknown; conclusion?: unknown } | null | undefined): CIState {
  const status = str(run?.status).toLowerCase();
  const conclusion = str(run?.conclusion).toLowerCase();
  if (status && status !== 'completed') {
    return status === 'queued' || status === 'in_progress' || status === 'waiting'
      || status === 'pending' || status === 'requested' ? 'running' : 'other';
  }
  if (conclusion === 'success') return 'pass';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure') return 'fail';
  return 'other';
}

/**
 * The CI strip, from a raw `githubCIRuns` reply.
 *
 * `null` for every failure mode the call has — no repo configured (the caller
 * passes `null`), `gh` missing, unauthenticated, not a repository, a rejected
 * promise — because none of them is a statement about the build.
 */
export function summarizeCIRuns(reply: unknown): CIState[] | null {
  if (!reply || typeof reply !== 'object') return null;
  const res = reply as { ok?: unknown; runs?: unknown };
  if (res.ok !== true) return null;
  const raw = rows(res.runs);
  if (!raw) return null;
  // `gh` lists newest first; the strip reads left-to-right like a log, so the
  // newest run has to end up on the RIGHT.
  return raw.slice(0, CI_SLOTS)
    .map((r) => ciStateOf(r as { status?: unknown; conclusion?: unknown }))
    .reverse();
}

/** One hour of the SHIPPED chart: a counted number of closures, or `null` for
 *  an hour the feed we read never covered. */
export type ShippedBuckets = (number | null)[];

/** The oldest instant the rows we were handed can speak for.
 *
 * `hive:log` is a tail, so a FULL window means the feed was cut at the top and
 * we only know about events from its oldest row onward. A short window is the
 * whole file and therefore covers all of time. If a full window carries no
 * usable timestamp at all (every row malformed, or an event kind that predates
 * `ts`), nothing can be proven measured — `Infinity`, which blanks every bar
 * rather than inventing nine quiet hours.
 */
function coverageStart(feed: readonly unknown[], window: number): number {
  if (feed.length < window) return -Infinity;
  let oldest = Infinity;
  for (const row of feed) {
    if (!row || typeof row !== 'object') continue;
    const ts = (row as { ts?: unknown }).ts;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts < oldest) oldest = ts;
  }
  return oldest;
}

/**
 * Closures per hour over the last SHIPPED_BUCKETS hours, oldest first.
 *
 * The buckets are anchored on `now`, not on the wall clock, so the rightmost
 * bar is always "the hour that is happening" and the chart never shows a
 * half-elapsed bucket as a slump. Events outside the window — and events the
 * legend's parser rejects, a row without a task id or a numeric timestamp — are
 * dropped rather than rounded into the nearest bar.
 *
 * WHAT THE FEED DOES NOT COVER IS NOT A ZERO. We are handed the last `window`
 * rows of a file that logs everything the hive does, so on a busy floor those
 * rows can begin well after the leftmost bar does. Every hour that opens before
 * the oldest row we hold is returned as `null` — including an hour the tail
 * covers only PARTWAY, because a partial count is a wrong count, not a small
 * one. `null` is drawn as an unmeasured hour; `0` keeps meaning "measured, and
 * nothing shipped".
 *
 * @param window how many rows were ASKED for. The caller must pass the same
 *               number it gave `hiveLog`, or this cannot tell a complete feed
 *               from a truncated one.
 */
export function bucketShipped(
  log: unknown,
  now: number,
  window: number = SHIPPED_LOG_WINDOW
): ShippedBuckets | null {
  const feed = rows(log);
  if (!feed) return null;
  const start = now - SHIPPED_BUCKETS * SHIPPED_BUCKET_MS;
  const covered = coverageStart(feed, window);
  const buckets: ShippedBuckets = [];
  for (let i = 0; i < SHIPPED_BUCKETS; i++) {
    buckets.push(covered > start + i * SHIPPED_BUCKET_MS ? null : 0);
  }
  for (const event of readTaskDoneEvents(feed)) {
    if (event.at <= start || event.at > now) continue;
    const index = Math.min(
      SHIPPED_BUCKETS - 1,
      Math.floor((event.at - start) / SHIPPED_BUCKET_MS)
    );
    // An event inside an hour we cannot vouch for stays uncounted: the bar says
    // "unknown", and a partially-filled bar would say "this is the whole hour".
    const counted = buckets[index];
    if (counted !== null) buckets[index] = counted + 1;
  }
  return buckets;
}

/**
 * The PLAN / BUILD / SHIP counts, from a raw `hiveTasks` reply.
 *
 * Unrecognised statuses are counted nowhere: the board has three columns and a
 * card whose status is not one of the four the ledger defines does not belong
 * in any of them. Silently folding it into `plan` would be the same class of
 * invention this module exists to remove.
 */
export function summarizePlanBoard(reply: unknown): PlanBoard | null {
  if (!reply || typeof reply !== 'object') return null;
  const raw = rows((reply as { tasks?: unknown }).tasks);
  if (!raw) return null;
  const board: PlanBoard = { plan: 0, build: 0, blocked: 0, ship: 0 };
  for (const task of raw) {
    if (!task || typeof task !== 'object') continue;
    switch (str((task as { status?: unknown }).status)) {
      case 'todo': board.plan++; break;
      case 'doing': board.build++; break;
      case 'blocked': board.blocked++; break;
      case 'done': board.ship++; break;
      default: break;
    }
  }
  return board;
}

/** The AGENTS pips: the breaker readings, projected one-per-agent. Empty means
 *  nobody is reporting, and the wall has to say so — hence `null`. */
export function agentPips(
  readings: Iterable<BreakerReading>,
  now: number,
  present?: ReadonlySet<string>
): BreakerLevel[] | null {
  const levels = levelsOf(readings, now, present);
  return levels.length > 0 ? levels : null;
}

/**
 * A count as it can honestly be printed inside one 3-glyph-wide board column.
 *
 * Beyond 999 there is no room, and a clamped "999" would be a lie, so the
 * number is dropped entirely and the saturated note pile carries the reading on
 * its own. Negative and non-finite counts never reach the wall.
 */
export function countLabel(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  const whole = Math.floor(n);
  return whole <= 999 ? String(whole) : '';
}

/**
 * A reading and the instant it was taken.
 *
 * Every polled panel here is fed by a call that can fail, and a call that fails
 * must not freeze a number on the wall forever. This is weather.ts's "readings
 * expire" discipline applied to the instruments: a transient miss keeps the
 * last answer (the floor does not flicker over one dropped file read), and a
 * source that has been silent for longer than its TTL lapses to `null`, which
 * is drawn as NO DATA.
 */
export interface Held<T> { value: T; at: number }

/** The held reading if it is still believable, `null` once it has lapsed. */
export function heldValue<T>(held: Held<T> | null | undefined, now: number, ttl: number): T | null {
  if (!held || !Number.isFinite(held.at)) return null;
  return now - held.at < ttl ? held.value : null;
}

/** Four missed ledger polls. The cork boards beside this whiteboard read the
 *  same file on the same 5 s timer, so this is deliberately short. */
export const PLAN_TTL_MS = 4 * 5_000;
/** Three missed log reads plus slack — the same shape as weather's TTL. */
export const SHIPPED_TTL_MS = 3 * SHIPPED_POLL_MS + 5_000;
/** Three missed CI polls. `gh` is a subprocess over the network; one flaky call
 *  is not news, sixteen silent minutes are. */
export const CI_TTL_MS = 3 * CI_POLL_MS + 60_000;

/** Cheap change detector, so a poll that answered the same thing repaints
 *  nothing. `null` and `[]` must not collapse to the same key, and neither may
 *  an unmeasured hour and a zero one — that is the whole no-data/real-zero
 *  distinction, which is why the members are spelled out rather than left to
 *  `join`'s habit of printing `null` as an empty string. */
export function readoutSignature(r: OpsReadout): string {
  const part = (v: readonly unknown[] | null): string =>
    (v === null ? '-' : v.map((x) => (x === null || x === undefined ? '?' : String(x))).join(','));
  return `${part(r.agents)}|${part(r.ci)}|${part(r.shipped)}`;
}

/** Same idea, for the ledger board. */
export function planSignature(b: PlanBoard | null): string {
  return b === null ? '-' : `${b.plan},${b.build},${b.blocked},${b.ship}`;
}
