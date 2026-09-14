// Theme registry — the pluggable "office theme" contract.
//
// Phase 0 of the TV-show-offices feature (card tvshow-phase0-abstraction):
// extract the ~40% of constants that were hard-coded inside OfficeFloor.tsx
// (errand spots, coffee-economy tile coords, prop anchors, seat names, tileset
// URLs, palette, monitor gids) into a ThemeConfig so the scene becomes
// swappable per show. This phase ships the EXISTING office unchanged as
// `theme: 'office'`: every value below is copied byte-for-byte from the old
// in-file literals, so the office renders and behaves identically.
//
// The engine (TiledMapRenderer / BFS pathfinding / Camera / sprite animation)
// is already fully generic and needs no change. cast.ts is read-only here
// (uncommitted human WIP) — the office theme references its existing exports.

import type { Texture } from 'pixi.js';
import type { StationKind } from '@shared/toolStation';
import { TECH_ATLAS_META, TECH_PALETTE_KEY } from './techOfficeArt';
import { OFFICE_BINDINGS } from './officeLayout';
import { colors } from '@/design/tokens';
import {
  CAST_BY_NAME,
  getCastFrames,
  DEFAULT_CHARACTER,
  type CastMember,
} from './cast';

import officeTilesetUrl from '@/assets/tilesets/office-tileset.png?url';
import a5FloorsWallsUrl from '@/assets/tilesets/a5-office-floors-walls.png?url';
import interiorsUrl from '@/assets/tilesets/interiors.png?url';
// .tmj is Tiled JSON; imported as raw text and parsed by the loader.
import officeMapRaw from '@/assets/maps/office.tmj?raw';
import brooklyn99MapRaw from '@/assets/maps/brooklyn99.tmj?raw';
import siliconvalleyMapRaw from '@/assets/maps/siliconvalley.tmj?raw';
import friendsMapRaw from '@/assets/maps/friends.tmj?raw';
import isometricMapRaw from '@/assets/maps/isometric.tmj?raw';

/** Theme identifiers. Only `office` exists in Phase 0; the five TV-show themes
 *  (friends, brooklyn99, siliconvalley, got, hogwarts) land in later phases.
 *  `custom:<uuid>` (Phase 4) identifies a user-imported theme bundle — see
 *  customThemes.ts for the id→bundle-path registry and themeLoader.ts's
 *  `loadTheme` for how such an id resolves to a renderable ThemeConfig. The
 *  template-literal branch keeps the built-in ids exhaustively checkable while
 *  still admitting any custom id at the type level. */
export type ThemeId =
  | 'office'
  | 'friends'
  | 'brooklyn99'
  | 'siliconvalley'
  | 'got'
  | 'hogwarts'
  | 'isometric'
  | `custom:${string}`;

export interface Tile { x: number; y: number; }
export type Facing = 'up' | 'down' | 'left' | 'right';

/** An authored place to represent ongoing tool activity. The source determines
 * when work ends; a station has no animation duration or operational role. */
export interface StationSpot {
  kind: Exclude<StationKind, 'desk'>;
  stand: Tile;
  facing: Facing;
}

/** Kinds of small idle errands around the office (incl. plant watering).
 *  'smoke' is the boss special: cigar at the open window, god only. */
export type ErrandKind =
  | 'water' | 'window' | 'dispenser' | 'fridge' | 'shelf' | 'bin' | 'smoke';

/** One idle-errand anchor: a stand tile + facing, an `fx` tile for the ambient
 *  animation, a duration, and an optional god-only restriction. */
export interface ErrandSpot {
  kind: ErrandKind;
  stand: Tile;
  facing: Facing;
  fx: Tile;
  duration: number;
  godOnly?: boolean;
}

/** One tileset atlas + its placement in the global gid space. `embedded` marks
 *  the atlas whose metadata already lives inline in the map's own `tilesets[0]`
 *  (the loader keeps the map's copy and only patches the appended atlases). */
export interface TilesetEntry {
  /** Where the atlas image comes from. Empty for a generated RGBA atlas. */
  url: string;
  /** Generate from isoTileArt or techOfficeArt instead of decoding `url`.
   * Both return deterministic RGBA buffers derived from tilePaletteKey. */
  procedural?: { kind: 'iso' | 'tech-office' };
  embedded?: boolean;
  firstgid?: number;
  image?: string;
  imagewidth?: number;
  imageheight?: number;
  tilewidth?: number;
  tileheight?: number;
  columns?: number;
  tilecount?: number;
  /** Phase 10 (tvshow-phase10-procedural-floor-walls): gid cells in this
   *  atlas image to repaint procedurally (tileArt.ts's drawFloorTile/
   *  drawWallTile) before the loaded image becomes a Pixi texture — see
   *  OfficeFloor.tsx's loadTilesetTexture. Absent/empty means the atlas
   *  passes through byte-identical to the source PNG, which is every atlas
   *  today except OFFICE_TILESETS' own copy of the a5 floors/walls atlas
   *  (see below) — this phase is office-only by design. */
  patches?: TilesetPatchGroup[];
  /** Palette key into tileArt.ts's TILE_PALETTES, used by `patches` above.
   *  Defaults to 'office' when patches are present but this is omitted. */
  tilePaletteKey?: string;
}

/** Re-declared here (not imported) so themeRegistry.ts — pure theme data,
 *  no rendering — never needs to import tileArt.ts's drawing code, only its
 *  gid-group shape. Structurally identical to tileArt.ts's own
 *  TilesetPatchGroup. */
export interface TilesetPatchGroup {
  kind: 'floor' | 'wall';
  gids: number[];
}

/** Desk-monitor overlay gids. The map paints an OFF monitor block; DeskScreen
 *  overlays the matching ON tiles while the desk's agent is seated. */
export interface MonitorConfig {
  /** gid of the OFF monitor block's top-left tile, as painted in the map. */
  offTopLeftGid: number;
  /** Matching ON tiles as [gid, dx, dy] relative to the block's top-left. */
  onGids: ReadonlyArray<readonly [number, number, number]>;
}

/** The coffee economy's fixed tiles: sideboard (mug rack) → counter machine →
 *  sink → back to the sideboard. `maxCups` caps the clean-mug stock. */
export interface CoffeeConfig {
  trayTile: Tile;
  trayStand: Tile;
  machineStand: Tile;
  sinkTile: Tile;
  sinkStand: Tile;
  maxCups: number;
}

