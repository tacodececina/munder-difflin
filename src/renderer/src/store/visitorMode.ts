/**
 * VISITOR MODE — the screen-redaction policy, as data.
 *
 * WHY THIS EXISTS
 * ---------------
 * The office floor is the part of this app worth showing to someone outside the
 * team — a guest at the desk, a remote screen-only viewer, a demo. Everything
 * AROUND the floor is not: the terminal is raw model output (paths, env dumps,
 * a pasted token, whatever the agent happened to print), the threads panel is
 * the hive's internal mail, traces name the exact files being edited, and the
 * god's Command Center is the whole operation at once.
 *
 * Visitor mode is the switch that keeps the first thing and removes the second.
 *
 * THE RULE
 * --------
 * A surface is either SEALED (replaced by a placeholder — never rendered, not
 * merely blurred) or it is not. There is no partial redaction of free text: we
 * do not try to scrub secrets out of a terminal stream, because a scrubber that
 * misses once is worse than no scrubber at all. Sealed means the component tree
 * underneath is not mounted, so there is nothing on screen to leak, nothing to
 * scroll back into view, and nothing to select-and-copy.
 *
 * The office scene stays live. The only thing it gives up is the free text in
 * the thought bubbles and the agent-card context line, both of which carry the
 * live `action` ("edit src/main/config.ts", "bash npm test") or the first words
 * of the operator's last prompt. Those are replaced by a generic label, not
 * hidden: an empty bubble would read as "the agent stalled".
 *
 * TWO MECHANISMS, ON PURPOSE
 * --------------------------
 * Surfaces that live INSIDE a panel the operator is already looking at get a
 * `<VisitorShield>` and a placeholder, because the panel is still there and a
 * silently blank one reads as a crash.
 *
 * Surfaces that are their own OVERLAY — the fullscreen terminal, the IDE, the
 * task detail, the memory search, the completion toast — are instead gated at
 * their mount against the raw `store.visitorMode` flag and render nothing.
 * Two reasons: a placeholder the size of one of those would cover the office
 * floor, which is the one thing the mode is trying to keep on screen; and not
 * mounting them means their file reads, ledger polls and editor buffers never
 * happen, so there is no sensitive data in the window at all rather than data
 * that merely is not painted. Those call sites do not go through `isSealed`
 * because there is no per-surface question left to ask.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * No React, no DOM, no IPC — a decision table plus two string functions, so the
 * policy can be tested without a renderer (test/visitor-mode.test.cjs). The
 * components import `isSealed` and never re-decide anything locally.
 *
 * It is also NOT a security boundary. Everything is still one toggle away, the
 * data still crosses IPC, and the underlying files are untouched. It defends
 * against a pair of eyes on a screen, which is exactly the threat it is for.
 */

/** Every surface the flag knows about. Anything not named here is unaffected. */
export const VISITOR_SURFACES = [
  /** Embedded + fullscreen pty output, and the composer that types into it. */
  'terminal',
  /** ThreadsPanel — the hive's internal agent-to-agent mail. */
  'threads',
  /** ToolWaterfall — tool calls with their targets (file paths, commands). */
  'traces',
  /** GitTab — branch, diff, file names, commit messages. */
  'git',
  /** The Monaco IDE overlay — file tree + file contents. */
  'ide',
  /** MemoryPanel — free-text search over everything agents have remembered. */
  'memory',
  /** The god's Command Center body (activity log, tasks, workers, skills…). */
  'commandCenter',
  /** TaskDetailOverlay — a card's full body, comments and assignee notes. */
  'taskDetail',
  /** The office scene's thought bubbles and the strip cards' context line. */
  'activity'
] as const;

export type VisitorSurface = (typeof VISITOR_SURFACES)[number];

/**
 * The surfaces visitor mode seals. Today that is all of them — the list and the
 * set are kept separate anyway so that "which surfaces exist" and "which ones
 * are sealed" can diverge later (a future per-surface allowance) without every
 * call site changing shape.
 */
const SEALED: ReadonlySet<VisitorSurface> = new Set<VisitorSurface>(VISITOR_SURFACES);

/**
 * Should `surface` be replaced by the visitor placeholder right now?
 *
 * `on` is the live store mirror of `config.visitorMode`. Anything that is not
 * literally `true` reads as off — an undefined flag (older config file, a
 * partial object over IPC) must never seal the app by accident, because the
 * failure mode of a stuck-on privacy screen is an operator who cannot see their
 * own work and no obvious reason why.
 */
export function isSealed(surface: VisitorSurface, on: boolean | undefined): boolean {
  return on === true && SEALED.has(surface);
}

/**
 * Text for an agent's thought bubble / card context line.
 *
 * Off: the real activity, unchanged. On: `generic` — one localized word like
 * "working" that says the agent is alive without saying what it is touching.
 * `generic` is passed in rather than hardcoded because the caller owns i18n;
 * an empty `generic` still yields '' , which the bubble renders as an animated
 * "…" (see ThoughtBubble) — a fine fallback, never a leak.
 */
export function visitorSafeActivity(
  activity: string | undefined,
  generic: string,
  on: boolean | undefined
): string {
  if (!isSealed('activity', on)) return activity ?? '';
  return generic;
}

/**
 * Text for the "which project" line on an agent card.
 *
 * A repo name is a small leak on its own but a reliable one — it names the
 * client, the product, or the unreleased thing. On, it collapses to `generic`.
 */
export function visitorSafeProject(
  project: string | undefined,
  generic: string,
  on: boolean | undefined
): string {
  if (!isSealed('activity', on)) return project ?? '';
  return generic;
}
