// Custom theme bundle — manifest shape + validator (Phase 4: user-imported
// office themes).
//
// Deliberately pixi.js-FREE (only `import type` from themeRegistry.ts, erased
// at compile time) so this whole module — including the validator that runs
// before anything is ever rendered — loads and runs under plain `node --test`,
// with no Electron/browser/WebGL context. The actual file I/O (reading
// theme.json / the .tmj / the tileset PNGs off disk, turning PNGs into
// textures) lives in themeLoader.ts, which orchestrates around this module.
//
// BUNDLE FORMAT (a folder, chosen via the existing folder picker):
//   my-theme/
//     theme.json   — a ThemeBundleManifest (below), plain JSON
//     map.tmj      — Tiled JSON (referenced by manifest.mapFile), OR the
//                    manifest may inline the map as `mapRaw` (a JSON string)
//     *.png        — one file per non-embedded tileset entry
//
// See docs/theme-authoring.md for the authoring guide + a minimal example.

import type {
  Tile,
  Facing,
  ErrandKind,
  ErrandSpot,
  CoffeeConfig,
  AnchorConfig,
  MonitorConfig,
} from './themeRegistry';
import {
  buildWalkable,
  parseSpawnPoints,
  type TiledMap,
} from './tiledCollision';

/** One tileset atlas as declared in a bundle's theme.json. `file` is a path
 *  relative to the bundle folder; everything else mirrors themeRegistry.ts's
 *  `TilesetEntry` (minus `url`, which the loader fills in from `file`). */
export interface ThemeBundleTilesetEntry {
  file: string;
  embedded?: boolean;
  firstgid?: number;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  tilewidth?: number;
  tileheight?: number;
  columns?: number;
  tilecount?: number;
}

/** Palette colors are authored as hex strings ("#1a1320") in the bundle JSON —
 *  a bare JSON number can't spell a hex literal, and asking an author to
 *  compute the decimal form of a color is hostile. The loader converts these
 *  to the numeric form ThemeConfig.palette expects. */
export interface ThemeBundlePalette {
  background: string;
  noteColors: Record<string, string>;
}

/** The on-disk manifest shape (theme.json). Everything a bundle author writes
 *  by hand; the runtime `ThemeConfig` (themeRegistry.ts) is derived from this
 *  plus the resolved map text and tileset texture URLs. There is no `cast`
 *  field: custom themes always use the built-in roster (+ any custom
 *  characters from the Phase 3 avatar builder), exactly like the placeholder
 *  Brooklyn99 theme reuses OFFICE_THEME.cast — see themeLoader.ts. */
export interface ThemeBundleManifest {
  schemaVersion: 1;
  label: string;
  /** Path to the Tiled JSON, relative to the bundle folder. Mutually
   *  exclusive with `mapRaw` (mapFile wins if both are present). */
  mapFile?: string;
  /** The Tiled JSON inlined as a string, for a bundle that ships no separate
   *  .tmj file. */
  mapRaw?: string;
  tilesets: ThemeBundleTilesetEntry[];
  primarySeatNames: string[];
  cafeSeatNames: string[];
  cafeStands: Array<[string, 'coffee' | 'vending']>;
  coffee: CoffeeConfig;
  anchors: AnchorConfig;
  errandSpots: ErrandSpot[];
  monitor: MonitorConfig;
  palette: ThemeBundlePalette;
}

export interface BundleValidationError {
  /** Machine-readable category, for callers that want to group/count errors. */
  code: string;
  /** Complete, human-readable English sentence naming the SPECIFIC problem
   *  (e.g. "Seat 'pc-3' does not exist in the map's spawn-points layer.") —
   *  never a stack trace or a generic "invalid bundle". Shown as-is in the
   *  import UI, matching this codebase's existing precedent of interpolating
   *  raw diagnostic text into an i18n'd sentence shell (see
   *  officeTheme.switchAborted's `{{error}}`). */
  message: string;
}

export type BundleValidation =
  | { ok: true; manifest: ThemeBundleManifest }
  | { ok: false; errors: BundleValidationError[] };