/** Clickable prop anchors (tile coords). calendar → TRIGGERS, boards → TASKS,
 *  clock → CLOSING TIME, askBoard → ASK ME. worldClock and coffeeSteam are
 *  non-interactive decorations — the world clock (China + Mexico City live
 *  time) goes on a free stretch of the theme's own top wall, clear of the
 *  other anchors above; coffeeSteam is the counter machine's TOP tile, which
 *  the brewing steam puffs out of.
 *
 *  Every field here is a TILE the theme owns. askBoard and coffeeSteam were
 *  literal `tileToWorld(14, 10)` / `tileToWorld(26, 17)` calls inside
 *  OfficeFloor.tsx until they moved here — office.tmj coordinates baked into
 *  the renderer, which put both props in absurd places on any other floor
 *  plan. They are anchors for the same reason `boards` is one. */
export interface AnchorConfig {
  calendar: Tile;
  boards: Tile;
  clock: Tile;
  worldClock: Tile;
  /** The ASK ME board's wall tile. Drawn like `boards`: the prop's depth is
   *  `rowDepth(askBoard.y + 1)`, so it must be a wall the floor runs UNDER. */
  askBoard: Tile;
  /** The coffee machine's top tile (the counter piece the steam rises from),
   *  NOT the tile a character stands on — that is `coffee.machineStand`. In
   *  every shipped theme's café stamp this sits 3 rows above machineStand,
   *  which is also the fallback themeBundle.ts derives for older bundles. */
  coffeeSteam: Tile;
  /** The three floor tiles the board choreography walks an actor to: pin a
   *  fresh card on the blockers board, take one off the todo board, file a
   *  finished one on the archive table. These were literals in
   *  OfficeFloor.tsx too, and unlike the anchors above they are WALK
   *  DESTINATIONS — each one must be a walkable tile standing in front of the
   *  `boards` prop, or the actor never arrives and the card never moves.
   *  office.tmj's are boards + (2,1) / (3,1) / (6,1). */
  boardPinStand: Tile;
  boardTakeStand: Tile;
  boardArchiveStand: Tile;
  /** OPTIONAL — the panoramic wall display's TOP-LEFT tile, if the theme has
   *  one. The only prop on this floor that is an INSTRUMENT: OfficeFloor
   *  composites a live readout (breaker pips / CI chips / closures-per-hour)
   *  over the baked glass at techOfficeArt's OPS_READOUT_RECT.
   *
   *  Undefined on every theme but `office`, and that is not an omission to be
   *  filled in later: the display is a procedural tech-office prop, and the
   *  other themes' maps have no wall it could hang on. No anchor, no readout —
   *  not a readout drawn over a wall that is not a screen. */
  opsScreen?: Tile;
  /** OPTIONAL — the PLAN / BUILD / SHIP whiteboard's TOP-LEFT tile. Same
   *  reasoning as `opsScreen`; the live note field is PLAN_READOUT_RECT. */
  planBoard?: Tile;
}

/** Theme palette. `background` is the canvas clear color; `noteColors` are the
 *  kanban note colors keyed by task status. */
export interface PaletteConfig {
  background: number;
  noteColors: Record<string, number>;
}

/** Per-theme cast loader — the indirection point so a future show can swap its
 *  own roster + sprite frames. The office theme points at cast.ts's exports. */
export interface ThemeCast {
  byName: Record<string, CastMember>;
  getFrames: (name: string) => Promise<Texture[][]>;
  defaultCharacter: string;
}

/**
 * Parts of the floor a theme can switch OFF.
 *
 * This exists because of the isometric prototype and should be read as an
 * honesty mechanism, not as a general customisation surface. Several of the
 * floor's systems have orthogonal geometry baked into them at a level no
 * projection abstraction reaches — the coffee fixtures are hand-drawn pixel art
 * positioned against a 16x16 square cell, the wall props hang off a
 * `rowDepth(3)` that means nothing on a diamond grid, the café seat pairing
 * looks for two seats "in the same column, two tiles apart". Rather than let
 * those render wrong on a grid they were never drawn for, a theme states
 * plainly which ones it is not carrying.
 *
 * EVERY FIELD DEFAULTS TO ON. Omitting the whole `features` object — which
 * every shipped theme does — is exactly the behaviour that existed before it,
 * and each consumer is written as `!== false` so that stays true even for a
 * partial object.
 */
export interface ThemeFeatures {
  /** The coffee economy's floor fixtures: the mug sideboard, the counter sink
   *  and the machine's steam. (The RUNS themselves already need a café seat to
   *  start from, so an empty `cafeSeatNames` stops them regardless.) */
  coffee?: boolean;
  /** Wall-hung interactive props: the calendar (TRIGGERS), the task boards, the
   *  alarm clock (CLOSING TIME), the ASK ME board and the world clock. */
  wallProps?: boolean;
  /** The rain/overcast sky driven by the circuit breaker. */
  weather?: boolean;
}

/** The full contract a theme must supply. See report §A (theme contract). */
export interface ThemeConfig {
  id: ThemeId;
  /** Raw Tiled JSON text; parsed + tileset-patched by themeLoader. */
  mapRaw: string;
  /** Ordered atlases — order matches both the texture load order and the map's
   *  tileset array (texture[i] ↔ tilesets[i]). */
  tilesets: TilesetEntry[];
  /** Desk-claim order, by spawn-point name (seat 0 = god / desk-ceo). */
  primarySeatNames: string[];
  /** Paired café table seats, in order. */
  cafeSeatNames: string[];
  /** Café standing spots: [spawn-point name, kind]. */
  cafeStands: ReadonlyArray<readonly [string, 'coffee' | 'vending']>;
  coffee: CoffeeConfig;
  anchors: AnchorConfig;
  errandSpots: ErrandSpot[];
  /** Optional destinations belonging to this map. Absent kinds stay at the
   * agent's own desk; never inherit another theme's station coordinates. */
  stationSpots?: StationSpot[];
  monitor: MonitorConfig;
  palette: PaletteConfig;
  cast: ThemeCast;
  /** Absent on every shipped theme = everything on. See ThemeFeatures. */
  features?: ThemeFeatures;
}

