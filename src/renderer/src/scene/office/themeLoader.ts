// Theme loader — resolves a ThemeConfig into a ready-to-render map.
//
// Phase 0 keeps this thin: it parses the theme's Tiled JSON and patches the
// appended tileset atlases with their inline metadata (the same patch the
// office scene did inline as resolveMap()). The async `loadTheme` signature is
// deliberate headroom for later phases, where a show bundle may be fetched and
// validated before it's handed to the scene; on any failure it falls back to
// the office theme so a bad/absent bundle never breaks the floor (report §E).
//
// Phase 4 cashes in that headroom: a `custom:<uuid>` id resolves through
// customThemes.ts to a user-picked bundle FOLDER on disk (theme.json + a .tmj
// + tileset PNGs), read via the existing sandboxed fs IPC (window.cth — the
// same bridge AddAgentModal's folder picker already uses), validated with
// themeBundle.ts, and turned into a real ThemeConfig. Any failure anywhere in
// that pipeline falls back to the office theme, same as every other bad/absent
// theme case here.

import type { TiledMap } from './TiledMapRenderer';
import {
  getTheme,
  OFFICE_THEME,
  type ThemeConfig,
  type ThemeId,
  type TilesetEntry,
} from './themeRegistry';
import {
  validateManifestShape,
  validateBundleAgainstMap,
  parseHexColor,
  type ThemeBundleManifest,
} from './themeBundle';
import { getCustomTheme, isCustomThemeId } from './customThemes';

/** Parse a theme's raw Tiled JSON and patch its tileset array.
 *  `embedded` atlases keep the map's own inline metadata; the rest are replaced
 *  by the theme's inline metadata (firstgid + image dimensions). The result's
 *  tileset order matches the texture-load order (texture[i] ↔ tilesets[i]). */
export function resolveThemeMap(theme: ThemeConfig): TiledMap {
  const m = JSON.parse(theme.mapRaw) as TiledMap;
  return {
    ...m,
    tilesets: theme.tilesets.map((t, i) => {
      if (t.embedded) return m.tilesets[i];
      // Strip the renderer-only fields (url/embedded/procedural); the rest is
      // Tiled metadata.
      const { url: _url, embedded: _embedded, procedural: _procedural, ...meta } = t;
      return meta as TiledMap['tilesets'][number];
    }),
  };
}

/** The ordered tileset image URLs to load as textures, matching the map's
 *  tileset order (so texture[i] lines up with tilesets[i]). */
export function themeTilesetUrls(theme: ThemeConfig): string[] {
  return theme.tilesets.map((t) => t.url);
}

/** Light validation: the theme's map must parse and carry sane dimensions. */
function isThemeRenderable(theme: ThemeConfig): boolean {
  try {
    const m = JSON.parse(theme.mapRaw) as TiledMap;
    return (
      typeof m.width === 'number' && m.width > 0 &&
      typeof m.height === 'number' && m.height > 0 &&
      Array.isArray(m.layers) && Array.isArray(m.tilesets)
    );
  } catch {
    return false;
  }
}

/** Read one bundle file as text via the sandboxed fs IPC, normalizing its
 *  { ok, error } shape into a thrown Error so callers can just try/catch the
 *  whole bundle-loading sequence instead of threading error checks through
 *  every await. */
async function readBundleText(bundlePath: string, rel: string): Promise<string> {
  const res = await window.cth.readFile(bundlePath, rel);
  if (!res.ok) throw new Error(`could not read "${rel}": ${res.error}`);
  return res.content;
}

/** Read one bundle file as bytes and turn it into a `blob:` URL — the same
 *  trick fs.ts's readBinary doc comment describes for images elsewhere in the
 *  app (no `file:` source in the CSP, so bytes travel over IPC and become a
 *  blob URL client-side). The URL is intentionally never revoked: it lives for
 *  the lifetime of the loaded theme, matching how the bundled themes' Vite
 *  `?url` imports are themselves never-revoked, process-lifetime URLs. */
async function readBundleImageAsBlobUrl(bundlePath: string, rel: string): Promise<string> {
  const res = await window.cth.readBinary(bundlePath, rel);
  if (!res.ok) throw new Error(`could not read "${rel}": ${res.error}`);
  const blob = new Blob([res.bytes], { type: res.mime });
  return URL.createObjectURL(blob);
}

/** Convert a validated bundle manifest + resolved map text + resolved tileset
 *  texture URLs into a real ThemeConfig. Pure (no I/O) — split out from
 *  `loadUserThemeBundle` so it's independently testable. Custom themes always
 *  borrow the built-in cast (fixed roster + any Phase 3 custom characters),
 *  exactly like the placeholder Brooklyn99 theme reuses OFFICE_THEME.cast —
 *  authoring a whole new cast is out of scope for a Phase 4 theme bundle. */
