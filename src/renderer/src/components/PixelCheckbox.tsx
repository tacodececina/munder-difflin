import { CSSProperties, ReactNode } from 'react';

export interface PixelCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  style?: CSSProperties;
}

const BOX = 18;

/** Pixel-aesthetic checkbox — a hard-edged inset box (PixelPanel's border
 *  contract) that fills solid on check rather than relying on the OS widget,
 *  so it reads as part of the same kit as PixelInput/PixelSelect. */
export function PixelCheckbox({ checked, onChange, label, disabled = false, style }: PixelCheckboxProps) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        userSelect: 'none',
        opacity: disabled ? 0.6 : 1,
        ...style
      }}
    >
      <span
        role="checkbox"
        aria-checked={checked}
        aria-disabled={disabled}
        onClick={() => { if (!disabled) onChange(!checked); }}
        style={{
          flexShrink: 0,
          width: BOX,
          height: BOX,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: checked ? 'var(--cth-ink-900)' : 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}
      >
        {checked && (
          <svg width="12" height="10" viewBox="0 0 12 10" fill="none" aria-hidden="true">
            <path d="M1 5.2 4.3 8.5 11 1.5" stroke="var(--cth-cream-50)" strokeWidth={2} strokeLinecap="square" />
          </svg>
        )}
      </span>
      {label !== undefined && (
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-900)' }}>
          {label}
        </span>
      )}
    </label>
  );
}
