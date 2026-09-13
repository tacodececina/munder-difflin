import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { useStore, type Agent, type GodStatus } from '@/store/store';
import type { AppTheme } from '@/design/theme';
import { OfficeFloor } from '@/scene/office/OfficeFloor';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MemoryPanel } from '@/components/MemoryPanel';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { AgentStrip } from '@/components/AgentStrip';
import { MichaelBooting } from '@/components/MichaelBooting';
import { CompletionToast } from '@/realtime/CompletionToast';
import { UpdateToast } from '@/components/UpdateToast';
import { UpdateBadge } from '@/components/UpdateBadge';
import { VisitorModeBadge } from '@/components/VisitorShield';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { SidebarSplitter } from '@/components/SidebarSplitter';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { zIndex } from '@/design/tokens';
import brandLogo from '@brand/logo.png?url';

export interface AppShellProps {
  config: HarnessConfig;
  agent: Agent | undefined;
  agentCount: number;
  godStatus: GodStatus;
  bootingGodName: string;
  fullscreenAgentId: string | null;
  appThemeNow: AppTheme;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
  vpWidth: number;
  onAddAgent: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onToggleFullscreen: () => void;
  /** Whether the compact-band detail overlay (see `compactShell` below) is
   *  currently shown. Owned by App.tsx, not here — see that state's own doc
   *  comment for why. Ignored outside the 'compact' band. */
  compactOverlayOpen: boolean;
  onCloseCompactOverlay: () => void;
  onOpenCompactOverlay: () => void;
  /** Modals, the fullscreen terminal, the IDE panel, the task detail overlay —
   *  whatever App.tsx currently has open. Rendered last, inside this same root
   *  div, so every fixed-position overlay keeps the exact DOM position (and
   *  therefore stacking behavior) it had before the layout was split out of
   *  App.tsx. AppShell itself does not know or care which of these are open —
   *  that state stays owned by App.tsx. */
  children?: ReactNode;
}

/**
 * The app's root visual layout: title bar, the office scene (with its
 * placeholder states), the agent detail sidebar, and the agent strip.
 *
 * Extracted from App.tsx (Phase 1 of the redesign) so the state/orchestration
 * logic that used to live alongside it — config loading, hive bootstrap, IPC
 * subscriptions, every modal's open/closed state — is no longer tangled up
 * with the SHAPE of the screen. This is prep for Phase 2's responsive layout
 * work, which will mostly land here rather than back in App.tsx.
 *
 * Was deliberately dumb through Phase 1: no responsive/breakpoint logic, no
 * state of its own beyond what React needs to render, every action a plain
 * callback prop. Phase 2 is that responsive work landing here, per the plan —
 * it reads useBreakpoint() (hooks/useBreakpoint.ts) for its `band`
 * ('compact' | 'cozy' | 'wide', see `bp` in design/tokens.ts): below
 * `bp.compact` the agent strip collapses to portraits-only and the detail
 * column floats as an overlay instead of a fixed side-by-side column, because
 * there is no longer room for a usable scene AND both. Still no state of its
 * own beyond that derived read — no open/closed flag, nothing to get out of
 * sync — and every action is still a plain callback prop; every OTHER piece
 * of state/orchestration still lives in App.tsx. Phase 0's error boundaries
 * around OfficeFloor and AgentDetailPanel moved here unchanged — same
 * boundaries, same reset behavior, just living in the component that now
 * owns the elements they wrap.
 */
