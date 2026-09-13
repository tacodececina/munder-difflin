/**
 * One call site for "something the renderer could not handle just happened" —
 * shared by the global window hooks (main.tsx) and every ErrorBoundary catch.
 *
 * Always `console.error`s first (so dev tools still shows it immediately, exactly
 * as before this existed) and then best-effort ships it to main for durable
 * logging (userData/renderer-errors.log — see src/main/rendererErrorLog.ts). The
 * IPC call is fire-and-forget and swallows its own failure: a renderer that is
 * already in an error state must not be able to throw a SECOND time trying to
 * report the first.
 *
 * No toast here on purpose (see Phase 0 scope note in ErrorBoundary.tsx) — this
 * app has no general-purpose, reusable toast component today (UpdateToast and
 * CompletionToast are both single-purpose, self-subscribing surfaces, not a
 * shared primitive), and building one is out of scope for this pass. The file
 * log is the safety net; console.error is the immediate signal.
 */
import type { RendererErrorPayload } from '@shared/rendererErrors';

export function reportRendererError(payload: RendererErrorPayload): void {
  console.error(`[${payload.source}]`, payload.message, payload.stack ?? '');
  try {
    void window.cth?.logRendererError?.(payload)?.catch?.(() => { /* best-effort */ });
  } catch { /* window.cth not ready yet, or the call itself threw synchronously */ }
}