// The three atlases every built-in theme's map draws from, unpatched — byte-
// identical to how every theme loaded them before Phase 10. brooklyn99/
// siliconvalley/friends/got/hogwarts all reuse THIS array (not
// OFFICE_THEME.tilesets) so patching the office theme's own copy below can
// never leak into them, even though their placeholder maps happen to paint
// the exact same gids from the exact same PNGs today.
const BASE_TILESETS: TilesetEntry[] = [
  // office-tileset.png — embedded in the map (firstgid 1); keep the map's copy.
  { url: officeTilesetUrl, embedded: true },
  { url: a5FloorsWallsUrl, firstgid: 513, image: 'a5', imagewidth: 256, imageheight: 512, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 512 },
  { url: interiorsUrl, firstgid: 1025, image: 'interiors', imagewidth: 256, imageheight: 1424, tilewidth: 16, tileheight: 16, columns: 16, tilecount: 1424 },
];

/** Office-only atlas, generated from the same primitives as tileArt.ts.
 * The other themes continue to use their own atlases and palettes. */
const OFFICE_TILESETS: TilesetEntry[] = [{
  url: '', procedural: { kind: 'tech-office' }, tilePaletteKey: TECH_PALETTE_KEY,
  ...TECH_ATLAS_META,
}];

/** Curated operations floor. Layout bindings are shared with the generator. */
export const OFFICE_THEME: ThemeConfig = {
  id: 'office',
  mapRaw: officeMapRaw,
  tilesets: OFFICE_TILESETS,
  ...OFFICE_BINDINGS,
  monitor: {
    offTopLeftGid: 365,
    onGids: [
      [367, 0, 0], [368, 1, 0],
      [383, 0, 1], [384, 1, 1],
    ],
  },
  palette: {
    background: 0x161d24,
    noteColors: { todo: 0xf2df8a, doing: 0x9ecbf0, blocked: 0xf0a3a3, done: 0xa8e0b0 },
  },
  cast: {
    byName: CAST_BY_NAME as Record<string, CastMember>,
    // getCastFrames now takes a plain string (fixed name OR custom:<uuid>), so
    // this no longer needs a cast through OfficeCharacterName.
    getFrames: (name: string) => getCastFrames(name),
    defaultCharacter: DEFAULT_CHARACTER,
  },
};

/** Brooklyn Nine-Nine — the 99th precinct, with its OWN floor plan and its
 *  OWN a5-atlas floor/wall palette (tvshow-phase12a-brooklyn99-structure).
 *  brooklyn99.tmj is a real, bespoke 36x24 map (bigger than office's 34x22):
 *  a three-room top strip — a briefing room with a conference table
 *  (`boardroom` zone, x1-16), a small interrogation/"holding" room with a
 *  one-way-glass window and a table+chairs (`holding` zone, x19-25), and
 *  Captain Holt's glass office (`desk-ceo`, x28-34) — separated from each
 *  other and from the bullpen below by the SAME a5 wall bricks office.tmj
 *  itself uses for its CEO-office/boardroom dividers (611/643 vertical
 *  partitions read as thin glass-partition mullions — a good accidental fit
 *  for "Holt's glass office"; a 522/554/570 horizontal band closes each
 *  room's south wall, with a doorway gap into the bullpen). The bullpen
 *  (`pc-1..8`) is 8 desks in partner-desk pairs (tight spacing within a
 *  pair, a wider aisle between pairs) across two staggered rows, distinct
 *  from office's single evenly-spaced grid — note the desk art itself is
 *  not mirrored (the engine's DeskScreen monitor overlay is a single global
 *  offTopLeftGid/onGids pair, not per-desk, so a true opposite-facing desk
 *  isn't safely supported; "facing pairs" here means paired proximity, not
 *  mirrored art). The break room (`cafeteria` zone, bottom-right) reuses
 *  office.tmj's own proven café/coffee-economy furniture stamp (counter,
 *  sideboard, cooler tower, all four café-seat chair-backs) translated
 *  wholesale to a new anchor, plus its own lockers/bulletin-board dressing.
 *  See tileArt.ts's TILE_PALETTES.brooklyn99 for the floor/wall recolor
 *  (cooler, more saturated steel/blue-green vs. office's warm oak/gray) and
 *  BROOKLYN99_TILESETS below for how it's wired to the shared a5 atlas. */
const BROOKLYN99_TILESETS: TilesetEntry[] = [
  BASE_TILESETS[0],
  {
    ...BASE_TILESETS[1],
    tilePaletteKey: 'brooklyn99',
    patches: [
      { kind: 'floor', gids: [783, 784, 799, 800] },
      { kind: 'wall', gids: [514, 517, 522, 530, 533, 554, 570, 578, 579, 581, 611, 643] },
    ],
  },
  BASE_TILESETS[2],
];

