/**
 * Clocking out — the confirmation that stands between the office wall clock
 * and the end of the working day.
 *
 * The wall clock beside the boss's window is a REAL action: clicking it runs
 * closing time, which stops every agent on the floor and closes the harness.
 * It used to fire on a single click, straight into `window.close()`, from a
 * prop that looks like decoration — a user who tapped it reported the app as
 * "crashed", which is exactly what an unannounced quit feels like. Phase 1
 * then hung a second, purely decorative clock (scene/office/WorldClock.ts) on
 * the same wall, so the floor now shows two clocks and only one of them ends
 * the session.
 *
 * This module is the decision half of the fix, kept free of React and Pixi so
 * the one invariant that matters can be tested directly: CANCELLING NEVER
 * CLOSES ANYTHING. The view half is components/ClockOutConfirmModal.tsx.
 */

/** One-shot request to confirm closing time. `seq` makes a second click after
 *  a cancel a distinct request (same shape as the store's ccTabRequest). */
export interface ClockOutRequest {
  seq: number;
}

/** Raise the confirmation. Pure: returns the next request from the previous
 *  one, never mutating it. */
export function openClockOut(prev: ClockOutRequest | null): ClockOutRequest {
  return { seq: (prev?.seq ?? 0) + 1 };
}

/**
 * How many agents closing time would actually stop.
 *
 * The roster is NOT the answer: archived entries and agents whose terminal
 * already died stay on it, and a confirmation that overstates the damage is
 * as untrustworthy as one that hides it. Only an agent holding a live PTY is
 * something the user is about to lose.
 */
export function liveAgentCount(agents: readonly { ptyId?: string }[]): number {
  let n = 0;
  for (const a of agents) if (a.ptyId) n += 1;
  return n;
}

/** Which sentence states the damage for `count` agents. Three explicit keys
 *  rather than an i18next plural: the locales here are hand-written and the
 *  zero case says something different in kind ("nobody is running"), not a
 *  different plural form of the same sentence. */
export function clockOutCountKey(count: number): string {
  if (count <= 0) return 'office.clockOut.agentsNone';
  return count === 1 ? 'office.clockOut.agentsOne' : 'office.clockOut.agentsMany';
}

/** The two things the confirmation can do to the outside world. Injected so
 *  the cancel path can be proven inert. */
export interface ClockOutActions {
  /** Drop the pending confirmation. Renderer-local: no IPC, no main-process
   *  state, nothing to undo. */
  dismiss: () => void;
  /** The real close — `window.close()`, which the main process intercepts
   *  while PTYs are alive to offer the graceful closing-time protocol. */
  close: () => void;
}

/**
 * Back out. Dismisses the prompt and NOTHING else — no close, no IPC, no
 * half-started shutdown left behind for the next click to trip over.
 */
export function cancelClockOut(actions: ClockOutActions): void {
  actions.dismiss();
}

/** Go ahead: take the prompt down, then close the day. */
export function confirmClockOut(actions: ClockOutActions): void {
  actions.dismiss();
  actions.close();
}