export function AppShell({
  config,
  agent,
  agentCount,
  godStatus,
  bootingGodName,
  fullscreenAgentId,
  appThemeNow,
  sidebarWidth,
  onSidebarWidthChange,
  vpWidth,
  onAddAgent,
  onOpenSettings,
  onToggleTheme,
  onToggleFullscreen,
  compactOverlayOpen,
  onCloseCompactOverlay,
  onOpenCompactOverlay,
  children
}: AppShellProps) {
  // Phase 2: the one read that drives every responsive decision below. Same
  // underlying singleton listener App.tsx's own useBreakpoint() call uses
  // for `vpWidth` — see hooks/useBreakpoint.ts — so this adds no second
  // `resize` subscription.
  const { band } = useBreakpoint();
  const compactShell = band === 'compact';
  // The shell's only other derived read (see the note above about staying
  // state-free): visitor mode both pulls the memory search off the floor and
  // puts a marker in the title bar, and both live in this component.
  const visitorMode = useStore((s) => s.visitorMode);
  const { t } = useTranslation();
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      width: '100vw', height: '100vh',
      overflow: 'hidden'
    }}>
      {/* rt-12: global fixed-overlay toast for voice-Michael completions ("Oscar
          finished X"). Self-positions bottom-right; renders null until one arrives. */}
      <CompletionToast />
      {/* v0.3.4: background-update toast ("restart to update"); renders null until
          main's updater pushes a status. */}
      <UpdateToast />
      {/* Title bar. Height lives in design/layout.css's `.cth-titlebar`
          (Phase 2's short-viewport rule) — kept out of this inline style so
          the media query can win over it (inline always beats a class). */}
      <div
        className="cth-titlebar-drag cth-titlebar"
        style={{
          background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
          borderBottom: '1px solid var(--cth-ink-300)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 96,
          paddingRight: 12,
          gap: 12,
          userSelect: 'none'
        }}
      >
        {/* New brand mark to be dropped in later; logo asset unchanged for now. */}
        <img
          src={brandLogo}
          alt="The Hive"
          style={{ height: 20, width: 'auto', display: 'block' }}
        />
        {/* v0.3.7: the version is no longer inert text — it doubles as the
            update control (check / download / restart to update). */}
        <UpdateBadge />
        {/* Renders nothing unless visitor mode is armed. Without it a sealed
            app is indistinguishable from a broken one. */}
        <VisitorModeBadge />
        {/* flexShrink:0 + whiteSpace:nowrap — a defensive backstop from the
            Phase 2 audit (design/layout.css's header comment): nothing here
            overflows today given MIN_WIN's 1280px floor, but this row has no
            overflow guard of its own, unlike the rest of the app's text. */}
        <span style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 13,
          color: 'var(--cth-ink-500)',
          flexShrink: 0,
          whiteSpace: 'nowrap'
        }}>
          {config.autoMode ? 'auto mode on' : 'auto mode off'}
        </span>
        {/* v0.3.4: theme + fullscreen live HERE (top right), not buried in the
            terminal header — and the theme darkens the whole app, terminals
            included (design/theme.ts + tokens.css dark block). */}
        <button
          className="cth-titlebar-nodrag cth-tip"
          onClick={onToggleTheme}
          data-tip={appThemeNow === 'dark' ? 'Light theme' : 'Dark theme'}
          aria-label="Toggle dark mode"
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)', fontSize: 13, lineHeight: 1
          }}
        >
          {appThemeNow === 'dark' ? '☀' : '☾'}
        </button>
        {/* v0.3.4: the IDE button moved to agent level — every agent's header
            (sidebar detail, god Command Center, fullscreen) carries it. */}
        <button
          className="cth-titlebar-nodrag cth-settings-btn cth-tip"
          onClick={onOpenSettings}
          data-tip="Settings"
          aria-label="Settings"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)'
          }}
        >
          <GearGlyph />
        </button>
        {/* Fullscreen. The title bar is chrome, not canvas, so these two use
            clean stroke icons rather than the 16x16 pixel set the rest of the UI
            is drawn in — at 16-18px a pixel-grid glyph reads as a rendering
            artifact next to the OS window controls, not as a style choice. */}
        <button
          className="cth-titlebar-nodrag cth-tip"
          onClick={onToggleFullscreen}
          data-tip={fullscreenAgentId ? 'Exit focus mode (Esc)' : 'Focus mode'}
          aria-label="Toggle focus mode"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            border: 'none', borderRadius: 2, cursor: 'pointer',
            color: 'var(--cth-ink-900)'
          }}
        >
          {fullscreenAgentId ? <CollapseGlyph /> : <ExpandGlyph />}
        </button>

      </div>

      {/* Vertical padding lives in design/layout.css's `.cth-scene-row`
          (Phase 2's short-viewport rule); horizontal stays inline since it
          does not change with height — see the title bar comment above for
          why the two can't share one `padding` shorthand here. */}
      <div className="cth-scene-row" style={{
        flex: 1, minHeight: 0,
        display: 'flex',
        paddingLeft: 16, paddingRight: 16,
        gap: 0
      }}>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
          {/* Its own boundary: a crash in the Pixi scene must not take the
              sidebar/terminal/strip down with it. (WebGL context loss itself is
              handled separately, inside OfficeFloor — see glRecovery.ts; this
              is the backstop for an ordinary JS throw during render.) */}
          <ErrorBoundary>
            <OfficeFloor />
          </ErrorBoundary>
          {/* VISITOR MODE — the memory search is a free-text window into
              everything every agent has ever remembered, and it floats over the
              floor. Gated at the mount so the panel, its status probe and its
              query box never exist while a visitor is watching. */}
          {!visitorMode && <MemoryPanel />}
          {agentCount === 0 && godStatus === 'booting' && <MichaelBooting />}
          {agentCount === 0 && godStatus !== 'booting' && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none'
            }}>
              <div style={{ pointerEvents: 'auto', width: 360 }}>
                <PixelPanel variant="dialog" title="EMPTY FLOOR" noPadding>
                  <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <p style={{ margin: 0, fontSize: 13, lineHeight: '20px' }}>
                      No agents on the floor yet. Spawn one to see real claude output stream in here.
                    </p>
                    <PixelButton variant="primary" size="md" onClick={onAddAgent}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="plus" /> add agent
                      </span>
                    </PixelButton>
                  </div>
                </PixelPanel>
              </div>
            </div>
          )}
        </div>

        {/* Compact band: the detail column below becomes a floating overlay
            (design/layout.css's `.cth-detail-col--overlay`) rather than a
            fixed-width sibling the splitter resizes against — there is
            nothing left for it to drag. */}
        {!compactShell && (
          <SidebarSplitter
            width={sidebarWidth}
            onChange={onSidebarWidthChange}
            viewportWidth={vpWidth}
          />
        )}

        {/* `.cth-detail-col` is a query container (design/layout.css) for its
            OWN inline-size — the "wide" reading-width cap on
            `.cth-detail-col-inner` below is keyed to that, not to the
            window's `band`, because SidebarSplitter already lets this column
            get wide on any window size (see that component's `max` prop).

            Compact band only: this whole column is skippable. Without
            `compactOverlayOpen` it used to render unconditionally as a fixed
            overlay with no way to dismiss it, permanently covering ~45% of
            the office scene on any window under `bp.compact` — see
            App.tsx's `compactOverlayOpen` doc comment. The reopen tab below
            is its only way back once closed. */}
        {(!compactShell || compactOverlayOpen) && (
        <div
          className={`cth-detail-col${compactShell ? ' cth-detail-col--overlay' : ''}`}
          style={compactShell
            ? { minHeight: 0 }
            : { width: sidebarWidth, flexShrink: 0, minHeight: 0 }}
        >
          <div
            className="cth-detail-col-inner"
            style={{ height: '100%', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}
          >
            {compactShell && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 4px 0' }}>
                <PixelButton
                  variant="ghost"
                  size="sm"
                  onClick={onCloseCompactOverlay}
                  aria-label={t('appShell.closeDetail')}
                  title={t('appShell.closeDetail')}
                >
                  <Icon name="x" />
                </PixelButton>
              </div>
            )}
            {agent ? (
              // Keyed on the agent id so switching agents always starts this
              // boundary fresh — a crash on Dwight's panel must not still be
              // showing the fallback once you've selected Pam.
              <ErrorBoundary key={agent.id}>
                <AgentDetailPanel agent={agent} />
              </ErrorBoundary>
            ) : godStatus === 'booting' ? (
              <PixelPanel variant="default" noPadding style={{
                padding: 16, height: '100%',
                display: 'flex', flexDirection: 'column',
                justifyContent: 'center', alignItems: 'center', gap: 12
              }}>
                <div style={{
                  fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                  color: 'var(--cth-ink-500)'
                }}>WAKING THE FLOOR</div>
                <p style={{ margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                  {bootingGodName} is clocking in.<br />
                  The terminal will land here once he's seated.
                </p>
              </PixelPanel>
            ) : (
              <PixelPanel variant="default" noPadding style={{
                padding: 16, height: '100%',
                display: 'flex', flexDirection: 'column',
                justifyContent: 'center', alignItems: 'center', gap: 12
              }}>
                <div style={{
                  fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                  color: 'var(--cth-ink-500)'
                }}>NO AGENT SELECTED</div>
                <p style={{ margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                  Spawn an agent from the strip below.<br />
                  The terminal and command bar will land here.
                </p>
                <PixelButton variant="secondary" size="md" onClick={onAddAgent}>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <Icon name="plus" /> add agent
                  </span>
                </PixelButton>
              </PixelPanel>
            )}
          </div>
        </div>
        )}

        {/* Reopen affordance for the compact overlay once closed — otherwise
            closing it would be a one-way trip with no way back short of
            picking a different agent (which re-opens it via App.tsx's effect
            on `agent?.id`). Docked to the same edge the overlay itself slides
            in from. */}
        {compactShell && !compactOverlayOpen && (
          <button
            type="button"
            onClick={onOpenCompactOverlay}
            aria-label={t('appShell.openDetail')}
            title={t('appShell.openDetail')}
            style={{
              position: 'fixed',
              insetBlockStart: 'calc(var(--cth-titlebar-h) + var(--cth-shell-pad-y) + 12px)',
              insetInlineEnd: 0,
              zIndex: zIndex.overlay,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 44,
              border: 'none', borderStartStartRadius: 8, borderEndStartRadius: 8,
              borderInlineEnd: 'none',
              background: 'var(--cth-paper-100)',
              boxShadow: 'var(--cth-shadow-lg)',
              cursor: 'pointer', color: 'var(--cth-ink-700)'
            }}
          >
            <Icon name="sidebar" />
          </button>
        )}
      </div>

      <AgentStrip config={config} />

      {/* Every modal's MOUNT POINT gets its own boundary, not its inner content —
          so a crash during the modal's own initial mount (not just later, once
          it's up) is caught too. App.tsx owns which of these are open and each
          boundary's onReset; this component only provides the slot they render
          into, in the same DOM position they occupied before this split. */}
      {children}
    </div>
  );
}

/* ── Title-bar glyphs ────────────────────────────────────────────────────────
   Stroke icons on a 16 unit box, inheriting `currentColor` so they follow the
   theme exactly as the pixel set does. Deliberately NOT added to
   components/Icon.tsx: that library is the app's pixel-art identity and is used
   at tab and card scale, where the pixel grid is the point. These three sit
   beside the OS traffic lights, which is the one place that identity reads as a
   blurry asset rather than a decision. */
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1.4}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >{children}</svg>
  );
}

/** Four outward corner brackets — enter fullscreen. */
function ExpandGlyph() {
  return (
    <Glyph>
      <path d="M6.2 3H3v3.2M9.8 3H13v3.2M6.2 13H3V9.8M9.8 13H13V9.8" />
    </Glyph>
  );
}

/** The same brackets turned inward — leave fullscreen. */
function CollapseGlyph() {
  return (
    <Glyph>
      <path d="M3 6.2h3.2V3M13 6.2H9.8V3M3 9.8h3.2V13M13 9.8H9.8V13" />
    </Glyph>
  );
}

/** A wrench. The previous glyph was a hub with eight radiating spokes, which at
 *  18px is indistinguishable from a sun — sitting immediately beside a theme
 *  toggle whose light-mode icon IS a sun. A tool shape carries "settings"
 *  without competing with its neighbour. Drawn on a 24 box for curve headroom
 *  and rendered at 16. */
function GearGlyph() {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M15.5 3.5a5 5 0 0 0-6.1 6.1l-5.6 5.6a2.3 2.3 0 1 0 3.2 3.2l5.6-5.6a5 5 0 0 0 6.1-6.1l-3 3-2.2-.6-.6-2.2z" />
    </svg>
  );
}
