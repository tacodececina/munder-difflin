// Custom theme registry — user-imported office-theme bundles (Phase 4:
// tvshow-phase4-custom-bundles), the theme-side counterpart to customCast.ts's
// user-imported characters (Phase 3).
//
// PERSISTENCE DECISION: same shape as customCast.ts, and for the same reasons
// (see that file's header) — this is purely renderer-side cosmetic data no
// main-process code branches on. The twist versus a custom CHARACTER is that a
// theme bundle is a whole FOLDER of files (theme.json + a .tmj + PNGs), far too
// big to inline into localStorage the way a character's Recipe is. So only a
// small POINTER record is persisted here — id, display label, and the
// bundle's absolute folder path — and the actual bundle content is re-read
// off disk (via window.cth's sandboxed fs IPC) every time the theme loads.
// See themeLoader.ts's `loadUserThemeBundle` for that read+validate+build path.
//
// Runtime theme ids for custom bundles are `custom:<uuid>`, the SAME prefix
// customCast.ts uses for custom characters (Phase 3 precedent, reused
// deliberately per the phase brief). This is safe despite the shared prefix:
// a theme id only ever flows through `officeTheme` / `ThemeId`-typed fields,
// and a character id only ever flows through agent `character`-name fields —
// the two id spaces never mix at a call site, so a collision in the textual
// prefix has no behavioral effect.

import { useSyncExternalStore } from 'react';

export const CUSTOM_THEME_ID_PREFIX = 'custom:' as const;

/** A custom theme's id is always `custom:<uuid>` — typed as its own template
 *  literal (rather than plain `string`) so it's directly assignable to
 *  themeRegistry.ts's `ThemeId` (whose `` `custom:${string}` `` branch has
 *  the exact same shape) without a cast at every call site. */
export type CustomThemeId = `${typeof CUSTOM_THEME_ID_PREFIX}${string}`;

export interface CustomThemeRecord {
  id: CustomThemeId;
  label: string;
  /** Absolute path to the bundle folder (theme.json + map + tilesets live here). */
  bundlePath: string;
}

interface StoredCustomThemeV1 {
  version: 1;
  id: string;
  label: string;
  bundlePath: string;
}

const LS_KEY = 'cth.customThemes.v1';

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

function migrateOne(raw: unknown): CustomThemeRecord | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;
  const r = raw as Partial<StoredCustomThemeV1>;
  if (typeof r.id !== 'string' || !r.id.startsWith(CUSTOM_THEME_ID_PREFIX)) return null;
  if (typeof r.label !== 'string' || !r.label.trim()) return null;
  if (typeof r.bundlePath !== 'string' || !r.bundlePath.trim()) return null;
  return { id: r.id as CustomThemeId, label: r.label, bundlePath: r.bundlePath };
}

function load(): CustomThemeRecord[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: CustomThemeRecord[] = [];
    for (const entry of parsed) {
      const c = migrateOne(entry);
      if (c) out.push(c);
    }
    return out;
  } catch {
    return [];
  }
}

function persist(list: CustomThemeRecord[]): void {
  try {
    const stored: StoredCustomThemeV1[] = list.map((c) => ({
      version: 1,
      id: c.id,
      label: c.label,
      bundlePath: c.bundlePath,
    }));
    window.localStorage.setItem(LS_KEY, JSON.stringify(stored));
  } catch {
    /* best-effort persist — a full localStorage must not crash the import flow,
     * it just won't remember this theme past the session. */
  }
}

let cache: CustomThemeRecord[] = load();
const listeners = new Set<() => void>();
function notify(): void {
  for (const l of [...listeners]) l();
}

/** Every imported custom theme, most-recently-imported last. */
export function listCustomThemes(): CustomThemeRecord[] {
  return cache;
}

export function getCustomTheme(id: string): CustomThemeRecord | undefined {
  return cache.find((c) => c.id === id);
}

export function isCustomThemeId(id: string): boolean {
  return id.startsWith(CUSTOM_THEME_ID_PREFIX);
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the timestamp-based id below */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Register a bundle that already passed validation. Returns the new record
 *  (with its freshly minted id) so the caller can switch to it immediately. */
export function saveCustomTheme(label: string, bundlePath: string): CustomThemeRecord {
  const entry: CustomThemeRecord = {
    id: `${CUSTOM_THEME_ID_PREFIX}${randomId()}`,
    label: label.trim() || 'Custom theme',
    bundlePath,
  };
  cache = [...cache, entry];
  persist(cache);
  notify();
  return entry;
}

export function deleteCustomTheme(id: string): void {
  const next = cache.filter((c) => c.id !== id);
  if (next.length === cache.length) return;
  cache = next;
  persist(cache);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Live custom theme list — re-renders the caller whenever one is imported or
 *  deleted, from anywhere (the picker, a future manager view, ...). */
export function useCustomThemes(): CustomThemeRecord[] {
  return useSyncExternalStore(subscribe, listCustomThemes, listCustomThemes);
}