export const BROOKLYN99_THEME: ThemeConfig = {
  id: 'brooklyn99',
  mapRaw: brooklyn99MapRaw,
  tilesets: BROOKLYN99_TILESETS,
  primarySeatNames: [
    'desk-ceo',                                            // Captain Holt's glass office
    'pc-1', 'pc-2', 'pc-3', 'pc-4',                        // bullpen — front row (partner pairs)
    'pc-5', 'pc-6', 'pc-7', 'pc-8',                        // bullpen — back row (partner pairs)
  ],
  cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4'],
  cafeStands: [
    ['cafe-stand-coffee', 'coffee'],
    ['cafe-stand-vending', 'vending'],
  ],
  // The break room's counter run — office.tmj's own café stamp, translated to
  // this map's anchor (31,17) with the SAME relative offsets office.tmj uses
  // between trayTile and every other coffee-economy coordinate.
  coffee: {
    trayTile: { x: 31, y: 17 },
    trayStand: { x: 31, y: 18 },
    machineStand: { x: 28, y: 22 },
    sinkTile: { x: 30, y: 20 },
    sinkStand: { x: 30, y: 22 },
    maxCups: 4,
  },
  anchors: {
    calendar: { x: 4, y: 1 },    // briefing-room top wall → TRIGGERS
    boards: { x: 21, y: 1 },     // over the interrogation/"holding" room → TASKS
    clock: { x: 1, y: 1 },       // top-left corner → CLOSING TIME
    worldClock: { x: 12, y: 1 }, // briefing-room top wall, clear of the window (x=6)
    // CARRIED OVER VERBATIM, not authored for this map. Both props were
    // hardcoded to office.tmj's coordinates in OfficeFloor.tsx, so these are
    // what this theme has been rendering all along and keeping them is what
    // makes extracting the anchors a zero-pixel change. (14,10) does land on
    // this map's own briefing-room south wall (gid 522), so the ASK ME board
    // reads fine; (26,17) is bare floor — the steam has always puffed 2 tiles
    // short of the break-room machine, which sits at (28,19) here (gid 313,
    // = machineStand (28,22) − 3 rows, the same café-stamp offset office uses).
    // Correcting it is a deliberate visual change, not part of this migration.
    askBoard: { x: 14, y: 10 },
    coffeeSteam: { x: 26, y: 17 },
    // ALSO CARRIED OVER VERBATIM, and these ones are already visibly broken:
    // (12,11) is BLOCKED in this map's collision layer, so "file it as done"
    // has never been able to reach the archive table here. Fixing it means
    // picking walkable tiles in front of THIS map's boards anchor (21,1) —
    // again a deliberate change, made where the result can be looked at.
    boardPinStand: { x: 8, y: 11 },
    boardTakeStand: { x: 9, y: 11 },
    boardArchiveStand: { x: 12, y: 11 },
  },
  // Errand anchors authored to brooklyn99.tmj's own floor plan (verified
  // walkable against the map's collision layer + desk/furniture footprints
  // via a standalone BFS reachability + collision self-check — see task
  // notes). Plant/bin props are painted at each errand's `fx` tile, matching
  // office.tmj's own convention (the character-facing `stand` tile stays
  // bare floor).
  errandSpots: [
    // public plants around the bullpen
    { kind: 'water', stand: { x: 2, y: 15 }, facing: 'left', fx: { x: 1, y: 15 }, duration: 4.5 },
    { kind: 'water', stand: { x: 24, y: 16 }, facing: 'right', fx: { x: 25, y: 16 }, duration: 4.5 },
    { kind: 'water', stand: { x: 13, y: 21 }, facing: 'down', fx: { x: 13, y: 22 }, duration: 4.5 },
    // Captain Holt's glass office — god's domain (plant + cigar at the window)
    { kind: 'water', stand: { x: 33, y: 4 }, facing: 'up', fx: { x: 33, y: 3 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 29, y: 4 }, facing: 'up', fx: { x: 29, y: 1 }, duration: 18, godOnly: true },
    // windows on the north wall (briefing room + interrogation/"holding" room)
    { kind: 'window', stand: { x: 6, y: 3 }, facing: 'up', fx: { x: 6, y: 1 }, duration: 5 },
    { kind: 'window', stand: { x: 22, y: 3 }, facing: 'up', fx: { x: 22, y: 1 }, duration: 5 },
    // water dispensers (bullpen aisle + entrance corridor)
    { kind: 'dispenser', stand: { x: 12, y: 21 }, facing: 'down', fx: { x: 12, y: 22 }, duration: 3.5 },
    { kind: 'dispenser', stand: { x: 20, y: 21 }, facing: 'down', fx: { x: 20, y: 22 }, duration: 3.5 },
    // break-room fridge + entrance/break-room bins
    { kind: 'fridge', stand: { x: 27, y: 20 }, facing: 'up', fx: { x: 27, y: 19 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 34, y: 8 }, facing: 'down', fx: { x: 34, y: 9 }, duration: 4 },
    { kind: 'bin', stand: { x: 16, y: 21 }, facing: 'left', fx: { x: 15, y: 21 }, duration: 2.6 },
    { kind: 'bin', stand: { x: 28, y: 18 }, facing: 'left', fx: { x: 27, y: 18 }, duration: 2.6 },
  ],
  // brooklyn99.tmj's desks paint the same office desk stamp (monitor gid 365
  // OFF / 367-368/383-384 ON) as every other theme.
  monitor: OFFICE_THEME.monitor,
  // brooklyn99's own palette: cool institutional blue/teal, echoing
  // tileArt.ts's TILE_PALETTES.brooklyn99 floor/wall recolor, distinct from
  // office's warm ink.
  palette: {
    background: 0x141c1e,
    noteColors: { todo: 0xe0c96a, doing: 0x6fa8b8, blocked: 0xd9705a, done: 0x7aa88a },
  },
  // Custom themes/TV-show themes always use the built-in roster (see
  // docs/theme-authoring.md) — no new likeness set for this pass.
  cast: OFFICE_THEME.cast,
};

/** Silicon Valley — the hacker-hostel incubator (tvshow-phase12c-
 *  siliconvalley-structure), with its OWN floor plan and its OWN a5-atlas
 *  floor/wall palette (mirroring BROOKLYN99_TILESETS/BROOKLYN99_THEME's
 *  shape exactly). siliconvalley.tmj is a real, bespoke 38x24 map (bigger
 *  than office's 34x22, matching brooklyn99's 36x24 ballpark): a top strip
 *  holds two glass-partitioned rooms — a "war room" pitch room with a full
 *  8-chair boardroom table (`warroom` zone, x1-16) and a server/equipment
 *  corner with two tall equipment lockers (`servercorner` zone, x19-36) —
 *  separated from each other by a solid glass mullion divider (x17-18) and
 *  from the open bullpen below by a horizontal a5 wall band with two
 *  doorway gaps (x7-8 into the war room, x24-25 into the server corner) —
 *  the exact same divider-band technique brooklyn99.tmj's own briefing/
 *  holding rooms use. The bullpen (`pc-1..8` + `desk-ceo`) is an open-plan
 *  "shared table": 9 desks (the founder sits IN the row, not in a corner
 *  office — the whole point of a hacker hostel) spaced 3 tiles apart so
 *  neighboring desk-tops touch, reading as one long table. The open-plan
 *  choice is deliberate (Silicon Valley's actual set is an open incubator
 *  house) but never an excuse for emptiness: a bottom-left lounge corner
 *  (`lounge` zone) is densely furnished with a 3-wide sofa, a bookshelf, two
 *  poufs and a rug (all real interiors.png tiles, hand-verified by decoding
 *  and cropping the PNG before use — see task notes), and a bottom-right
 *  kitchen/coffee-economy nook (`kitchen` zone, walled with its own glass
 *  mullion) reuses office.tmj's own proven café stamp (counter, sideboard,
 *  fridge, stocked shelf, 2-chair table + its own floor rug) translated
 *  wholesale to a new anchor — exactly brooklyn99's own break-room
 *  technique. The two equipment lockers in the server corner are an honest
 *  reuse of a tall storage-cabinet sprite as equipment/server stand-in — no
 *  literal server-rack tile exists in any loaded atlas (documented rather
 *  than guessed at, same spirit as the existing "no foosball table" gap
 *  note). See tileArt.ts's TILE_PALETTES.siliconvalley for the floor/wall
 *  recolor (neutral exposed-concrete gray + burnt-orange accent line,
 *  distinct in hue from both office's warm oak and brooklyn99's cool teal)
 *  and SILICONVALLEY_TILESETS below for how it's wired to the shared a5
 *  atlas. */
