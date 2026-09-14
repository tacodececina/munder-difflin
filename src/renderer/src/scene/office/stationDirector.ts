import type { HookEvent } from '@shared/hookEvents';
import { stationForTool } from '@shared/toolStation';
import type { StationSpot } from './themeRegistry';

export const STATION_DWELL_MS = 1200;
// Expiry withdraws the visual observation; it does NOT report tool completion.
export const STATION_OBSERVATION_MS = 15000;
type Timer = ReturnType<typeof setTimeout>;
interface Options {
  spots?: readonly StationSpot[];
  now: () => number;
  schedule: (fn: () => void, ms: number) => Timer;
  clear: (timer: Timer) => void;
  eligible: (id: string) => boolean;
  show: (id: string, event: HookEvent) => void;
  hide: (id: string) => void;
  visit: (id: string, spot: StationSpot, isCurrent: () => boolean, failed: () => void) => boolean;
  cancel: (id: string) => void;
}
interface Observation {
  event: HookEvent;
  delay?: Timer;
  expiry?: Timer;
  visiting: boolean;
}
interface AgentEvidence {
  session?: string;
  retired: Set<string>;
  closed: Set<string>;
  pending: Set<string>;
  authoritative: boolean;
  ambiguous: boolean;
  uncorrelated: boolean;
  saturated: boolean;
  lastAt: number;
  observation?: Observation;
}

/** Event-driven visual projection. This class never writes operational status.
 * Construct ONLY behind the flag; dispose before replacing a scene/session.
 * Correlation failures degrade to a labelled observation at the current desk. */
export class StationDirector {
  private agents = new Map<string, AgentEvidence>();
  private blocked = new Set<string>();
  private breakerBlocked = new Set<string>();
  private disconnected = new Map<string, number>();
  private active = true;
  constructor(private options: Options) {}

  owns(id: string): boolean { return !!this.agents.get(id)?.observation; }

  observe(event: HookEvent): void {
    const id = event.agentId;
    if (!this.active || !id) return;
    const now = this.options.now();
    const at = event.receivedAt;
    if (at === undefined || !Number.isFinite(at) || at > now || now - at >= STATION_OBSERVATION_MS) return;
    if (at < (this.agents.get(id)?.lastAt ?? -1)) return;
    if (event.event === 'PtyDisconnected') { this.disconnect(id); return; }
    // Same PTY identifier can be reused on restart. Only a real new session
    // boundary may reopen it; neither parser output nor late requests can.
    if (event.event === 'SessionStart' && event.provenance === 'hook'
      && at >= (this.disconnected.get(id) ?? -1)
      && (!event.sessionId || !this.agents.get(id)?.retired.has(event.sessionId))) this.disconnected.delete(id);
    if (this.blocked.has(id) || this.breakerBlocked.has(id) || this.disconnected.has(id)) return;
    let state = this.agents.get(id);
    if (!state) {
      // Bound scene history without evicting identities that could return late.
      if (this.agents.size >= 128) return;
      state = { retired: new Set(), closed: new Set(), pending: new Set(), authoritative: false,
        ambiguous: false, uncorrelated: false, saturated: false, lastAt: -1 };
      this.agents.set(id, state);
    }
    // A textual terminal observation cannot replace a hook, even after its end.
    if (event.provenance !== 'hook' && state.authoritative) return;
    if (at < state.lastAt || (event.sessionId && state.retired.has(event.sessionId))) return;
    if (event.provenance === 'hook') state.authoritative = true;
    if (event.sessionId && event.sessionId !== state.session) {
      this.withdraw(id, state);
      if (state.session) {
        if (state.retired.size >= 128) return;
        state.retired.add(state.session);
        state.uncorrelated = false;
      }
      state.session = event.sessionId;
      state.closed.clear(); state.pending.clear(); state.ambiguous = false;
      // Bound retained session identities without ever evicting a tombstone
      // and accidentally admitting a late request. Saturation disables travel.
      state.saturated = state.retired.size >= 128;
    }
    if (state.saturated) return;
    state.lastAt = at;
    if (['Stop', 'StopCancelled', 'StopFailure', 'SubagentStop', 'SessionEnd', 'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostInvocation'].includes(event.event)) {
      this.withdraw(id, state);
      for (const pending of state.pending) {
        if (state.closed.size >= 256) { state.saturated = true; break; }
        state.closed.add(pending);
      }
      state.pending.clear(); state.ambiguous = false; state.uncorrelated = false;
      if (event.event === 'SessionEnd') this.disconnect(id);
      return;
    }
    if (!event.tool || !event.toolPhase || !this.options.eligible(id)) return;
    const invocation = event.invocationId;
    if (event.toolPhase !== 'requested') {
      if (invocation) {
        state.closed.add(invocation);
        state.pending.delete(invocation);
        if (state.closed.size >= 256) {
          state.saturated = true;
          this.withdraw(id, state);
          return;
        }
      }
      const observed = state.observation?.event;
      // An unrelated completion cannot end the currently correlated call.
      if (observed && invocation && observed.invocationId && observed.invocationId !== invocation) return;
      this.withdraw(id, state);
      if (!state.pending.size) state.ambiguous = false;
      if (state.closed.size >= 256) state.saturated = true;
      this.present(id, state, event, 2000);
      return;
    }
    if (invocation && (state.closed.has(invocation) || state.pending.has(invocation))) return;
    if (invocation) state.pending.add(invocation);
    if (event.provenance === 'hook' && (!invocation || !event.sessionId)) state.uncorrelated = true;
    if (state.pending.size > 1 || (!invocation && state.observation)) state.ambiguous = true;
    if (state.pending.size >= 256) state.saturated = true;
    this.withdraw(id, state);
    const observation = this.present(id, state, event, STATION_OBSERVATION_MS - (now - at));
    const kind = stationForTool(event.tool).station;
    const spots = this.options.spots?.filter(spot => spot.kind === kind);
    if (!spots?.length || state.ambiguous || state.uncorrelated || state.saturated || !invocation || !event.sessionId || event.provenance !== 'hook') return;
    observation.delay = this.options.schedule(() => {
      observation.delay = undefined;
      if (!this.current(id, observation)) return;
      if (!this.options.eligible(id)) { this.withdraw(id, state!); return; }
      for (const spot of spots) {
        // Set ownership before invoking an adapter that can fail synchronously.
        observation.visiting = true;
        const accepted = this.options.visit(id, spot, () => {
          return this.current(id, observation);
        }, () => { if (this.current(id, observation)) this.withdraw(id, state!); });
        if (accepted) return;
        observation.visiting = false;
        if (!this.current(id, observation)) return;
      }
    }, Math.max(0, STATION_DWELL_MS - (now - at)));
  }

