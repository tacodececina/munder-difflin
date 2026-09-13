/**
 * Reusable error boundary — Phase 0 of the hardening pass.
 *
 * Before this, a throw ANYWHERE in the render tree (office floor, a terminal,
 * a modal mounting) left a blank white/black screen with nothing in dev tools
 * beyond the stack React itself prints, and nothing at all in a packaged
 * build. Zero recovery, zero visible explanation.
 *
 * React error boundaries MUST be class components — `componentDidCatch` and
 * `getDerivedStateFromError` have no hook equivalent, by design (a component
 * cannot reliably catch its own render errors with hooks alone). This is the
 * one class component in an otherwise all-hooks codebase for that reason.
 *
 * i18n: a class can't call `useTranslation()`, so this is wrapped in
 * `withTranslation()` — react-i18next's HOC — which injects `t`/`i18n` as
 * props and re-renders the wrapped class on a language change, same as a hook
 * would. See src/renderer/src/i18n/index.ts for how i18n itself is set up.
 *
 * Placement is deliberately NOT one root boundary. App.tsx keeps a root one as
 * the last resort, but the office canvas, each per-agent terminal, the agent
 * detail panel, and each modal's mount point all get their OWN — so a crash in
 * one Claude agent's terminal doesn't take down the other nine, or the floor,
 * or the app. See each call site for why its `key` (when present) matters: it
 * forces a fresh boundary — not a stuck "hasError" one from whatever used to be
 * there — when the thing being wrapped changes identity (switching agents,
 * a pty respawning).
 *
 * No toast on this catch: see the note atop errorReporting.ts for why a new
 * toast primitive is out of scope here. `componentDidCatch` logs immediately
 * (console + the durable file log via reportRendererError) and the fallback
 * panel below is the visible half.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { withTranslation, type WithTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { reportRendererError } from '../errorReporting';

export interface ErrorBoundaryOwnProps {
  children?: ReactNode;
  /** Overrides the generic default title (`errorBoundary.title`) with
   *  something naming the region that broke, e.g. "The office floor crashed". */
  fallbackTitle?: string;
  /** Called by the "Retry" button instead of the default behaviour (clearing
   *  `hasError` and re-rendering `children` fresh). Use this where simply
   *  re-mounting the same children would likely crash again immediately —
   *  a modal should usually close instead of re-opening itself into the same
   *  error. */
  onReset?: () => void;
}

type Props = ErrorBoundaryOwnProps & WithTranslation;

interface State {
  hasError: boolean;
  error: Error | null;
  copied: boolean;
}

class ErrorBoundaryBase extends Component<Props, State> {
  state: State = { hasError: false, error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportRendererError({
      source: 'error-boundary',
      message: error.message || String(error),
      stack: error.stack,
      componentStack: info.componentStack ?? undefined
    });
  }

  private handleRetry = (): void => {
    if (this.props.onReset) {
      this.props.onReset();
      // Even with a custom onReset (typically "close the modal"), clear our
      // own state — otherwise re-opening the SAME boundary instance (no `key`
      // change) would render the fallback again despite fresh children.
    }
    this.setState({ hasError: false, error: null, copied: false });
  };

  private handleCopy = (): void => {
    const { error } = this.state;
    const text = [error?.message, error?.stack].filter(Boolean).join('\n\n') || String(error);
    const done = () => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    };
    // Prefer the app's own clipboard bridge (works under Electron's sandboxed
    // renderer without a permission prompt); fall back to the web API for
    // safety if it's ever missing.
    const bridge = window.cth?.copyToClipboard;
    if (bridge) {
      bridge(text).then((res) => { if (res.ok) done(); }).catch(() => { /* best-effort */ });
    } else if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => { /* best-effort */ });
    }
  };

  render(): ReactNode {
    const { hasError, error, copied } = this.state;
    const { children, fallbackTitle, t } = this.props;
    if (!hasError) return children ?? null;

    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '100%', height: '100%', minHeight: 120, padding: 16, boxSizing: 'border-box'
      }}>
        <PixelPanel variant="dialog" title={fallbackTitle ?? t('errorBoundary.title')} style={{ maxWidth: 480, width: '100%' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-700)' }}>
              {t('errorBoundary.description')}
            </p>
            {!!error?.message && (
              <p style={{
                margin: 0, fontSize: 12, lineHeight: '16px', color: 'var(--cth-coral)',
                wordBreak: 'break-word'
              }}>
                {error.message}
              </p>
            )}
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--cth-ink-500)' }}>
                {t('errorBoundary.showDetails')}
              </summary>
              <pre style={{
                margin: '8px 0 0', padding: 8,
                background: 'var(--cth-paper-100)',
                boxShadow: 'var(--cth-panel-border-inset)',
                fontSize: 11, lineHeight: '15px',
                maxHeight: 200, overflow: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                color: 'var(--cth-ink-700)'
              }}>
                {error?.stack || error?.message || String(error)}
              </pre>
            </details>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <PixelButton variant="secondary" size="sm" onClick={this.handleCopy}>
                {copied ? t('errorBoundary.copied') : t('errorBoundary.copyError')}
              </PixelButton>
              <PixelButton variant="primary" size="sm" onClick={this.handleRetry}>
                {t('errorBoundary.retry')}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    );
  }
}

/** The component every call site actually imports — the class above with `t`/
 *  `i18n` wired in. Keep the class itself unexported: nothing should ever
 *  render `ErrorBoundaryBase` directly and skip translation. */
export const ErrorBoundary = withTranslation()(ErrorBoundaryBase);