const SILICONVALLEY_TILESETS: TilesetEntry[] = [
  BASE_TILESETS[0],
  {
    ...BASE_TILESETS[1],
    tilePaletteKey: 'siliconvalley',
    patches: [
      { kind: 'floor', gids: [783, 784, 799, 800] },
      { kind: 'wall', gids: [514, 517, 522, 530, 533, 554, 570, 578, 579, 581, 611, 643] },
    ],
  },
  BASE_TILESETS[2],
];

export const SILICONVALLEY_THEME: ThemeConfig = {
  id: 'siliconvalley',
  mapRaw: siliconvalleyMapRaw,
  tilesets: SILICONVALLEY_TILESETS,
  primarySeatNames: [
    'desk-ceo',                             // the founder — a desk in the open bullpen, not a corner office
    'pc-1', 'pc-2', 'pc-3', 'pc-4',         // shared table, row 1
    'pc-5', 'pc-6', 'pc-7', 'pc-8',         // shared table, row 2
  ],
  cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4'],
  cafeStands: [
    ['cafe-stand-coffee', 'coffee'],
    ['cafe-stand-vending', 'vending'],
  ],
  // The kitchen nook's counter run — office.tmj's own café stamp, translated
  // to this map's anchor (33,17) with the SAME relative offsets office.tmj
  // uses between trayTile and every other coffee-economy coordinate.
  coffee: {
    trayTile: { x: 33, y: 17 },
    trayStand: { x: 33, y: 18 },
    machineStand: { x: 30, y: 22 },
    sinkTile: { x: 32, y: 20 },
    sinkStand: { x: 32, y: 22 },
    maxCups: 4,
  },
  anchors: {
    calendar: { x: 4, y: 1 },   // top wall, over the war room → TRIGGERS
    boards: { x: 28, y: 1 },    // top wall, over the server/equipment corner → TASKS
    clock: { x: 1, y: 1 },      // top-left corner → CLOSING TIME
    worldClock: { x: 14, y: 1 }, // war-room top wall, clear of the window (x=5)
    // CARRIED OVER VERBATIM — see BROOKLYN99_THEME.anchors for the full note.
    // (14,10) is this map's warroom/servercorner south wall band (gid 522).
    // This map's own machine top is at (30,19) (gid 313, = machineStand
    // (30,22) − 3 rows); moving the steam there is a visual change, not this
    // migration's job.
    askBoard: { x: 14, y: 10 },
    coffeeSteam: { x: 26, y: 17 },
    // ALSO CARRIED OVER VERBATIM — see BROOKLYN99_THEME. Here (9,11) and
    // (12,11) are both BLOCKED in this map's collision layer.
    boardPinStand: { x: 8, y: 11 },
    boardTakeStand: { x: 9, y: 11 },
    boardArchiveStand: { x: 12, y: 11 },
  },
  // Errand anchors authored to siliconvalley.tmj's own floor plan (verified
  // walkable against the map's collision layer + desk/furniture footprints
  // via a standalone BFS reachability + collision self-check — see task
  // notes). Plant/bin props are painted at each errand's `fx` tile, matching
  // office.tmj's own convention (the character-facing `stand` tile stays
  // bare floor) — the two public-plant and both bin errands below deliberately
  // point at furniture already painted by the café stamp instead of adding
  // redundant art.
  errandSpots: [
    // the founder's own plant + cigar corner — god's domain, right by the
    // desk-ceo seat in the open bullpen (no walled corner office to hide it in)
    { kind: 'water', stand: { x: 11, y: 15 }, facing: 'right', fx: { x: 12, y: 15 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 13, y: 13 }, facing: 'up', fx: { x: 13, y: 12 }, duration: 18, godOnly: true },
    // more plants around the open floor ("más plantas" — a startup lobby cliché)
    { kind: 'water', stand: { x: 2, y: 20 }, facing: 'left', fx: { x: 1, y: 20 }, duration: 4.5 },
    { kind: 'water', stand: { x: 29, y: 15 }, facing: 'up', fx: { x: 29, y: 14 }, duration: 4.5 },
    // public windows, one in each of the two glass top rooms
    { kind: 'window', stand: { x: 5, y: 3 }, facing: 'up', fx: { x: 5, y: 1 }, duration: 5 },
    { kind: 'window', stand: { x: 24, y: 3 }, facing: 'up', fx: { x: 24, y: 1 }, duration: 5 },
    // the bullpen aisle water cooler, between the founder's desk and the shared tables
    { kind: 'dispenser', stand: { x: 12, y: 17 }, facing: 'right', fx: { x: 13, y: 17 }, duration: 3.5 },
    // kitchen nook: fridge + stocked shelf beside the coffee economy
    { kind: 'fridge', stand: { x: 35, y: 17 }, facing: 'up', fx: { x: 35, y: 16 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 33, y: 22 }, facing: 'up', fx: { x: 33, y: 21 }, duration: 4 },
    // garbage bins (entrance hallway + kitchen)
    { kind: 'bin', stand: { x: 17, y: 21 }, facing: 'down', fx: { x: 17, y: 22 }, duration: 2.6 },
    { kind: 'bin', stand: { x: 35, y: 18 }, facing: 'right', fx: { x: 36, y: 18 }, duration: 2.6 },
  ],
  // siliconvalley.tmj's desks paint the same office desk stamp (monitor gid
  // 365 OFF / 367-368/383-384 ON) as every other theme.
  monitor: OFFICE_THEME.monitor,
  // siliconvalley's own palette: neutral concrete gray + a burnt-orange
  // accent, echoing tileArt.ts's TILE_PALETTES.siliconvalley floor/wall
  // recolor, distinct from office's warm ink and brooklyn99's cool teal.
  palette: {
    background: 0x1c1a17,
    noteColors: { todo: 0xf2c96a, doing: 0xe0834a, blocked: 0xd9705a, done: 0x9fd6b0 },
  },
  // Custom themes/TV-show themes always use the built-in roster (see
  // docs/theme-authoring.md) — no new likeness set for this pass.
  cast: OFFICE_THEME.cast,
};