export function buildThemeConfigFromBundle(
  id: ThemeId,
  manifest: ThemeBundleManifest,
  mapRawText: string,
  tilesetUrls: string[],
): ThemeConfig {
  const tilesets: TilesetEntry[] = manifest.tilesets.map((t, i) => ({
    url: tilesetUrls[i],
    embedded: t.embedded,
    firstgid: t.firstgid,
    image: t.image,
    imagewidth: t.imagewidth,
    imageheight: t.imageheight,
    tilewidth: t.tilewidth,
    tileheight: t.tileheight,
    columns: t.columns,
    tilecount: t.tilecount,
  }));
  const noteColors: Record<string, number> = {};
  for (const [k, v] of Object.entries(manifest.palette.noteColors)) {
    noteColors[k] = parseHexColor(v) ?? 0xffffff;
  }
  return {
    id,
    mapRaw: mapRawText,
    tilesets,
    primarySeatNames: manifest.primarySeatNames,
    cafeSeatNames: manifest.cafeSeatNames,
    cafeStands: manifest.cafeStands,
    coffee: manifest.coffee,
    anchors: manifest.anchors,
    errandSpots: manifest.errandSpots,
    monitor: manifest.monitor,
    palette: {
      background: parseHexColor(manifest.palette.background) ?? OFFICE_THEME.palette.background,
      noteColors,
    },
    cast: OFFICE_THEME.cast,
  };
}

export interface BundleLoadResult {
  ok: boolean;
  theme?: ThemeConfig;
  errors?: string[];
}

type ManifestValidationResult =
  | { ok: true; manifest: ThemeBundleManifest; mapRawText: string }
  | { ok: false; errors: string[] };

/** Shared first half of bundle loading: read theme.json + the map text off
 *  disk and run BOTH validation passes (themeBundle.ts). No tileset PNGs are
 *  touched here — this is the exact work the "Import theme…" UI needs to
 *  validate a bundle before registering it, without paying for texture I/O
 *  that would only be thrown away if validation then failed. */
async function readAndValidateBundle(bundlePath: string): Promise<ManifestValidationResult> {
  let rawManifest: unknown;
  try {
    const manifestText = await readBundleText(bundlePath, 'theme.json');
    rawManifest = JSON.parse(manifestText);
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }

  const shapeResult = validateManifestShape(rawManifest);
  if (!shapeResult.ok) return { ok: false, errors: shapeResult.errors.map((e) => e.message) };
  const manifest = shapeResult.manifest;

  let mapRawText: string;
  try {
    mapRawText = manifest.mapFile ? await readBundleText(bundlePath, manifest.mapFile) : (manifest.mapRaw as string);
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }

  const mapErrors = validateBundleAgainstMap(manifest, mapRawText);
  if (mapErrors.length > 0) return { ok: false, errors: mapErrors.map((e) => e.message) };

  return { ok: true, manifest, mapRawText };
}

/**
 * Validate a bundle FOLDER on disk without building a renderable ThemeConfig
 * (no tileset texture I/O, no blob URLs minted) — what the "Import theme…" UI
 * runs right after the folder picker, before ever registering the bundle in
 * customThemes.ts. Never throws; every failure comes back as human-readable,
 * specific messages (see themeBundle.ts) — never a stack trace or a generic
 * "invalid bundle".
 */
export async function validateUserThemeBundle(bundlePath: string): Promise<
  { ok: true; manifest: ThemeBundleManifest } | { ok: false; errors: string[] }
> {
  const result = await readAndValidateBundle(bundlePath);
  if (!result.ok) return result;
  return { ok: true, manifest: result.manifest };
}

/**
 * Read, validate and build a ThemeConfig from a bundle FOLDER on disk — the
 * full pipeline `loadTheme` uses to actually resolve a `custom:<uuid>` id at
 * render time (tileset PNGs become fresh `blob:` URLs here, so this must be
 * re-run every time the theme is (re)loaded — blob URLs don't survive a
 * process restart). Never throws.
 */
export async function loadUserThemeBundle(bundlePath: string, id: ThemeId): Promise<BundleLoadResult> {
  const validated = await readAndValidateBundle(bundlePath);
  if (!validated.ok) return { ok: false, errors: validated.errors };

  let tilesetUrls: string[];
  try {
    tilesetUrls = await Promise.all(validated.manifest.tilesets.map((t) => readBundleImageAsBlobUrl(bundlePath, t.file)));
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }

  return { ok: true, theme: buildThemeConfigFromBundle(id, validated.manifest, validated.mapRawText, tilesetUrls) };
}

/** Resolve a theme id to a renderable ThemeConfig. Async by design (later
 *  phases may fetch a show bundle here); falls back to the office theme if the
 *  requested theme is missing, unregistered, invalid, or its map won't parse —
 *  a bad/absent theme (built-in or custom) must never break the floor. */
export async function loadTheme(id: ThemeId): Promise<ThemeConfig> {
  if (isCustomThemeId(id)) {
    const record = getCustomTheme(id);
    if (!record) {
      console.warn(`[themeLoader] custom theme '${id}' has no registered bundle — falling back to 'office'`);
      return OFFICE_THEME;
    }
    const result = await loadUserThemeBundle(record.bundlePath, id);
    if (!result.ok || !result.theme) {
      console.warn(`[themeLoader] custom theme '${id}' (${record.bundlePath}) failed to load — falling back to 'office':\n- ${(result.errors ?? []).join('\n- ')}`);
      return OFFICE_THEME;
    }
    return result.theme;
  }

  const theme = getTheme(id);
  if (!isThemeRenderable(theme)) {
    console.warn(`[themeLoader] theme '${id}' is not renderable — falling back to 'office'`);
    return OFFICE_THEME;
  }
  return theme;
}
