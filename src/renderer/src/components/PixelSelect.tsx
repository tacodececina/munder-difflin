import { CSSProperties, SelectHTMLAttributes, forwardRef } from 'react';

type Size = 'sm' | 'md' | 'lg';

export interface PixelSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: Size;
  fullWidth?: boolean;
  style?: CSSProperties;
}

const heightBySize: Record<Size, number> = { sm: 24, md: 32, lg: 40 };
const fontSizeBySize: Record<Size, string> = {
  sm: 'var(--cth-text-body-sm)',
  md: 'var(--cth-text-body-sm)',
  lg: 'var(--cth-text-body-md)'
};

/** Pixel-aesthetic <select> — same fill/border contract as PixelInput, so a
 *  form mixing text fields and dropdowns reads as one control family. */
export const PixelSelect = forwardRef<HTMLSelectElement, PixelSelectProps>(function PixelSelect(
  { size = 'md', fullWidth = true, disabled, style, children, ...rest },
  ref
) {
  return (
    <select
      ref={ref}
      disabled={disabled}
      style={{
        height: heightBySize[size],
        padding: '0 6px',
        width: fullWidth ? '100%' : 'auto',
        background: disabled ? 'var(--cth-cream-200)' : 'var(--cth-paper-100)',
        border: 'none',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: fontSizeBySize[size],
        color: disabled ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',
        outline: 'none',
        boxSizing: 'border-box',
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style
      }}
      {...rest}
    >
      {children}
    </select>
  );
});