  private current(id: string, observation: Observation): boolean {
    return this.active && this.agents.get(id)?.observation === observation;
  }
  private present(id: string, state: AgentEvidence, event: HookEvent, ms: number): Observation {
    const observation: Observation = { event, visiting: false };
    state.observation = observation;
    this.options.show(id, event);
    observation.expiry = this.options.schedule(() => {
      observation.expiry = undefined;
      if (this.current(id, observation)) this.withdraw(id, state);
    }, ms);
    return observation;
  }
  private withdraw(id: string, state: AgentEvidence): void {
    const observation = state.observation;
    if (!observation) return;
    state.observation = undefined; // invalidate callbacks BEFORE cancellation
    if (observation.delay !== undefined) this.options.clear(observation.delay);
    if (observation.expiry !== undefined) this.options.clear(observation.expiry);
    if (observation.visiting) this.options.cancel(id);
    this.options.hide(id);
  }
  block(id: string): void {
    if (!this.active) return;
    this.blocked.add(id);
    const state = this.agents.get(id);
    if (state) this.withdraw(id, state);
  }
  unblock(id: string): void { this.blocked.delete(id); }
  setBreaker(id: string, blocked: boolean): void {
    if (!this.active) return;
    if (blocked) {
      this.breakerBlocked.add(id);
      const state = this.agents.get(id);
      if (state) this.withdraw(id, state);
    } else this.breakerBlocked.delete(id);
  }
  disconnect(id: string): void {
    if (!this.active) return;
    this.disconnected.set(id, this.options.now());
    const state = this.agents.get(id);
    if (state) this.withdraw(id, state);
    if (state?.session) state.retired.add(state.session);
    if (state && state.retired.size >= 128) state.saturated = true;
  }
  reconnect(id: string): void { this.disconnected.delete(id); }
  dispose(): void {
    this.active = false;
    for (const [id, state] of this.agents) this.withdraw(id, state);
    this.agents.clear(); this.blocked.clear(); this.breakerBlocked.clear(); this.disconnected.clear();
  }
}
