// Framing a WING of the office floor: which world point the camera centres on
// for a named zone, and how far it zooms in.
//
// WHY THIS EXISTS. The rebuilt `office` map (48x36 tiles) is roughly twice the
// area of the one the scene was written against, and the camera's only mode was
// `fitToScreen()` — the whole map squeezed into the panel. Everything got
// smaller: the air the layout was designed with disappeared and the floor reads
// as cramped. The map is organised into named wings for exactly this reason, so
// the fix is to let the user frame ONE of them.
//
// `Camera.focusOn(x, y, zoom)` has been in the file, unused, since the camera
// was ported — smooth lerp, reduced-motion respect, a `manualOverride` flag and
// a zoom clamp. This module is the missing half: the arithmetic that turns "the
// war room" into the three numbers focusOn takes.
//
// Pure on purpose, like ./idleAffinity and ./projection: no pixi, no store, no
// DOM. A wing's framing is a statement about rectangles and a viewport, and it
// is the part that would silently rot (a wing that frames off-centre, or a small
// room and a large one drawn at the same zoom) — so it is the part that gets
// unit tests, without a GPU. The scene only supplies the numbers.

import type { Projection } from './projection';

/** A rectangle in TILE coordinates — what `TiledMapRenderer.getZone()` returns. */
export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in WORLD pixels — the space inside the camera's container. */
export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The panel the scene is drawn into, in screen pixels. */
export interface ViewSize {
  width: number;
  height: number;
}

/** Exactly the three arguments `Camera.focusOn` takes. */
export interface Framing {
  x: number;
  y: number;
  zoom: number;
}

/** A wing the picker can offer: the zone's name and where it is. */
export interface Wing {
  name: string;
  rect: TileRect;
}

/** Zone-name prefix that marks a zone as a wing of the floor. Only the rebuilt
 *  `office` map has any; every other theme's zones (`cafeteria`, `livingroom`,
 *  `holding`, …) are prop/seating regions, not places to point a camera, and
 *  the picker must not invent rooms out of them. See `wingsFromZones`. */
export const WING_PREFIX = 'wing-';

/** Breathing room kept around a wing, in tiles per side. The complaint this
 *  whole feature answers is "everything is squeezed", so a wing that fills the
 *  panel edge to edge would reproduce it one scale up: the point of framing a
 *  wing is that you can see it has walls. */
export const WING_PADDING_TILES = 1;

/** Upper zoom bound. Mirrors the hard 4 inside `Camera.focusOn` — stated here
 *  so the framing this module returns is already inside the camera's clamp and
 *  the two can be compared in a test rather than diverging in silence. */
export const MAX_WING_ZOOM = 4;

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * The wings a map offers, in the order its `zones` layer declares them.
 *
 * Everything that is not prefixed is dropped, which is what makes the control
 * degrade cleanly on the four themes that have no wings: they return an empty
 * list and the picker never mounts. `wing-` on its own (no suffix) is dropped
 * too — it would have no label and no meaning.
 */
export function wingsFromZones(zones: Iterable<[string, TileRect]>): Wing[] {
  const wings: Wing[] = [];
  const seen = new Set<string>();
  for (const [name, rect] of zones) {
    if (!name.startsWith(WING_PREFIX)) continue;
    if (name.length <= WING_PREFIX.length) continue;
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    wings.push({ name, rect });
  }
  return wings;
}

/** The part of a wing's zone name that identifies the room: `wing-warroom` →
 *  `warroom`. Used for the i18n key and for the prettified fallback label. */
export function wingSuffix(name: string): string {
  return name.startsWith(WING_PREFIX) ? name.slice(WING_PREFIX.length) : name;
}

/** i18n key for a wing's label. A map may name a wing this app has never heard
 *  of (a user-authored theme bundle), which is why callers pair this with
 *  `wingFallbackLabel` as i18next's `defaultValue` instead of rendering a raw
 *  key on screen.
 *
 *  Map-derived names live one level below the picker's own chrome (`names.`)
 *  rather than beside it, so a zone called `wing-title` or `wing-all` cannot
 *  shadow a UI string. */
export function wingLabelKey(name: string): string {
  return `office.wings.names.${wingSuffix(name)}`;
}

/** Last-resort label for a wing with no translation: `wing-cold-storage` →
 *  `Cold storage`. Never reached by the shipped map. */
