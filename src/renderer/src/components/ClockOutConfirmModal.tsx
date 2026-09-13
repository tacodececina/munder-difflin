import { useTranslation } from 'react-i18next';
import { PixelModal } from './PixelModal';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { clockOutCountKey } from '@/store/clockOut';

export interface ClockOutConfirmModalProps {
  /** Agents holding a LIVE terminal right now — the real count of what this
   *  action stops. Computed by store/clockOut.ts's liveAgentCount. */
  agentCount: number;
  /** Back out. Takes the prompt down and does nothing else. */
  onCancel: () => void;
  /** Go ahead — run the real close flow. */
  onConfirm: () => void;
}

/**
 * "End the day?" — the confirmation the office wall clock owes the user.
 *
 * Clicking the clock used to call `window.close()` on the spot: one click, on
 * a prop that reads as wall decoration, stopping every agent and closing the
 * harness. It was reported as a crash, which is the proof that the action
 * never announced itself.
 *
 * Deliberately NOT a new dialog language: same PixelModal frame, same
 * icon-block + body + tip-panel + right-aligned button row, same zIndex tier
 * as QuitWarningModal, which is the dialog this one hands off to. The only
 * thing it adds is the sentence QuitWarningModal cannot say from here — how
 * many agents are actually on the floor.
 */
export function ClockOutConfirmModal({ agentCount, onCancel, onConfirm }: ClockOutConfirmModalProps) {
  const { t: tr } = useTranslation();

  return (
    <PixelModal
      onClose={onCancel}
      title={tr('office.clockOut.title')}
      width={480}
      noPadding
      // Same tier as the quit warning it leads into: this is the last thing
      // asked before the floor starts shutting down, so it outranks whatever
      // it interrupts (see QuitWarningModal's note on the 1000 tier).
      zIndex={1000}
    >
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{
            width: 32, height: 32,
            background: 'var(--cth-coral-light)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0
          }}>
            <Icon name="clock" />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{
              fontFamily: 'var(--cth-font-display)',
              fontSize: 12, lineHeight: '20px',
              color: 'var(--cth-ink-900)',
              marginBottom: 4
            }}>
              {tr(clockOutCountKey(agentCount), { count: agentCount })}
            </div>
            <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
              {tr('office.clockOut.body')}
            </div>
          </div>
        </div>

        <div style={{
          padding: 8,
          background: 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          fontSize: 12, lineHeight: '18px',
          color: 'var(--cth-ink-700)'
        }}>
          {tr('office.clockOut.tip')}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <PixelButton variant="secondary" size="md" onClick={onCancel}>
            {tr('office.clockOut.cancel')}
          </PixelButton>
          <PixelButton variant="primary" size="md" onClick={onConfirm}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Icon name="clock" /> {tr('office.clockOut.confirm')}
            </span>
          </PixelButton>
        </div>
      </div>
    </PixelModal>
  );
}
