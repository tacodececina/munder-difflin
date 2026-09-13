/**
 * Durable trail for renderer crashes — Phase 0 of the hardening pass.
 *
 * Before this, a throw in any render left a blank window with nothing anyone
 * could inspect afterwards: no error boundary caught it, nothing logged it,
 * and a `render-process-gone` (GPU OOM, a renderer crash) just left a dead
 * window. This is the one place all three land: React error boundaries
 * (src/renderer/src/components/ErrorBoundary.tsx), the renderer's global
 * `window.onerror`/`unhandledrejection` hooks (main.tsx), and this process's
 * own `render-process-gone`/`child-process-gone` handlers (index.ts).
 *
 * Mirrors updater.ts's `logLine` exactly (append-only, userData, best-effort,
 * never throws) rather than inventing a second logging convention — see that
 * file's comment for why: the whole point of a crash log is that a failure
 * writing IT must never take the app down too.
 */
import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RendererErrorPayload } from '../shared/rendererErrors';

const LOG_FILE = 'renderer-errors.log';

/** Append one stamped, best-effort line. Never throws. */
function appendLine(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  console.error('[renderer]', line);
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, LOG_FILE), stamped);
  } catch { /* logging must never take the app down */ }
}

/** Log a payload shipped from the renderer's error boundary / window hooks. */
export function logRendererError(payload: RendererErrorPayload): void {
  const bits = [
    `source=${payload.source}`,
    payload.url ? `url=${payload.url}` : null,
    payload.line !== undefined ? `line=${payload.line}` : null,
    payload.column !== undefined ? `col=${payload.column}` : null,
    payload.message ? `message=${payload.message}` : null
  ].filter(Boolean).join(' ');
  const detail = [payload.stack, payload.componentStack ? `component stack:${payload.componentStack}` : null]
    .filter(Boolean).join('\n');
  appendLine(detail ? `${bits}\n${detail}` : bits);
}

/** Log a `render-process-gone` / `child-process-gone` event from main. */
export function logProcessGone(kind: 'render-process-gone' | 'child-process-gone', detail: string): void {
  appendLine(`${kind} ${detail}`);
}
