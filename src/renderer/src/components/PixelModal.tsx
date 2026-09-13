import { CSSProperties, ReactNode } from 'react';
import { PixelPanel, type PixelPanelProps } from './PixelPanel';
import { zIndex as zIndexScale } from '@/design/tokens';

export interface PixelModalProps {
  /** Backdrop click closes the modal. Omit while a destructive action is in
   *  flight (e.g. quitting) to make the backdrop inert — same pattern
   *  QuitWarningModal already used before this component existed. */
  onClose?: () => void;
  title?: string;
  accent?: PixelPanelProps['accent'];
  /** PixelPanel variant for the frame. Defaults to 'dialog' — every modal in
   *  this app already uses that variant. */
  variant?: PixelPanelProps['variant'];
  width?: number | string;
  /** Cap on the frame's width as a viewport-relative value. Defaults to '92vw'. */
  maxWidth?: string;
  /** Padding around the centered frame, so a wide dialog does not run edge to
   *  edge on a small viewport. Defaults to 0 (most dialogs are narrow enough
   *  not to need it). */
  backdropPadding?: number;
  /** Backdrop fill. Defaults to 'rgba(26, 19, 32, 0.7)' — the shade most
   *  dialogs in this app already used before this component existed. */
  backdropColor?: string;
  /** Stacking tier. Defaults to the shared `modal` tier (tokens.zIndex.modal);
   *  override for a dialog that must sit above/below the usual pack — e.g. the
   *  quit warning, which intentionally outranks every other modal. */
  zIndex?: number;
  noPadding?: boolean;
  children: ReactNode;
  /** Extra style for the PixelPanel frame itself (e.g. flex layout for a
   *  scrolling body). */
  panelStyle?: CSSProperties;
}

/**
 * Generic modal backdrop + frame, built on PixelPanel. Every modal in this app
 * (AddAgentModal, EditAgentModal, HivePicker, SettingsModal, TasksKanban's
 * TaskDetail, QuitWarningModal, ...) previously hand-rolled its own
 * `position: fixed` backdrop with a click-outside-to-close handler and its own
 * copy of the centered PixelPanel wrapper. This is that pattern, once.
 *
 * Only QuitWarningModal and TasksKanban's TaskDetail (rendered app-wide via
 * TaskDetailOverlay) are migrated to it in this pass (Phase 1) — they are the
 * two smallest/most isolated modals. The larger,
 * stateful ones (AddAgentModal, SettingsModal, EditAgentModal, OnboardingWizard)
 * are left as-is; they are candidates for a later visual-polish pass, not this
 * one, and several already sit behind Phase 0's error boundaries that a risky
 * migration here would rather not disturb.
 */
export function PixelModal({
  onClose,
  title,
  accent,
  variant = 'dialog',
  width = 480,
  maxWidth = '92vw',
  backdropPadding = 0,
  backdropColor = 'rgba(26, 19, 32, 0.7)',
  zIndex,
  noPadding = false,
  children,
  panelStyle
}: PixelModalProps) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: backdropColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: backdropPadding,
        boxSizing: 'border-box',
        zIndex: zIndex ?? zIndexScale.modal
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width, maxWidth, maxHeight: '90vh', display: 'flex' }}
      >
        <PixelPanel
          variant={variant}
          title={title}
          accent={accent}
          noPadding={noPadding}
          style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: 0, ...panelStyle }}
        >
          {children}
        </PixelPanel>
      </div>
    </div>
  );
}