function err(code: string, message: string): BundleValidationError {
  return { code, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isTile(v: unknown): v is Tile {
  return isRecord(v) && typeof v.x === 'number' && typeof v.y === 'number';
}

const FACINGS: Facing[] = ['up', 'down', 'left', 'right'];
const ERRAND_KINDS: ErrandKind[] = ['water', 'window', 'dispenser', 'fridge', 'shelf', 'bin', 'smoke'];
const STAND_KINDS = ['coffee', 'vending'];

/** Hex color string ("#1a1320" or "1a1320") → 0xRRGGBB number, or null. */
export function parseHexColor(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim());
  if (!m) return null;
  return parseInt(m[1], 16);
}

/**
 * Structural validation of theme.json's parsed content — required keys
 * present and correctly shaped. Does NOT touch the map (see
 * validateBundleAgainstMap below); this is the cheap, map-independent pass.
 * Collects every problem found rather than stopping at the first, so an
 * author fixing a bundle sees the whole list at once.
 */
export function validateManifestShape(raw: unknown): BundleValidation {
  const errors: BundleValidationError[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [err('invalidJson', 'theme.json must contain a JSON object.')] };
  }

  if (raw.schemaVersion !== 1) {
    errors.push(err('schemaVersion', `theme.json "schemaVersion" must be 1 (got ${JSON.stringify(raw.schemaVersion)}).`));
  }
  if (typeof raw.label !== 'string' || !raw.label.trim()) {
    errors.push(err('label', 'theme.json is missing a non-empty "label" (the display name shown in the theme picker).'));
  }
  const hasMapFile = typeof raw.mapFile === 'string' && raw.mapFile.trim().length > 0;
  const hasMapRaw = typeof raw.mapRaw === 'string' && raw.mapRaw.trim().length > 0;
  if (!hasMapFile && !hasMapRaw) {
    errors.push(err('map', 'theme.json must set either "mapFile" (path to a .tmj) or "mapRaw" (the Tiled JSON inlined as a string).'));
  }

  if (!Array.isArray(raw.tilesets) || raw.tilesets.length === 0) {
    errors.push(err('tilesets', 'theme.json "tilesets" must be a non-empty array.'));
  } else {
    raw.tilesets.forEach((t, i) => {
      if (!isRecord(t) || typeof t.file !== 'string' || !t.file.trim()) {
        errors.push(err('tilesetFile', `tilesets[${i}] is missing a "file" (the tileset PNG's path, relative to the bundle folder).`));
        return;
      }
      if (t.embedded === true) return; // embedded atlases borrow the map's own metadata — nothing else required
      const numFields: (keyof ThemeBundleTilesetEntry)[] = ['firstgid', 'imagewidth', 'imageheight', 'tilewidth', 'tileheight', 'columns', 'tilecount'];
      for (const f of numFields) {
        if (typeof (t as Record<string, unknown>)[f] !== 'number' || !Number.isFinite((t as Record<string, unknown>)[f] as number) || ((t as Record<string, unknown>)[f] as number) <= 0) {
          errors.push(err('tilesetField', `tilesets[${i}] ("${t.file}") is missing a positive numeric "${f}".`));
        }
      }
    });
  }

  const nameArrayFields: (keyof ThemeBundleManifest)[] = ['primarySeatNames', 'cafeSeatNames'];
  for (const f of nameArrayFields) {
    const v = raw[f as string];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim())) {
      errors.push(err('seatNames', `theme.json "${f}" must be an array of non-empty seat-name strings.`));
    }
  }

  if (!Array.isArray(raw.cafeStands) || !raw.cafeStands.every((s) => Array.isArray(s) && s.length === 2 && typeof s[0] === 'string' && STAND_KINDS.includes(s[1]))) {
    errors.push(err('cafeStands', 'theme.json "cafeStands" must be an array of [spawnPointName, "coffee" | "vending"] pairs.'));
  }

  if (!isRecord(raw.coffee) || !isTile(raw.coffee.trayTile) || !isTile(raw.coffee.trayStand) || !isTile(raw.coffee.machineStand) || !isTile(raw.coffee.sinkTile) || !isTile(raw.coffee.sinkStand) || typeof raw.coffee.maxCups !== 'number') {
    errors.push(err('coffee', 'theme.json "coffee" must set trayTile, trayStand, machineStand, sinkTile, sinkStand (each {x,y}) and a numeric maxCups.'));
  }

  if (!isRecord(raw.anchors) || !isTile(raw.anchors.calendar) || !isTile(raw.anchors.boards) || !isTile(raw.anchors.clock)) {
    errors.push(err('anchors', 'theme.json "anchors" must set calendar, boards and clock (each {x,y}).'));
  } else if (!isTile(raw.anchors.worldClock)) {
    // worldClock predates this validator; default older/unaware bundles to the
    // same spot as `clock` so they never ship with anchors.worldClock undefined.
    (raw.anchors as Record<string, unknown>).worldClock = raw.anchors.clock;
  }

  if (!Array.isArray(raw.errandSpots)) {
    errors.push(err('errandSpots', 'theme.json "errandSpots" must be an array.'));
  } else {
    raw.errandSpots.forEach((e, i) => {
      if (!isRecord(e) || !ERRAND_KINDS.includes(e.kind as ErrandKind) || !isTile(e.stand) || !FACINGS.includes(e.facing as Facing) || !isTile(e.fx) || typeof e.duration !== 'number') {
        errors.push(err('errandSpot', `errandSpots[${i}] must set a valid "kind" (${ERRAND_KINDS.join('|')}), "stand"/"fx" ({x,y}), a "facing" (${FACINGS.join('|')}) and a numeric "duration".`));
      }
    });
  }

  if (!isRecord(raw.monitor) || typeof raw.monitor.offTopLeftGid !== 'number' || !Array.isArray(raw.monitor.onGids) || !raw.monitor.onGids.every((g) => Array.isArray(g) && g.length === 3 && g.every((n) => typeof n === 'number'))) {
    errors.push(err('monitor', 'theme.json "monitor" must set a numeric "offTopLeftGid" and "onGids" as an array of [gid, dx, dy] triples.'));
  }

  if (!isRecord(raw.palette) || parseHexColor(raw.palette.background) === null || !isRecord(raw.palette.noteColors)) {
    errors.push(err('palette', 'theme.json "palette" must set a "background" hex color and a "noteColors" map of hex colors.'));
  } else {
    for (const [k, v] of Object.entries(raw.palette.noteColors as Record<string, unknown>)) {
      if (parseHexColor(v) === null) errors.push(err('paletteColor', `theme.json "palette.noteColors.${k}" is not a valid hex color (got ${JSON.stringify(v)}).`));
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: raw as unknown as ThemeBundleManifest };
}

