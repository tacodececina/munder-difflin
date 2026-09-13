import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelModal } from './PixelModal';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { parseTasks } from './TasksKanban';
import { getDundiesStats } from '@/store/store';
import { formatDundiesDuration } from '@/store/dundiesStats';

export interface DundiesModalProps {
  /** User confirmed — proceed to the REAL closing-time protocol. */
  onConfirm: () => void;
  /** User backed out — return to the plain quit-warning view. */
  onCancel: () => void;
}

/**
 * "The Dundies" — a light, informational end-of-day recap shown as an
 * interstitial the moment the human clicks "closing time", BEFORE the real
 * shutdown protocol (closingTime.ts) actually starts. Deliberately a
 * pre-step rather than something wedged into the protocol's own timing: the
 * protocol's grace window before teardown is a couple of seconds (just long
 * enough for the god's final writes to land), nowhere near enough for a
 * human to read a recap, and this way the recap adds zero risk to the
 * data-safety handshake itself.
 *
 * Purely informative — tasks closed + time on the clock per agent, plus one
 * office-appropriate one-liner. No points, no levels, no leaderboard: this
 * phase's brief is explicit that gamification is out of scope.
 */
export function DundiesModal({ onConfirm, onCancel }: DundiesModalProps) {
  const { t: tr } = useTranslation();
  const [doneCount, setDoneCount] = useState<number | null>(null);
  const [openCount, setOpenCount] = useState<number | null>(null);

  // Agent active-time stats are already tracked live in the store (see
  // dundiesStats.ts) — just a snapshot, taken once when the recap opens.
  const agentStats = useMemo(() => getDundiesStats(), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tasks = parseTasks(await window.cth.hiveTasks());
        if (cancelled) return;
        setDoneCount(tasks.filter((t) => t.status === 'done').length);
        setOpenCount(tasks.filter((t) => t.status !== 'done').length);
      } catch {
        if (!cancelled) { setDoneCount(0); setOpenCount(0); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <PixelModal onClose={onCancel} title={tr('dundies.title')} width={520} noPadding zIndex={1001}>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div style={{
            width: 32, height: 32,
            background: 'var(--cth-lemon-light, #f6ecc4)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0
          }}>
            <Icon name="sparkle" />
          </div>
          <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
            {tr('dundies.subtitle')}
          </div>
        </div>

        <PixelPanel variant="inset">
          <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
            {doneCount === null
              ? tr('dundies.loadingTasks')
              : tr('dundies.tasksClosed', { count: doneCount })}
          </div>
          {doneCount !== null && openCount !== null && openCount > 0 && (
            <div style={{ fontSize: 13, color: 'var(--cth-ink-700)', marginTop: 2 }}>
              {tr('dundies.tasksOpen', { count: openCount })}
            </div>
          )}
        </PixelPanel>

        <PixelPanel variant="inset" title={tr('dundies.activeTimeHeading')}>
          {agentStats.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--cth-ink-700)' }}>{tr('dundies.noAgents')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
              {agentStats.map((a) => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--cth-ink-900)' }}>
                  <span>{a.name}</span>
                  <span style={{ fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-700)' }}>
                    {formatDundiesDuration(a.activeMs)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </PixelPanel>

        <div style={{ fontSize: 13, fontStyle: 'italic', color: 'var(--cth-ink-700)' }}>
          {tr('dundies.joke')}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <PixelButton variant="secondary" size="md" onClick={onCancel}>
            {tr('dundies.notYet')}
          </PixelButton>
          <PixelButton variant="primary" size="md" onClick={onConfirm}>
            {tr('dundies.startClosing')}
          </PixelButton>
        </div>
      </div>
    </PixelModal>
  );
}
