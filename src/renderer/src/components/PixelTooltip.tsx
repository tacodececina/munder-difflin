import { CSSProperties, ReactNode } from 'react';

export interface PixelTooltipProps {
  /** The tooltip text — kept short; pass `wrap` for a hint long enough to need
   *  more than a couple of words. */
  label: string;
  children: ReactNode;
  /** Anchor the bubble to the left edge instead of the default right edge, for
   *  a control near the right side of its container (mirrors `.cth-tip-left`). */
  left?: boolean;
  /** Let the bubble wrap onto multiple lines instead of staying `nowrap`
   *  (mirrors `.cth-tip-wrap`). */
  wrap?: boolean;
  style?: CSSProperties;
  className?: string;
}

/**
 * Thin wrapper around the app's existing CSS-only tooltip (`design/global.css`'s
 * `.cth-tip` + `data-tip`, already used across the title bar). Kept CSS-driven
 * on purpose: no state, no re-render, and that mechanism already carries the
 * RTL edge flip and `prefers-reduced-motion` handling — a React-positioned
 * tooltip would have to reimplement both from scratch.
 */
export function PixelTooltip({ label, children, left = false, wrap = false, style, className }: PixelTooltipProps) {
  const classes = ['cth-tip', left && 'cth-tip-left', wrap && 'cth-tip-wrap', className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} data-tip={label} style={{ display: 'inline-flex', ...style }}>
      {children}
    </span>
  );
}
