import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { PixelPanel } from './PixelPanel';
import { wingLabelKey, wingFallbackLabel } from '@/scene/office/wingFraming';

/**
 * "Which part of the office am I looking at?" — the camera control for the
 * rebuilt office floor's named wings.
 *
 * WHY IT EXISTS. The office map grew to 48x36 tiles and the camera only knew
 * how to fit ALL of it into the panel, so every desk, sign and avatar shrank and
 * the floor read as cramped. Framing one wing at a time gives the layout its air
 * back. The camera has had `focusOn()` for this since it was ported; the framing
 * arithmetic is in scene/office/wingFraming.ts and the wiring in OfficeFloor.
 *
 * WHERE IT LIVES. Floating over the scene, top-leading corner — the same shape
 * as MemoryPanel in the opposite corner (a pill that opens a panel, mounted as a
 * sibling of OfficeFloor in AppShell), because that is this app's one existing
 * pattern for a control that belongs to the floor rather than to Settings. The
 * theme picker is NOT the precedent to copy: switching theme is a rare,
 * destructive act that archives agents, so it lives behind Settings; choosing
 * where to look is a glance-frequency control and would be useless there.
 *
 * IT DOES NOT ALWAYS MOUNT. `officeWings` is published by the scene from the map
 * it actually loaded, so the four themes whose maps have no `wing-*` zones —
 * and any user-authored bundle — render nothing at all here. No dead control, no
 * per-theme special case, and nothing for those themes to break.
 *
 * THE WAY OUT IS ALWAYS PRESENT. "Whole office" is the first option, the
 * default, and the pill's own label whenever it is active, so no one can end up
 * inside a wing without an obvious way back to the floor.
 */
export function OfficeWingPicker() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wings = useStore((s) => s.officeWings);
  const wing = useStore((s) => s.officeWing);
  const setWing = useStore((s) => s.setOfficeWing);

  // No wings on this map: the whole control is meaningless, so it does not
  // exist. (A one-option picker offering only "whole office" would be worse
  // than nothing — a button that cannot change anything.)
  if (wings.length === 0) return null;

  const labelFor = (name: string) => t(wingLabelKey(name), { defaultValue: wingFallbackLabel(name) });
  const allLabel = t('office.wings.all');
  const current = wing ? labelFor(wing) : allLabel;

  const choose = (name: string | null) => {
    setWing(name);
    setOpen(false);
  };

  return (
    <div
      style={{ position: 'absolute', insetBlockStart: 12, insetInlineStart: 12, zIndex: 40 }}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}
    >
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          title={t('office.wings.openTitle')}
          aria-label={t('office.wings.openTitle')}
          aria-expanded={false}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '5px 10px 3px',
            // Lit up whenever the camera is NOT on the whole floor, so "you are
            // inside a wing" is readable without opening anything.
            background: wing ? 'var(--cth-lemon-light)' : 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12,
            color: 'var(--cth-ink-900)',
            cursor: 'pointer',
            border: 'none'
          }}
        >
          <FloorPlanGlyph />
          {current}
        </button>
      ) : (
        <div style={{ width: 220 }}>
          <PixelPanel variant="dialog" title={t('office.wings.title')} noPadding>
            <div role="group" aria-label={t('office.wings.title')} style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {/* Always first, always present — the way back to the whole floor. */}
              <WingOption label={allLabel} selected={wing === null} onClick={() => choose(null)} />
              {wings.map((name) => (
                <WingOption
                  key={name}
                  label={labelFor(name)}
                  selected={wing === name}
                  onClick={() => choose(name)}
                />
              ))}
              <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)', marginTop: 4 }}>
                {t('office.wings.hint')}
              </div>
            </div>
          </PixelPanel>
        </div>
      )}
    </div>
  );
}

function WingOption({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        textAlign: 'start', width: '100%', padding: '6px 8px 5px',
        background: selected ? 'var(--cth-lemon-light)' : 'var(--cth-cream-100)',
        boxShadow: selected ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-300)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
        border: 'none', cursor: 'pointer'
      }}
    >
      <span style={{
        width: 8, height: 8, flexShrink: 0,
        background: selected ? 'var(--cth-ink-900)' : 'transparent',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }} />
      {label}
    </button>
  );
}

/** A floor plan: one room outlined inside a larger one. Drawn on the same 16x16
 *  pixel grid as components/Icon.tsx rather than added to it, because it is the
 *  only place in the app that needs it. */
function FloorPlanGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <path fill="currentColor" d="M1 1h14v14H1V1zm1 1v12h12V2H2zM4 4h5v5H4V4z" />
    </svg>
  );
}