/** Friends — a converted-apartment floor plan with its OWN palette
 *  (tvshow-phase12d-friends-structure), mirroring SILICONVALLEY_TILESETS/
 *  SILICONVALLEY_THEME's shape exactly. friends.tmj is a real, bespoke 38x24
 *  map (matching siliconvalley's own footprint): a top strip holds THREE
 *  small "bedroom-turned-office" rooms rather than one bullpen — "Ross's
 *  room" (`desk-ceo` + `pc-1`/`pc-2`, x1-11 — the roommate who's "in charge"
 *  still shares his room with a couple of desks, not a solo corner office),
 *  "Monica & Rachel's room" (`pc-3`/`pc-4`/`pc-5`, x14-24), and "Joey &
 *  Chandler's room" (`pc-6`/`pc-7`/`pc-8`, x27-36) — three desks apiece,
 *  each separated from its
 *  neighbor by the same a5 glass-mullion divider (611 cap / 643 body)
 *  brooklyn99/siliconvalley's own room dividers use, and from the open floor
 *  below by a horizontal a5 wall band (522/554/570) with one 2-wide doorway
 *  gap per room — the exact divider-band technique siliconvalley's
 *  warroom/servercorner rooms use. Below the band is an open "great room":
 *  an UNWALLED living-room/"Central Perk" lounge corner (bottom-left) with a
 *  3x2 sofa + a wooden trunk coffee table + two round poufs nested on a
 *  hand-verified 3x4 ornate area rug, plus two scattered ottomans; a small
 *  furnished "hallway" zone (a wooden bookshelf, a cream dresser, a rug
 *  stripe) filling the middle so no area reads as bare per the redesign
 *  brief; and a WALLED kitchen/coffee-economy nook (bottom-right) that
 *  reuses office.tmj's own proven café stamp (counter, sideboard, fridge,
 *  stocked shelf, 2-chair table + its own floor rug) translated wholesale to
 *  a new anchor — exactly brooklyn99's/siliconvalley's own break-room/
 *  kitchen technique, doubling as the in-universe "Central Perk counter."
 *  The sofa/ottoman/pouf/rug-stripe stamps are verbatim reuses of
 *  siliconvalley.tmj's own hand-verified interiors.png gids; the trunk
 *  (coffee table, gid 1213), the 3x4 ornate rug (gids 1214/1215/1216 +
 *  1230/1231/1232 + 1246/1247/1248 + 1262/1263/1264), the 2x2 bookshelf
 *  (gids 1270/1271/1286/1287) and the 4x1 dresser (gids 1282/1283/1284/1285)
 *  are NEW hand-verified finds for this pass — confirmed via raw alpha/color
 *  dumps and high-zoom crops of interiors.png before use (see task notes),
 *  not guessed from a screenshot. See tileArt.ts's TILE_PALETTES.friends for
 *  the floor/wall recolor (a deep, saturated terracotta floor + a blush-
 *  cream wall with a burgundy/plum accent line, distinct in both hue and
 *  saturation from office's warm tan, brooklyn99's cool teal, and
 *  siliconvalley's neutral concrete) and FRIENDS_TILESETS below for how it's
 *  wired to the shared a5 atlas. */
const FRIENDS_TILESETS: TilesetEntry[] = [
  BASE_TILESETS[0],
  {
    ...BASE_TILESETS[1],
    tilePaletteKey: 'friends',
    patches: [
      { kind: 'floor', gids: [783, 784, 799, 800] },
      { kind: 'wall', gids: [514, 517, 522, 530, 533, 554, 570, 578, 579, 581, 611, 643] },
    ],
  },
  BASE_TILESETS[2],
];

