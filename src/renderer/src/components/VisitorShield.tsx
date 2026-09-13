import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { isSealed, type VisitorSurface } from '@/store/visitorMode';

export interface VisitorShieldProps {
  /** Which policy entry decides this spot. See store/visitorMode.ts. */
  surface: VisitorSurface;
  /** What the placeholder calls the thing it is standing in for (already
   *  localized by the caller — this component owns only its own copy). */
  label?: string;
  children: ReactNode;
}

/**
 * The one way a surface opts into visitor mode.
 *
 * UNMOUNTS, does not blur. A CSS filter leaves the real text in the DOM, on the
 * GPU, and one screenshot-with-devtools (or one accidental text selection, or
 * one screen reader) away from being read out loud. The whole value of this
 * feature is that the sensitive tree is NOT on screen, so the sealed branch
 * returns a placeholder and never renders `children` at all.
 *
 * The side effect is deliberate and worth stating: sealing unmounts things that
 * hold state. A pty view remounts and refits when the seal lifts (that path is
 * already exercised by focus mode and the fullscreen overlay, which mount and
 * unmount the same terminals); an unsaved IDE buffer or a half-typed message is
 * NOT preserved across the toggle. Visitor mode is armed deliberately, by a
 * human, before letting someone look — losing a draft at that moment is an
 * acceptable price for the terminal actually being gone.
 *
 * The placeholder is intentionally plain and says why it is there: a blank
 * panel reads as a crash, and an operator who thinks the app broke will start
 * clicking around — which is the last thing you want with a guest watching.
 */
export function VisitorShield({ surface, label, children }: VisitorShieldProps) {
  const visitorMode = useStore((s) => s.visitorMode);
  const { t } = useTranslation();
  if (!isSealed(surface, visitorMode)) return <>{children}</>;
  return (
    <div
      // Not `aria-hidden`: the placeholder is real, announced content — it is
      // the only thing telling the operator why the panel is empty.
      role="note"
      style={{
        flex: 1, minWidth: 0, minHeight: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 8, padding: 16, textAlign: 'center',
        background: 'var(--cth-paper-200)',
        // Tiny diagonal hatch so a sealed panel reads as "covered on purpose"
        // at a glance, from across the room, without any text being needed.
        backgroundImage:
          'repeating-linear-gradient(45deg, transparent 0 6px, var(--cth-paper-100) 6px 12px)',
        userSelect: 'none'
      }}
    >
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
        color: 'var(--cth-ink-500)'
      }}>
        {t('visitorMode.sealed')}
      </div>
      <p style={{
        margin: 0, fontSize: 13, lineHeight: '18px',
        color: 'var(--cth-ink-700)', maxWidth: 320
      }}>
        {label ?? t('visitorMode.sealedGeneric')}
      </p>
      <p style={{
        margin: 0, fontSize: 12, lineHeight: '16px',
        color: 'var(--cth-ink-500)', maxWidth: 320
      }}>
        {t('visitorMode.sealedHint')}
      </p>
    </div>
  );
}

/**
 * Titlebar indicator. Renders nothing when the flag is off, so the chrome is
 * byte-identical in the default case.
 *
 * Visitor mode hides things; without a marker the app just looks broken, and an
 * operator who cannot tell an armed privacy screen from a bug will eventually
 * turn the wrong one off. This is the only always-on affordance, which is also
 * why it says the mode's name and nothing about the work.
 */
export function VisitorModeBadge() {
  const visitorMode = useStore((s) => s.visitorMode);
  const { t } = useTranslation();
  if (!visitorMode) return null;
  return (
    <span
      className="cth-titlebar-nodrag"
      title={t('visitorMode.badgeTip')}
      style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-on-accent)',
        background: 'var(--cth-sky)',
        padding: '4px 6px', borderRadius: 2,
        flexShrink: 0, whiteSpace: 'nowrap'
      }}
    >
      {t('visitorMode.badge')}
    </span>
  );
}
