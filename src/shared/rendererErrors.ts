/**
 * Renderer-crash reporting — the shape shipped from the renderer to main for
 * durable logging (see src/main/rendererErrorLog.ts) whenever something the
 * renderer could not otherwise surface goes wrong: a React error boundary
 * catch, a bare `window.onerror`, or an unhandled promise rejection.
 *
 * Deliberately electron-free (same reasoning as src/shared/updateState.ts):
 * the renderer, preload and main all import this one shape, so the IPC
 * contract can't drift between the three sides.
 */
export type RendererErrorSource = 'error-boundary' | 'window-error' | 'unhandled-rejection';

export interface RendererErrorPayload {
  /** Where this was caught — which of the three safety nets fired. */
  source: RendererErrorSource;
  /** Human-readable summary — `error.message`, or the rejection reason
   *  stringified when it isn't an Error at all. */
  message: string;
  /** `error.stack`, when the thrown value was an Error. */
  stack?: string;
  /** React's component stack, only present for an error-boundary catch. */
  componentStack?: string;
  /** `window.onerror`'s `source` (the script URL) — omitted for the other two sources. */
  url?: string;
  line?: number;
  column?: number;
}
