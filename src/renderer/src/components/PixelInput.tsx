import { CSSProperties, InputHTMLAttributes, forwardRef } from 'react';

type Size = 'sm' | 'md' | 'lg';

export interface PixelInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: Size;
  /** Paints the border coral and swaps in the error foreground — same pattern
   *  as a form field that failed validation elsewhere in the app. */
  error?: boolean;
  fullWidth?: boolean;
  style?: CSSProperties;
}

// Mirrors PixelButton's height scale so an input sitting beside a button lines
// up exactly instead of drifting a pixel or two off its baseline.
const heightBySize: Record<Size, number> = { sm: 24, md: 32, lg: 40 };
const fontSizeBySize: Record<Size, string> = {
  sm: 'var(--cth-text-body-sm)',
  md: 'var(--cth-text-body-sm)',
  lg: 'var(--cth-text-body-md)'
};

/** Pixel-aesthetic text input — same fill/border/font contract as PixelPanel's
 *  "inset" surfaces, so a form built from these controls reads as one family
 *  with the buttons and panels around it. */
export const PixelInput = forwardRef<HTMLInputElement, PixelInputProps>(function PixelInput(
  { size = 'md', error = false, fullWidth = true, disabled, style, ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      disabled={disabled}
      style={{
        height: heightBySize[size],
        padding: '0 8px',
        width: fullWidth ? '100%' : 'auto',
        background: disabled ? 'var(--cth-cream-200)' : 'var(--cth-paper-100)',
        border: 'none',
        boxShadow: `inset 0 0 0 1px ${error ? 'var(--cth-coral)' : 'var(--cth-ink-100)'}`,
        fontFamily: 'var(--cth-font-ui)',
        fontSize: fontSizeBySize[size],
        color: disabled ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)',
        outline: 'none',
        boxSizing: 'border-box',
        cursor: disabled ? 'not-allowed' : 'text',
        ...style
      }}
      {...rest}
    />
  );
});