export function wingFallbackLabel(name: string): string {
  const words = wingSuffix(name).split(/[-_]+/).filter(Boolean).join(' ');
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A tile rectangle's bounding box in world pixels.
 *
 * Built from the four CORNERS rather than `width * tileWidth`, because on a
 * diamond grid the axis-aligned box around a tile rectangle is not the product
 * of its sides (see projection.ts's isometric implementation). No shipped
 * isometric map declares zones today; doing it right here costs three extra
 * calls and means this module never becomes the reason a future one can't.
 */
export function wingWorldRect(rect: TileRect, projection: Projection): WorldRect {
  const corners = [
    projection.tileToWorld(rect.x, rect.y),
    projection.tileToWorld(rect.x + rect.width, rect.y),
    projection.tileToWorld(rect.x, rect.y + rect.height),
    projection.tileToWorld(rect.x + rect.width, rect.y + rect.height),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** The zoom at which a `width x height` world box exactly fills `view`. Zero
 *  anywhere degrades to 1, the same answer `Camera.getMinZoom()` gives for a
 *  viewport it has not been told the size of yet. */
export function fitZoom(width: number, height: number, view: ViewSize): number {
  if (view.width <= 0 || view.height <= 0) return 1;
  if (width <= 0 || height <= 0) return 1;
  return Math.min(view.width / width, view.height / height);
}

export interface WingFramingInput {
  /** The wing's rectangle, in tiles. */
  zone: TileRect;
  projection: Projection;
  /** Panel size in screen pixels. */
  view: ViewSize;
  /** The whole map's size in world pixels (`TiledMapRenderer.worldSize()`) —
   *  needed for the LOWER clamp, which is the whole-map fit zoom. */
  mapWorld: { width: number; height: number };
  paddingTiles?: number;
}

/**
 * Where the camera goes to frame one wing.
 *
 * The zoom is DERIVED from the wing's own rectangle, never a constant: the
 * engineering floor (27x20 tiles) and the meeting room (17x9) are different
 * rooms and a single magic number would either leave one swimming in empty
 * floor or crop the other. It is then clamped into exactly the range
 * `Camera.focusOn` accepts — never below the whole-map fit (zooming "into" a
 * wing must never show LESS than the overview it replaced) and never above
 * `MAX_WING_ZOOM`, at which the 16px tile art is already four times its
 * authored size. Clamping here as well as in the camera is deliberate: it makes
 * the returned framing the truth about what the user will see, which is what
 * the tests assert against.
 *
 * The centre is the wing's geometric centre. The camera's own edge clamp
 * (Camera.update) pulls that back inside the map for a wing against a wall, so
 * this does not try to second-guess it.
 */
export function computeWingFraming(input: WingFramingInput): Framing {
  const { zone, projection, view, mapWorld } = input;
  const padTiles = input.paddingTiles ?? WING_PADDING_TILES;
  const rect = wingWorldRect(zone, projection);
  const padX = padTiles * projection.tileWidth;
  const padY = padTiles * projection.tileHeight;

  const minZoom = fitZoom(mapWorld.width, mapWorld.height, view);
  const wingZoom = fitZoom(rect.width + 2 * padX, rect.height + 2 * padY, view);

  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
    // Same order as Camera.focusOn's own clamp: the floor wins over the ceiling
    // on a map small enough for both to bind.
    zoom: clamp(wingZoom, minZoom, Math.max(minZoom, MAX_WING_ZOOM)),
  };
}

/** The wing a tile falls in, or null for the corridors and doorways between
 *  them. First match wins; the shipped wings do not overlap. */
export function wingContainingTile(
  tile: { x: number; y: number },
  wings: readonly Wing[],
): string | null {
  for (const w of wings) {
    if (tile.x >= w.rect.x && tile.x < w.rect.x + w.rect.width
      && tile.y >= w.rect.y && tile.y < w.rect.y + w.rect.height) {
      return w.name;
    }
  }
  return null;
}

/**
 * What the wing picker should show after the user selects an AGENT.
 *
 * This is the one interaction the feature could quietly ruin. Selecting an agent
 * already pans the camera (`Camera.nudgeToward`, from OfficeFloor's store
 * subscription) — and `nudgeToward` returns immediately while `manualOverride`
 * is set, which is exactly what framing a wing sets. So without a rule here,
 * clicking an agent in another wing does nothing at all: the selection lands,
 * the sidebar switches, and the avatar the user just picked is off screen with
 * no explanation.
 *
 * The rule, in order:
 *
 *   - Not in a wing (`current === null`) → stay. The camera is on the whole
 *     floor, `manualOverride` is false, and `nudgeToward`'s glance works exactly
 *     as it did before this feature existed. Nothing changes for a user who
 *     never opens the picker.
 *   - The agent is in the wing already framed → stay, and do not move the
 *     camera. They are on screen; nudging a deliberately composed frame off its
 *     centre would be worse than leaving it still.
 *   - The agent is in a DIFFERENT wing → follow them there. The picker's label
 *     changes with the camera, so the move is explained by the control rather
 *     than being a mystery pan.
 *   - The agent is in no wing at all (a corridor, the entrance, a coffee run) →
 *     fall back to the whole office. There is no wing that would show them, and
 *     the overview always does.
 *
 * Pure, so all four branches are pinned in test/office-wing-framing.test.cjs.
 */
export function wingForSelection(
  current: string | null,
  agentWing: string | null,
): string | null {
  if (current === null) return null;
  if (agentWing === current) return current;
  return agentWing;
}