function isTiledMapShape(v: unknown): v is TiledMap {
  return isRecord(v)
    && typeof v.width === 'number' && v.width > 0
    && typeof v.height === 'number' && v.height > 0
    && typeof v.tilewidth === 'number' && v.tilewidth > 0
    && typeof v.tileheight === 'number' && v.tileheight > 0
    && Array.isArray(v.layers)
    && Array.isArray(v.tilesets);
}

/**
 * Cross-checks a manifest that already passed `validateManifestShape` against
 * the actual Tiled map: named spawn points must exist, coffee/anchor/errand
 * tiles must be walkable, and declared tileset metadata must not produce an
 * obviously out-of-range gid. `mapRawText` is the .tmj's raw text (already
 * read off disk by the caller — this function does no I/O, so it runs
 * identically whether the map came from a file or an inline `mapRaw`).
 */
export function validateBundleAgainstMap(manifest: ThemeBundleManifest, mapRawText: string): BundleValidationError[] {
  const errors: BundleValidationError[] = [];

  let map: unknown;
  try {
    map = JSON.parse(mapRawText);
  } catch (e) {
    return [err('mapJson', `The map file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)];
  }
  if (!isTiledMapShape(map)) {
    return [err('mapShape', 'The map file does not look like Tiled JSON (missing width/height/tilewidth/tileheight/layers/tilesets).')];
  }
  const tiledMap = map;

  // ─── spawn points ──────────────────────────────────────────────────────
  const spawnPoints = parseSpawnPoints(tiledMap);
  const checkSeat = (name: string, field: string) => {
    if (!spawnPoints.has(name)) {
      errors.push(err('seatMissing', `Seat '${name}' (from "${field}") does not exist as a spawn point in the map.`));
    }
  };
  for (const name of manifest.primarySeatNames ?? []) checkSeat(name, 'primarySeatNames');
  for (const name of manifest.cafeSeatNames ?? []) checkSeat(name, 'cafeSeatNames');
  for (const [name] of manifest.cafeStands ?? []) checkSeat(name, 'cafeStands');

  // ─── walkability of fixed anchors ─────────────────────────────────────
  const walkable = buildWalkable(tiledMap);
  const checkWalkable = (label: string, t: Tile | undefined) => {
    if (!t) return;
    if (t.x < 0 || t.y < 0 || t.x >= tiledMap.width || t.y >= tiledMap.height) {
      errors.push(err('tileOutOfBounds', `${label} tile (${t.x}, ${t.y}) is outside the map (${tiledMap.width}x${tiledMap.height}).`));
      return;
    }
    if (!walkable.isWalkable(t.x, t.y)) {
      errors.push(err('tileNotWalkable', `${label} tile (${t.x}, ${t.y}) is not walkable — it is blocked in the map's collision layer.`));
    }
  };
  if (manifest.coffee) {
    checkWalkable('coffee.trayStand', manifest.coffee.trayStand);
    checkWalkable('coffee.machineStand', manifest.coffee.machineStand);
    checkWalkable('coffee.sinkStand', manifest.coffee.sinkStand);
  }
  (manifest.errandSpots ?? []).forEach((e, i) => checkWalkable(`errandSpots[${i}].stand`, e.stand));

  // ─── tileset gid coherence (structural, not per-tile) ─────────────────
  // The map's own embedded tileset[0] anchors the gid space; each declared
  // NON-embedded tileset must not overlap the gid range of the one before it,
  // and its columns/tilecount must actually fit inside its declared image
  // size — the two classes of "obvious out-of-range index" bug named in the
  // brief (an overlapping firstgid, or a tile grid that overruns its atlas).
  let expectedMinFirstgid = 1;
  const mapTilesets = tiledMap.tilesets;
  if (mapTilesets.length > 0 && typeof mapTilesets[0].firstgid === 'number') {
    expectedMinFirstgid = mapTilesets[0].firstgid;
    if (typeof mapTilesets[0].tilecount === 'number') {
      expectedMinFirstgid += mapTilesets[0].tilecount as number;
    }
  }
  (manifest.tilesets ?? []).forEach((t, i) => {
    if (t.embedded) return; // trusts the map's own inline metadata, already accounted for above
    const firstgid = t.firstgid ?? 0;
    if (firstgid < expectedMinFirstgid) {
      errors.push(err('tilesetGidOverlap', `tilesets[${i}] ("${t.file}") firstgid ${firstgid} overlaps the previous tileset's gid range (expected >= ${expectedMinFirstgid}).`));
    }
    const cols = t.columns ?? 0;
    const tilecount = t.tilecount ?? 0;
    const tw = t.tilewidth ?? 0;
    const th = t.tileheight ?? 0;
    const iw = t.imagewidth ?? 0;
    const ih = t.imageheight ?? 0;
    if (cols > 0 && tw > 0 && cols * tw !== iw) {
      errors.push(err('tilesetGeometry', `tilesets[${i}] ("${t.file}") columns (${cols}) x tilewidth (${tw}) = ${cols * tw}, but imagewidth is ${iw}.`));
    }
    if (cols > 0 && tilecount > 0 && th > 0) {
      const rows = Math.ceil(tilecount / cols);
      if (rows * th !== ih) {
        errors.push(err('tilesetGeometry', `tilesets[${i}] ("${t.file}") needs ${rows} row(s) of tileheight ${th} (= ${rows * th}px) to fit ${tilecount} tiles at ${cols} columns, but imageheight is ${ih}.`));
      }
    }
    expectedMinFirstgid = firstgid + tilecount;
  });

  // `expectedMinFirstgid` is now the exclusive upper bound of every declared
  // gid range (map-embedded tileset + every bundle tileset). The monitor
  // overlay gids reference painted tiles directly rather than {x,y} tile
  // coords, so this is the equivalent "obviously out of range" check for them.
  const maxGidExclusive = expectedMinFirstgid;
  if (manifest.monitor) {
    const checkGid = (label: string, gid: number) => {
      if (gid < 1 || gid >= maxGidExclusive) {
        errors.push(err('monitorGidOutOfRange', `monitor.${label} gid ${gid} is outside the declared tilesets' gid range (1..${maxGidExclusive - 1}).`));
      }
    };
    checkGid('offTopLeftGid', manifest.monitor.offTopLeftGid);
    (manifest.monitor.onGids ?? []).forEach(([gid], i) => checkGid(`onGids[${i}]`, gid));
  }

  return errors;
}

/** Runs both validation passes and returns one combined result — the entry
 *  point callers (themeLoader.ts, the import UI, tests) should use. `mapRawText`
 *  is optional because the shape pass can fail before a map is ever read; pass
 *  it once the manifest's shape is known-good and the map text has been
 *  resolved (from `mapFile` or `mapRaw`). */
export function validateThemeBundle(rawManifest: unknown, mapRawText?: string): BundleValidation {
  const shapeResult = validateManifestShape(rawManifest);
  if (!shapeResult.ok) return shapeResult;
  if (mapRawText === undefined) return shapeResult;
  const mapErrors = validateBundleAgainstMap(shapeResult.manifest, mapRawText);
  if (mapErrors.length > 0) return { ok: false, errors: mapErrors };
  return shapeResult;
}