export const FRIENDS_THEME: ThemeConfig = {
  id: 'friends',
  mapRaw: friendsMapRaw,
  tilesets: FRIENDS_TILESETS,
  primarySeatNames: [
    'desk-ceo',                             // Ross's room, alone — "in charge"
    'pc-1', 'pc-2',                         // Ross's room (2 more desks)
    'pc-3', 'pc-4', 'pc-5',                 // Monica & Rachel's room
    'pc-6', 'pc-7', 'pc-8',                 // Joey & Chandler's room
  ],
  cafeSeatNames: ['cafe-seat-1', 'cafe-seat-2', 'cafe-seat-3', 'cafe-seat-4'],
  cafeStands: [
    ['cafe-stand-coffee', 'coffee'],
    ['cafe-stand-vending', 'vending'],
  ],
  // The Central Perk counter run — office.tmj's own café stamp, translated
  // to this map's anchor (32,17) with the SAME relative offsets office.tmj/
  // siliconvalley.tmj use between trayTile and every other coffee-economy
  // coordinate.
  coffee: {
    trayTile: { x: 32, y: 17 },
    trayStand: { x: 32, y: 18 },
    machineStand: { x: 29, y: 22 },
    sinkTile: { x: 31, y: 20 },
    sinkStand: { x: 31, y: 22 },
    maxCups: 4,
  },
  anchors: {
    calendar: { x: 4, y: 1 },    // over Ross's room → TRIGGERS
    boards: { x: 13, y: 1 },     // over the Ross/Monica-and-Rachel divider → TASKS
    clock: { x: 1, y: 1 },       // top-left corner → CLOSING TIME
    worldClock: { x: 22, y: 1 }, // Monica & Rachel's room, clear of the window (x=19)
    // CARRIED OVER VERBATIM — see BROOKLYN99_THEME.anchors for the full note.
    // (14,10) is this map's bedroom south wall band (gid 522). This map's own
    // Central Perk machine top is at (29,19) (gid 313, = machineStand (29,22)
    // − 3 rows); moving the steam there is a visual change, not this
    // migration's job.
    askBoard: { x: 14, y: 10 },
    coffeeSteam: { x: 26, y: 17 },
    // ALSO CARRIED OVER VERBATIM — see BROOKLYN99_THEME. Here ALL THREE are
    // BLOCKED in this map's collision layer, so no board move has ever
    // choreographed on this floor.
    boardPinStand: { x: 8, y: 11 },
    boardTakeStand: { x: 9, y: 11 },
    boardArchiveStand: { x: 12, y: 11 },
  },
  // Errand anchors authored to friends.tmj's own floor plan (verified
  // walkable against the map's collision layer + desk/furniture footprints
  // via a standalone BFS reachability + collision self-check — see task
  // notes). Plant/bin props are painted at each errand's `fx` tile, matching
  // office.tmj's own convention (the character-facing `stand` tile stays
  // bare floor).
  errandSpots: [
    // the plant Ross can never quite keep alive + his cigar — god's domain,
    // right in Ross's own room
    { kind: 'water', stand: { x: 9, y: 4 }, facing: 'left', fx: { x: 8, y: 4 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 2, y: 4 }, facing: 'up', fx: { x: 2, y: 2 }, duration: 18, godOnly: true },
    // the rest of the apartment's plants (Monica & Rachel's / Joey &
    // Chandler's rooms)
    { kind: 'water', stand: { x: 15, y: 4 }, facing: 'right', fx: { x: 16, y: 4 }, duration: 4.5 },
    { kind: 'water', stand: { x: 28, y: 4 }, facing: 'left', fx: { x: 27, y: 4 }, duration: 4.5 },
    // the big apartment windows (one per non-Ross bedroom)
    { kind: 'window', stand: { x: 19, y: 3 }, facing: 'up', fx: { x: 19, y: 1 }, duration: 5 },
    { kind: 'window', stand: { x: 31, y: 3 }, facing: 'up', fx: { x: 31, y: 1 }, duration: 5 },
    // the kitchen tap/soda dispenser (a free gap in the café counter run)
    { kind: 'dispenser', stand: { x: 33, y: 17 }, facing: 'down', fx: { x: 33, y: 18 }, duration: 3.5 },
    // the Central Perk fridge + stocked shelf (part of the café stamp)
    { kind: 'fridge', stand: { x: 34, y: 17 }, facing: 'up', fx: { x: 34, y: 16 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 32, y: 22 }, facing: 'up', fx: { x: 32, y: 21 }, duration: 4 },
    // takeout-container bins (entrance hallway + kitchen)
    { kind: 'bin', stand: { x: 17, y: 21 }, facing: 'down', fx: { x: 17, y: 22 }, duration: 2.6 },
    { kind: 'bin', stand: { x: 34, y: 18 }, facing: 'right', fx: { x: 35, y: 18 }, duration: 2.6 },
  ],
  // friends.tmj's desks paint the same office desk stamp (monitor gid 365
  // OFF / 367-368/383-384 ON) as every other theme.
  monitor: OFFICE_THEME.monitor,
  // friends' own palette: a warm burgundy/wine background echoing the wall's
  // plum accent line, distinct from office's ink, brooklyn99's cool teal,
  // and siliconvalley's neutral concrete.
  palette: {
    background: 0x2a161a,
    noteColors: { todo: 0xf2c96a, doing: 0xe0785a, blocked: 0xb5455a, done: 0x9db66a },
  },
  // Custom themes/TV-show themes always use the built-in roster (see
  // docs/theme-authoring.md) — no new likeness set for this pass.
  cast: OFFICE_THEME.cast,
};

/** Game of Thrones — the Red Keep throne room (Phase 8 groundwork; card
 *  tvshow-phase8-got-hogwarts-placeholder). UNLIKE brooklyn99/siliconvalley/
 *  friends (Phase 2/5), this is NOT a built theme — `built: false` stays set
 *  in OfficeThemePicker.tsx's THEME_META, and that is the honest, correct
 *  state: there is no stone-wall, torch, iron-throne, or council-table tile
 *  in ANY loaded atlas (office-tileset.png, a5-office-floors-walls.png,
 *  interiors.png are all modern office/interior art), and no Red Keep .tmj
 *  map exists. This ThemeConfig exists ONLY so `getTheme('got')` resolves to
 *  something explicit and inspectable instead of silently falling through
 *  the `??` fallback in `getTheme` below — the exact same "placeholder real,
 *  not broken" role BROOKLYN99_THEME played before its own map/anchors
 *  landed. PLACEHOLDER: every field below except `id` and `palette` is
 *  copied byte-for-byte from OFFICE_THEME (same office.tmj map, same
 *  tilesets, same seats/coffee/anchors/errand spots) — selecting 'got' today
 *  renders the ordinary office floor, not a Red Keep. `palette` is the one
 *  place this theme has its own identity, echoing THEME_META's swatch
 *  (#6a2630) so the picker's preview color and the actual in-scene mood
 *  agree even before real art exists. See docs/theme-authoring.md's "Game of
 *  Thrones and Hogwarts" section for exactly which tilesets/props/map a real
 *  artist would need to draw, and how each existing `ErrandKind` maps onto a
 *  Westerosi equivalent. */
export const GOT_THEME: ThemeConfig = {
  ...OFFICE_THEME,
  id: 'got',
  stationSpots: undefined,
  // Phase 10: keep the UNPATCHED atlas copy, not office's — this placeholder
  // stays byte-for-byte the old office floor/walls, per this phase's "office
  // theme only" scope, even though `...OFFICE_THEME` above would otherwise
  // also inherit its procedural floor/wall repaint.
  tilesets: BASE_TILESETS,
  palette: {
    background: 0x2a1216, // dark stone-red, echoes THEME_META's '#6a2630' swatch
    noteColors: { todo: 0xd9b26a, doing: 0xc97a4a, blocked: 0x8a1f28, done: 0x6a7a4a },
  },
};

/** Hogwarts — the Great Hall (Phase 8 groundwork; same card as GOT_THEME
 *  above). Also NOT a built theme — `built: false` stays set in
 *  OfficeThemePicker.tsx's THEME_META. No castle-stone, floating-candle,
 *  house-banner, or portrait tile exists in any loaded atlas, and no Great
 *  Hall / common-room .tmj map exists. PLACEHOLDER: every field below except
 *  `id` and `palette` is copied byte-for-byte from OFFICE_THEME — selecting
 *  'hogwarts' today renders the ordinary office floor, not Hogwarts.
 *  `palette` echoes THEME_META's swatch (#39305a). See
 *  docs/theme-authoring.md's "Game of Thrones and Hogwarts" section for the
 *  concrete art/map work needed and the ErrandKind → Hogwarts-prop mapping. */
