// Design tokens — single source of truth. Mirrors tokens.css for non-styled consumers (Pixi).
// Any change here must also update tokens.css.

export const colors = {
  cream: {
    50: 0xfffdf5,
    100: 0xfff8e7,
    200: 0xf4e9c7,
    300: 0xe8d9a0
  },
  paper: {
    100: 0xfcfaf0,
    200: 0xf0ead2
  },
  ink: {
    900: 0x1a1320,
    700: 0x3d2e4a,
    500: 0x6b5878,
    300: 0xa899b5,
    100: 0xd9cfe0
  },
  // v0.3.4 recalibration: same hues, professional saturation (mirrors tokens.css)
  accent: {
    coral: 0xd96a62,
    coralLight: 0xf3d3cd,
    mint: 0x5ca97a,
    mintLight: 0xd2e7da,
    sky: 0x4f9faf,
    skyLight: 0xcfe5e9,
    lemon: 0xdcab3c,
    lemonLight: 0xf3e4bc,
    lilac: 0x9482d3,
    lilacLight: 0xe0daf2,
    peach: 0xd99168,
    peachLight: 0xf3daca
  },
  status: {
    idle: 0xa199ab,
    thinking: 0x4f9faf,
    working: 0xdcab3c,
    blocked: 0xd96a62,
    success: 0x5ca97a,
    ghost: 0xd9d3de
  },
  world: {
    grassLight: 0xd4eab0,
    grassDark: 0xb5d589,
    woodLight: 0xe5c896,
    woodDark: 0xc9a66b,
    path: 0xe8d8b0,
    wall: 0x8b6f47
  }
} as const;

export const space = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64
} as const;

/**
 * `type.display` (Press Start 2P) is the app's BRAND face — reserve it for
 * short, fixed-length text only: the app title, agent names on cards, status
 * badges, section/tab headers, and standalone numbers. NEVER put paragraph
 * text, descriptions, or any i18n string whose length varies by locale in it —
 * Arabic and long-form CJK/German-via-fallback strings break the pixel grid's
 * rhythm at display sizes. Body copy, descriptions, and free-length text
 * always use `type.ui` (or `type.mono` for code/terminal content). Audited
 * 2026-09 across `components/`: existing usage already holds this line
 * (short caps labels/badges/titles only) — keep new usage the same way.
 */
export const type = {
  display: '"Press Start 2P", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Geeza Pro", "Noto Naskh Arabic", "Segoe UI Historic", monospace',
  ui: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Geeza Pro", "Noto Naskh Arabic", "Segoe UI Historic", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, "PingFang SC", "Microsoft YaHei", "Noto Sans Mono CJK SC", "Noto Sans CJK SC", "Geeza Pro", "Noto Naskh Arabic", "Segoe UI Historic", monospace'
} as const;

// Elevation — hard, pixel-art drop shadows: solid offset, zero blur (never a
// soft/blurred shadow — that reads as a different, non-pixel-art style).
// `md` is the pre-existing `--cth-shadow-hard` (tokens.css), kept under its
// original name since components already reference it; `sm`/`lg` round it out
// into a 3-step scale. Light-mode values only, same convention as `colors`
// above — dark-mode swaps live in tokens.css.
export const elevation = {
  sm: '2px 2px 0 rgba(26, 19, 32, 0.14)',
  md: '3px 3px 0 rgba(26, 19, 32, 0.14)',
  lg: '5px 5px 0 rgba(26, 19, 32, 0.18)'
} as const;

// Border/frame constants — the "chunky console" framing already established by
// PixelPanel (see its `boxShadow: inset 0 0 0 Npx` variants). Reuse these
// rather than hand-rolling a new inset width per component.
export const border = {
  /** Standard 1px hairline — PixelPanel default/inset/terminal/dialog borders. */
  hairline: 1,
  /** The thick accent ring PixelPanel's "active" variant paints 3px inset. */
  chunky: 3
} as const;

// Motion — durations in ms for UI transitions, plus a `steps()` easing for
// frame-by-frame "sprite" animation (no interpolation) alongside standard
// easings for ordinary fades/slides.
export const motion = {
  duration: { fast: 90, base: 180, slow: 300 } as const,
  easeStandard: 'cubic-bezier(0.4, 0, 0.2, 1)',
  easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
  /** Stepped easing for sprite-sheet-style animation — `steps(4)`, `steps(8)`, etc. */
  easeSprite: (steps: number): string => `steps(${steps}, end)`
} as const;

// Z-index scale — named tiers for new overlays. Existing inline zIndex values
// across the app were audited (grep) and range from ~40 (in-scene popovers)
// to 1000 (the quit-warning dialog, which intentionally outranks every modal)
// and 9999 (the completion toast). These anchor the common tiers WITHOUT
// renumbering anything already shipped — a component with a hard requirement
// to sit above/below the pack still takes an explicit override.
export const zIndex = {
  panel: 40,
  overlay: 200,
  modal: 300,
  toast: 9999
} as const;

// Breakpoints — Phase 2 responsive shell. Two thresholds, three named bands:
// `width < bp.compact` -> 'compact', `bp.compact <= width < bp.wide` -> 'cozy'
// (today's default desktop layout, unchanged), `width >= bp.wide` -> 'wide'.
// Consumed by hooks/useBreakpoint.ts; mirrored as px values (not CSS vars,
// since JS needs the number to pick a band) — layout.css's own media queries
// are hand-kept in sync with these two numbers, same convention as `space`
// above vs. tokens.css.
//
// `compact` = 1100: below this, AppShell.tsx switches AgentStrip to
// portraits-only and floats AgentDetailPanel as an overlay instead of a fixed
// column — there simply is not room for a labelled roster AND a full-width
// scene AND a sidebar column. NOTE: src/main/index.ts pins the BrowserWindow's
// minimum size at 1280x800 (MIN_WIN) and Windows enforces that floor on a
// plain drag-resize, so this band will not fire from resizing the window on
// this platform today. It still fires for real, reachable cases — DevTools
// docked inside the same window (which shrinks window.innerWidth without
// touching the OS window bounds), platforms/window managers that do not
// honor `minWidth` as strictly as Windows does, and any future change to that
// floor — so the band is live code, not a dead threshold.
//
// `wide` = 2200: at/above this the shell stops stretching the detail/chat
// column edge-to-edge and centers it under a comfortable max-width instead
// (see `.cth-detail-col` in layout.css) — a full-width terminal/thread column
// on an ultrawide monitor reads as a wall of text, not a panel.
export const bp = {
  compact: 1100,
  wide: 2200
} as const;

export type BreakpointBand = 'compact' | 'cozy' | 'wide';

export const tileSize = 32; // px — the world is built from 32×32 tiles

export type AccentColorName =
  | 'coral' | 'mint' | 'sky' | 'lemon' | 'lilac' | 'peach';

export const accentByName: Record<AccentColorName, number> = {
  coral: colors.accent.coral,
  mint:  colors.accent.mint,
  sky:   colors.accent.sky,
  lemon: colors.accent.lemon,
  lilac: colors.accent.lilac,
  peach: colors.accent.peach
};

export const accentLightByName: Record<AccentColorName, number> = {
  coral: colors.accent.coralLight,
  mint:  colors.accent.mintLight,
  sky:   colors.accent.skyLight,
  lemon: colors.accent.lemonLight,
  lilac: colors.accent.lilacLight,
  peach: colors.accent.peachLight
};

// Convert 0xRRGGBB to "#RRGGBB"
export function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0').toUpperCase();
}
