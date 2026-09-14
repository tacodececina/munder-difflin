/** Evidence origin, not a claim that a provider authenticated the payload. */
export type HookProvenance = 'hook' | 'proxy' | 'parser' | 'runtime';
export type ToolPhase = 'requested' | 'denied' | 'completed' | 'failed';

/** Renderer-facing hook event shared across the Electron IPC boundary. */
export interface HookEvent {
  agentId?: string;
  event: string;
  tool?: string;
  notificationType?: string;
  source?: string;
  message?: string;
  blocked?: boolean;
  provenance?: HookProvenance;
  /** Main-process receipt time, never the provider's execution timestamp. */
  receivedAt?: number;
  /** Identifiers are present only when the source actually supplies them. */
  sessionId?: string;
  invocationId?: string;
  toolPhase?: ToolPhase;
}

const OPTIONAL_STRING_FIELDS = ['tool', 'notificationType', 'source', 'message'] as const;

/** Validate an untrusted payload before it crosses the Electron IPC boundary. */
export function validateHookEvent(value: unknown): value is HookEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.event !== 'string' || candidate.event.length === 0) return false;
  if (
    candidate.agentId !== undefined &&
    (typeof candidate.agentId !== 'string' || candidate.agentId.length === 0)
  ) return false;

  for (const field of OPTIONAL_STRING_FIELDS) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'string') return false;
  }

  for (const field of ['sessionId', 'invocationId'] as const) {
    if (candidate[field] !== undefined &&
      (typeof candidate[field] !== 'string' || candidate[field].trim().length === 0)) return false;
  }
  if (candidate.provenance !== undefined &&
    !['hook', 'proxy', 'parser', 'runtime'].includes(candidate.provenance as string)) return false;
  if (candidate.toolPhase !== undefined &&
    !['requested', 'denied', 'completed', 'failed'].includes(candidate.toolPhase as string)) return false;
  if (candidate.receivedAt !== undefined &&
    (typeof candidate.receivedAt !== 'number' || !Number.isFinite(candidate.receivedAt) || candidate.receivedAt < 0)) return false;

  return candidate.blocked === undefined || typeof candidate.blocked === 'boolean';
}