export const HOGWARTS_THEME: ThemeConfig = {
  ...OFFICE_THEME,
  id: 'hogwarts',
  stationSpots: undefined,
  // Phase 10: same reasoning as GOT_THEME above — keep the unpatched atlas.
  tilesets: BASE_TILESETS,
  palette: {
    background: 0x241d3a, // dark castle-purple, echoes THEME_META's '#39305a' swatch
    noteColors: { todo: 0xe0c96a, doing: 0x8a7ac0, blocked: 0xb05a5a, done: 0x6a9a7a },
  },
};

/** Isometric — a PROTOTYPE, and the first theme in this registry whose point is
 *  a projection rather than a show.
 *
 *  WHAT IT IS. A 12x12 room (isometric.tmj, generated by
 *  tools/build-iso-map.cjs) drawn on a 2:1 diamond grid: a procedural floor,
 *  two back walls, six desks with a chair each, and the cast seated at them.
 *  `orientation: 'isometric'` in the map is what selects the projection — see
 *  TiledMapRenderer's constructor — so the geometry and the map that was
 *  authored for it can never disagree.
 *
 *  WHAT IT IS NOT. It is not a port of the office. There is no café, no coffee
 *  economy, no errand spots, no boardroom overflow, no monitor overlays, no
 *  desk trinket shelves, no wall props and no weather; `features` below and the
 *  empty seat/errand arrays say so explicitly rather than leaving half-working
 *  versions on screen. The tell for all of them is the same: their art and
 *  their anchors were drawn against a 16x16 SQUARE cell, and this grid has
 *  diamonds. Porting them is real art work, not a config change.
 *
 *  ART. Not one new image file. The atlas is generated by isoTileArt.ts from
 *  TILE_PALETTES.office — the exact warm oak and warm gray the orthogonal
 *  office floor uses — so a side-by-side comparison is a comparison of
 *  PROJECTIONS, with the palette held fixed. Swap `tilePaletteKey` to
 *  brooklyn99/siliconvalley/friends and the same room comes out in that show's
 *  colours.
 *
 *  It is deliberately not the default and is opt-in from the theme picker. If
 *  it does not convince, deleting this constant, its THEMES entry, its
 *  OfficeThemePicker card and the two generated files is the whole removal. */
const ISOMETRIC_TILESETS: TilesetEntry[] = [
  { url: '', procedural: { kind: 'iso' }, tilePaletteKey: 'office', firstgid: 1, image: 'iso', imagewidth: 128, imageheight: 64, tilewidth: 32, tileheight: 32, columns: 4, tilecount: 8 },
];

export const ISOMETRIC_THEME: ThemeConfig = {
  id: 'isometric',
  mapRaw: isometricMapRaw,
  tilesets: ISOMETRIC_TILESETS,
  primarySeatNames: ['desk-ceo', 'pc-1', 'pc-2', 'pc-3', 'pc-4', 'pc-5'],
  // No break room in the prototype. Empty here is load-bearing, not an
  // oversight: the cafeteria director walks the café-spot list, so an empty
  // list means no breaks, no rendezvous and no coffee runs are ever started —
  // the mechanics switch themselves off at the source.
  cafeSeatNames: [],
  cafeStands: [],
  // Required by the contract; unused, because `features.coffee` is false and
  // nothing ever walks to a coffee station. Pointed at the entrance tile so the
  // values are at least on the map if something reads them.
  coffee: {
    trayTile: { x: 6, y: 10 },
    trayStand: { x: 6, y: 10 },
    machineStand: { x: 6, y: 10 },
    sinkTile: { x: 6, y: 10 },
    sinkStand: { x: 6, y: 10 },
    maxCups: 0,
  },
  // Also required, also unused (`features.wallProps` is false). Real tiles on
  // the back wall, so if the switch is ever flipped on for an experiment the
  // props appear somewhere sane instead of off-map.
  anchors: {
    calendar: { x: 1, y: 0 },
    boards: { x: 4, y: 0 },
    clock: { x: 0, y: 1 },
    worldClock: { x: 7, y: 0 },
    // Same reasoning as the rest of this block: unused (`features.wallProps`
    // is false, `features.coffee` is false), but on THIS 12x12 map rather than
    // on office.tmj's 34x22 one — the literals these replaced, (14,10) and
    // (26,17), are both off the edge of this map entirely.
    askBoard: { x: 9, y: 0 },
    coffeeSteam: { x: 6, y: 10 },
    // Unused too (the board choreography is gated on `features.wallProps`),
    // but these are walk destinations, so they point at three tiles of this
    // map's own open bottom row — all walkable in isometric.tmj's collision
    // layer — rather than office.tmj's row 11, which on a 12-row map is the
    // last row and partly outside the room.
    boardPinStand: { x: 5, y: 10 },
    boardTakeStand: { x: 6, y: 10 },
    boardArchiveStand: { x: 7, y: 10 },
  },
  errandSpots: [],
  // No desk paints the office monitor block, so no DeskScreen / DeskShelf /
  // cup spot is ever built (OfficeFloor checks the gid before creating them).
  monitor: OFFICE_THEME.monitor,
  palette: {
    background: 0x181410,
    noteColors: OFFICE_THEME.palette.noteColors,
  },
  cast: OFFICE_THEME.cast,
  features: { coffee: false, wallProps: false, weather: false },
};

/** All registered themes. Phase 0 ships only the office; show themes register
 *  here as their content lands (Phase 2 = brooklyn99, Phase 5 = siliconvalley
 *  + friends). Phase 8 adds explicit (but still `built: false`) placeholders
 *  for got/hogwarts — see GOT_THEME/HOGWARTS_THEME above for why they're
 *  registered here despite having no real art yet. */
export const THEMES: Partial<Record<ThemeId, ThemeConfig>> = {
  office: OFFICE_THEME,
  brooklyn99: BROOKLYN99_THEME,
  siliconvalley: SILICONVALLEY_THEME,
  friends: FRIENDS_THEME,
  got: GOT_THEME,
  hogwarts: HOGWARTS_THEME,
  isometric: ISOMETRIC_THEME,
};

/** Look up a theme by id, falling back to the office theme if unknown/missing
 *  (a bad/absent show bundle must never break the floor — see report §E). */
export function getTheme(id: ThemeId): ThemeConfig {
  return THEMES[id] ?? OFFICE_THEME;
}
