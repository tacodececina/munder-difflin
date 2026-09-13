// Custom character registry — user-authored portrait `Recipe`s beyond the fixed
// 15-person "Office" roster, created from the "+ Create character" builder in
// AddAgentModal.
//
// PERSISTENCE DECISION (see phase report): this lives in the renderer's own
// localStorage, not in the main-process HarnessConfig (window.cth.getConfig /
// updateConfig). Reasons:
//   - It is purely cosmetic, renderer-only data (a paint recipe for a canvas)
//     that no main-process code ever needs to read — unlike e.g. registeredRepos
//     or MCP consent, nothing on the Node side branches on it.
//   - Adding a field to HarnessConfig means touching three mirrored interfaces
//     (src/main/config.ts, src/preload/index.ts, src/renderer/src/store/config.ts)
//     plus its IPC round-trip, for data that never needs to leave this process.
//   - localStorage-for-renderer-only-settings is already this codebase's own
//     precedent — see terminalFontSize.ts (a plain versioned key) and
//     rosterSource.ts (the roster itself falls back to localStorage). This file
//     follows the same shape: a versioned envelope per entry (so a future Recipe
//     shape change can migrate old saves instead of corrupting them), a module-
//     level cache, and a useSyncExternalStore hook for live re-renders.
// A future phase can promote this into a file-backed store (mirroring roster.json)
// if custom characters need to roam across machines with the hive; nothing here
// blocks that migration since callers only see the CustomCharacter shape.

import { useSyncExternalStore } from 'react';
import type { Recipe } from './portraitArt';

/** Every custom character id is prefixed so it can never collide with a fixed
 *  `OfficeCharacterName` and so callers can cheaply tell the two apart. */
export const CUSTOM_ID_PREFIX = 'custom:';

export interface CustomCharacter {
  id: string; // `custom:<uuid>`
  displayName: string;
  /** Accent color (hex, e.g. "#6fa8dc") — mirrors CastMember.shirt, used as a
   *  fallback for the in-scene selection glow when the agent's own accent
   *  color can't be resolved. */
  accent: string;
  recipe: Recipe;
}

/** On-disk (localStorage) shape, versioned so a future Recipe shape change can
 *  migrate old saves instead of silently corrupting or crashing on them. */
interface StoredCustomCharacterV1 {
  version: 1;
  id: string;
  displayName: string;
  accent: string;
  recipe: Recipe;
}

const LS_KEY = 'cth.customCast.v1';

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

/** Defensive shape check before trusting a stored recipe — mirrors the fallback
 *  pattern cast.ts already uses for the fixed roster (`RECIPES[name] ??
 *  RECIPES.jim`): a corrupt or future-shaped entry is dropped, never thrown. */
function isValidRecipe(v: unknown): v is Recipe {
  if (!isRecord(v)) return false;
  if (typeof v.skin !== 'string') return false;
  if (!Array.isArray(v.hairc) || v.hairc.length !== 3) return false;
  if (typeof v.hair !== 'string') return false;
  if (typeof v.cloth !== 'string') return false;
  if (!Array.isArray(v.c1) || v.c1.length !== 3) return false;
  return true;
}

function migrateOne(raw: unknown): CustomCharacter | null {
  if (!isRecord(raw)) return null;
  // version 1 is the only shape today; an unrecognized version is a save from
  // a future build we don't understand yet — drop it rather than guess.
  if (raw.version !== 1) return null;
  const r = raw as Partial<StoredCustomCharacterV1>;
  if (typeof r.id !== 'string' || !r.id.startsWith(CUSTOM_ID_PREFIX)) return null;
  if (typeof r.displayName !== 'string' || !isValidRecipe(r.recipe)) return null;
  return {
    id: r.id,
    displayName: r.displayName,
    accent: typeof r.accent === 'string' ? r.accent : '#6fa8dc',
    recipe: r.recipe
  };
}

function load(): CustomCharacter[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: CustomCharacter[] = [];
    for (const entry of parsed) {
      const c = migrateOne(entry);
      if (c) out.push(c);
    }
    return out;
  } catch {
    return [];
  }
}

function persist(list: CustomCharacter[]): void {
  try {
    const stored: StoredCustomCharacterV1[] = list.map((c) => ({
      version: 1,
      id: c.id,
      displayName: c.displayName,
      accent: c.accent,
      recipe: c.recipe
    }));
    window.localStorage.setItem(LS_KEY, JSON.stringify(stored));
  } catch {
    /* best-effort persist — a full localStorage / private-mode browser must
     * not crash the builder, it just won't remember this character. */
  }
}

let cache: CustomCharacter[] = load();
const listeners = new Set<() => void>();
function notify(): void {
  for (const l of [...listeners]) l();
}

/** The full custom roster, most-recently-created last. */
export function listCustomCharacters(): CustomCharacter[] {
  return cache;
}

export function getCustomCharacter(id: string): CustomCharacter | undefined {
  return cache.find((c) => c.id === id);
}

export function isCustomCharacterId(id: string): boolean {
  return id.startsWith(CUSTOM_ID_PREFIX);
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

/** Save a new custom character and return it (with its freshly minted id). */
export function saveCustomCharacter(displayName: string, accent: string, recipe: Recipe): CustomCharacter {
  const entry: CustomCharacter = {
    id: `${CUSTOM_ID_PREFIX}${randomId()}`,
    displayName: displayName.trim() || 'Custom',
    accent,
    recipe
  };
  cache = [...cache, entry];
  persist(cache);
  notify();
  return entry;
}

export function deleteCustomCharacter(id: string): void {
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

/** Live custom roster — re-renders the caller whenever a character is saved or
 *  deleted, from anywhere (the builder modal, a future manager view, ...). */
export function useCustomCharacters(): CustomCharacter[] {
  return useSyncExternalStore(subscribe, listCustomCharacters, listCustomCharacters);
}
