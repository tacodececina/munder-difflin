import { CSSProperties, ReactNode } from 'react';

export type PixelTabsVariant = 'strip' | 'rail';

export interface PixelTabItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
}

export interface PixelTabsProps {
  items: PixelTabItem[];
  current: string;
  onChange: (key: string) => void;
  /** 'strip' — horizontal row, active tab lit with a colored underline (the
   *  shape SidebarTabs used). 'rail' — vertical list, active item filled solid
   *  with a colored left border (the shape SettingsModal's nav used). */
  variant?: PixelTabsVariant;
  /** Accent color as a CSS value, e.g. `var(--cth-sky)`. Defaults to
   *  `var(--cth-ink-900)` for 'strip' and `var(--cth-lemon)` for 'rail' —
   *  matching what each site painted before this component existed. */
  accentColor?: string;
  style?: CSSProperties;
}

/**
 * Generic tab list backing BOTH SidebarTabs (horizontal, icon + short caps
 * label, per-agent accent underline) and SettingsModal's left nav (vertical,
 * text-only, filled dark on active). The two looked different enough that a
 * single visual would have meant a redesign of one or the other, so this keeps
 * both exact looks as named `variant`s instead — one component, two skins,
 * rather than two components implementing the same tab-list logic twice.
 */
export function PixelTabs({ items, current, onChange, variant = 'strip', accentColor, style }: PixelTabsProps) {
  if (variant === 'rail') {
    const active = accentColor ?? 'var(--cth-lemon)';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', ...style }}>
        {items.map((item) => {
          const isActive = current === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onChange(item.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                width: '100%', textAlign: 'left',
                padding: '10px 16px 8px',
                border: 'none',
                borderLeft: isActive ? `3px solid ${active}` : '3px solid transparent',
                background: isActive ? 'var(--cth-ink-900)' : 'transparent',
                color: isActive ? 'var(--cth-cream-50)' : 'var(--cth-ink-700)',
                fontFamily: 'var(--cth-font-display)',
                fontSize: 8,
                lineHeight: '12px',
                cursor: 'pointer'
              }}
            >
              {item.icon}{item.label}
            </button>
          );
        })}
      </div>
    );
  }

  // 'strip'
  const active = accentColor ?? 'var(--cth-ink-900)';
  return (
    <div
      style={{
        display: 'flex', gap: 0,
        background: 'var(--cth-cream-200)',
        boxShadow: 'inset 0 -2px 0 var(--cth-ink-900)',
        flexShrink: 0,
        ...style
      }}
    >
      {items.map((item) => {
        const isActive = current === item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            style={{
              flex: 1, height: 36, padding: '0 10px',
              border: 'none', cursor: 'pointer',
              background: isActive ? 'var(--cth-cream-100)' : 'transparent',
              boxShadow: isActive
                ? `inset 0 -3px 0 ${active}, inset 1px 0 0 var(--cth-ink-900), inset -1px 0 0 var(--cth-ink-900)`
                : 'inset 0 0 0 0',
              fontFamily: 'var(--cth-font-display)',
              fontSize: 10,
              lineHeight: '14px',
              color: isActive ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6
            }}
          >
            {item.icon}{item.label}
          </button>
        );
      })}
    </div>
  );
}
