// Procedural portraits for The Office cast.
//
// These are fully custom-drawn busts (NOT recolored LimeZu sprites): each
// character is an explicit recipe layering skin → clothing → face → facial hair
// → hairstyle → glasses on an 18×28 canvas. This gives real control over each
// person's hairstyle shape, garment cut/color, and facial hair so they read as
// the specific show character. The in-scene walking sprites still use the LimeZu
// recolor in cast.ts; this module only powers the static portraits in the UI.

import type { OfficeCharacterName } from './cast';

export const PORTRAIT_W = 18;
export const PORTRAIT_H = 28;
// In-scene walking sprite: same width + upper body as the portrait, taller to add legs.
export const SCENE_W = 18;
export const SCENE_H = 32;
const OUTLINE: RGB = [38, 34, 46];
const HX0 = 4, HX1 = 13; // head skin columns

export type RGB = [number, number, number];
type Buf = Uint8ClampedArray;

// Current canvas dims — set per compose() so the same drawing primitives serve
// both the 18×28 portrait and the 18×32 scene sprite. (Rendering is synchronous.)
let CUR_W = PORTRAIT_W, CUR_H = PORTRAIT_H;

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
function shades(rgb: RGB, dl = 1.22, dd = 0.68): [RGB, RGB, RGB] {
  return [
    [clamp(rgb[0] * dl), clamp(rgb[1] * dl), clamp(rgb[2] * dl)],
    [rgb[0], rgb[1], rgb[2]],
    [clamp(rgb[0] * dd), clamp(rgb[1] * dd), clamp(rgb[2] * dd)],
  ];
}

function set(buf: Buf, x: number, y: number, c: RGB, a = 255): void {
  if (x < 0 || x >= CUR_W || y < 0 || y >= CUR_H) return;
  const i = (y * CUR_W + x) * 4;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = a;
}
function alphaAt(buf: Buf, x: number, y: number): number {
  if (x < 0 || x >= CUR_W || y < 0 || y >= CUR_H) return 0;
  return buf[(y * CUR_W + x) * 4 + 3];
}
function rgbAt(buf: Buf, x: number, y: number): RGB {
  const i = (y * CUR_W + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2]];
}
function eq(a: RGB, b: RGB): boolean { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }
function rect(buf: Buf, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(buf, x, y, c);
}

// ─── palettes ────────────────────────────────────────────────────────────────
interface SkinPal { hi: RGB; base: RGB; sh: RGB; line: RGB; }
const SKIN: Record<string, SkinPal> = {
  light: { hi: [255, 221, 189], base: [247, 201, 170], sh: [212, 158, 126], line: [168, 112, 82] },
  tan:   { hi: [232, 182, 136], base: [214, 162, 116], sh: [176, 126, 86],  line: [138, 92, 60] },
  brown: { hi: [180, 130, 94],  base: [158, 112, 78],  sh: [124, 86, 58],   line: [90, 60, 40] },
  dark:  { hi: [142, 98, 70],   base: [120, 80, 56],   sh: [94, 62, 42],    line: [64, 42, 28] },
};
/** Enumerable skin-palette keys, for a picker in the custom-character builder. */
export const SKIN_KEYS: string[] = Object.keys(SKIN);

// ─── head + face ─────────────────────────────────────────────────────────────
function drawHead(buf: Buf, skin: string): void {
  const s = SKIN[skin];
  for (let y = 4; y <= 16; y++) {
    for (let x = HX0; x <= HX1; x++) {
      if (((x === HX0 || x === HX1) && (y === 4 || y === 5 || y === 16)) || ((x === 5 || x === 12) && y === 4)) continue;
      set(buf, x, y, s.base);
    }
  }
  for (let y = 6; y < 12; y++) set(buf, 5, y, s.hi);
  set(buf, 6, 5, s.hi); set(buf, 7, 5, s.hi);
  for (let y = 6; y < 15; y++) set(buf, 12, y, s.sh);
  for (const x of [7, 8, 9, 10, 11]) set(buf, x, 16, s.sh);
  for (const ex of [HX0 - 1, HX1 + 1]) { set(buf, ex, 9, s.base); set(buf, ex, 10, s.base); set(buf, ex, 11, s.sh); }
  rect(buf, 7, 17, 10, 18, s.sh); rect(buf, 7, 17, 9, 17, s.base);
}

export type Brow = 'flat' | 'angry' | 'raised' | 'soft';
export type Mouth = 'neutral' | 'smile' | 'frown' | 'grin';
/** Enumerable option lists, for pickers in the custom-character builder. */
export const BROW_OPTIONS: Brow[] = ['flat', 'angry', 'raised', 'soft'];
export const MOUTH_OPTIONS: Mouth[] = ['neutral', 'smile', 'frown', 'grin'];
function drawFace(buf: Buf, skin: string, brow: Brow, mouth: Mouth, blush: boolean, lashes = false): void {
  const s = SKIN[skin];
  const white: RGB = [250, 248, 244], pup: RGB = [46, 38, 42];
  for (const [a, b, p] of [[5, 6, 6], [10, 11, 10]] as const) {
    set(buf, a, 9, white); set(buf, b, 9, white); set(buf, p, 9, pup);
  }
  // Feminine eyes: a dark upper lash line + an outer flick, and a bright glint
  // in each pupil so they read as bigger, rounder, more expressive.
  if (lashes) {
    const lash: RGB = [54, 40, 48], glint: RGB = [252, 250, 248];
    for (const x of [5, 6, 10, 11]) set(buf, x, 8, lash);
    set(buf, 4, 8, lash); set(buf, 12, 8, lash);
    set(buf, 5, 9, glint); set(buf, 10, 9, glint);
  }
  if (brow === 'flat') for (const x of [5, 6, 10, 11]) set(buf, x, 7, s.line);
  else if (brow === 'angry') { set(buf, 5, 8, s.line); set(buf, 6, 7, s.line); set(buf, 10, 7, s.line); set(buf, 11, 8, s.line); }
  else if (brow === 'raised') for (const x of [5, 6, 10, 11]) set(buf, x, 6, s.line);
  else if (brow === 'soft') { for (const x of [5, 11]) set(buf, x, 7, s.line); for (const x of [6, 10]) set(buf, x, 7, s.sh); }
  set(buf, 8, 11, s.sh); set(buf, 8, 12, s.sh); set(buf, 7, 12, s.sh);
  const mc: RGB = [158, 86, 80];
  const mouths: Record<Mouth, [number, number][]> = {
    neutral: [[7, 14], [8, 14], [9, 14], [10, 14]],
    smile: [[7, 14], [8, 14], [9, 14], [10, 14], [6, 13], [11, 13]],
    frown: [[7, 15], [8, 15], [9, 15], [10, 15], [6, 14], [11, 14]],
    grin: [[7, 14], [8, 14], [9, 14], [10, 14], [7, 13], [8, 13], [9, 13], [10, 13], [6, 13], [11, 13]],
  };
  for (const [x, y] of mouths[mouth]) set(buf, x, y, mc);
  if (blush) for (const x of [5, 12]) set(buf, x, 12, [235, 150, 140], 140);
}

// ─── hairstyles ──────────────────────────────────────────────────────────────
export interface HairArgs { part?: 'L' | 'R'; recede?: number; length?: number; vol?: number; }
type HairFn = (buf: Buf, color: RGB, skinBase: RGB, a: HairArgs) => void;

const styleShort: HairFn = (buf, color, skinBase, a) => {
  const [hi, base, sh] = shades(color);
  const part = a.part ?? 'L', recede = a.recede ?? 0;
  rect(buf, HX0, 2, HX1, 4, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 3, base);
  rect(buf, HX0 - 1, 4, HX1 + 1, 5, base);
  for (let y = 6; y < 9; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  if (recede) {
    for (let y = 3; y < 6; y++) for (let x = 6; x < 12; x++) if (eq(rgbAt(buf, x, y), base)) set(buf, x, y, skinBase);
    set(buf, 8, 5, base); // widow's peak
  }
  const hx = part === 'L' ? 6 : 11;
  for (let y = 2; y < 6; y++) set(buf, hx, y, sh);
  for (let x = HX0; x < hx; x++) if (alphaAt(buf, x, 3)) set(buf, x, 3, hi);
  for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 2)) set(buf, x, 2, hi);
};

const styleFloppy: HairFn = (buf, color) => {
  const [hi, base] = shades(color);
  rect(buf, HX0, 2, HX1, 4, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 3, base);
  rect(buf, HX0 - 1, 4, HX1 + 1, 5, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  for (let x = 6; x <= 12; x++) set(buf, x, 6, base);
  set(buf, 9, 7, base); set(buf, 10, 7, base); set(buf, 11, 7, base);
  for (let y = 6; y < 9; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
  for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 2)) set(buf, x, 2, hi);
  for (const x of [7, 8, 9]) set(buf, x, 6, hi);
};

const styleFrame: HairFn = (buf, color, skinBase, a) => {
  const [hi, base, sh] = shades(color);
  const length = a.length ?? 17, vol = a.vol ?? 1;
  rect(buf, HX0 - 1, 2, HX1 + 1, 5, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 3, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  for (let x = 6; x < 12; x++) set(buf, x, 6, base);
  set(buf, 8, 6, skinBase); set(buf, 9, 6, skinBase);
  for (let y = 6; y <= length; y++) {
    for (let dx = 0; dx < vol; dx++) { set(buf, HX0 - 1 - dx, y, base); set(buf, HX1 + 1 + dx, y, base); }
    set(buf, HX0, y, base); set(buf, HX1, y, base);
  }
  for (let x = HX0 - 1; x < HX0 + 1; x++) set(buf, x, length + 1, base);
  for (let x = HX1; x < HX1 + 2; x++) set(buf, x, length + 1, base);
  for (let y = 2; y < 6; y++) if (alphaAt(buf, HX1, y)) set(buf, HX1, y, sh);
  for (let x = HX0; x < 9; x++) if (alphaAt(buf, x, 2)) set(buf, x, 2, hi);
};

const styleBun: HairFn = (buf, color, skinBase) => {
  const [hi, base] = shades(color);
  rect(buf, HX0, 3, HX1, 5, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 4, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  for (let x = 6; x < 12; x++) set(buf, x, 6, base);
  set(buf, 8, 6, skinBase); set(buf, 9, 6, skinBase);
  for (let y = 6; y < 9; y++) { set(buf, HX0, y, base); set(buf, HX1, y, base); }
  rect(buf, 7, 1, 10, 2, base);
  for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 3)) set(buf, x, 3, hi);
};

const styleCurly: HairFn = (buf, color, skinBase) => {
  const [hi, base] = shades(color);
  const pts: [number, number][] = [[4, 3], [5, 2], [6, 3], [7, 2], [8, 3], [9, 2], [10, 3], [11, 2], [12, 3], [13, 3],
    [3, 4], [4, 4], [13, 4], [14, 4], [3, 5], [4, 5], [13, 5], [14, 5], [3, 6], [13, 6], [4, 6], [12, 6], [3, 7], [13, 7], [4, 7]];
  rect(buf, HX0, 3, HX1, 5, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 4, base);
  for (const [x, y] of pts) set(buf, x, y, base);
  for (let x = 6; x < 12; x++) set(buf, x, 6, base);
  set(buf, 8, 6, skinBase); set(buf, 9, 6, skinBase);
  for (const [x, y] of [[5, 2], [7, 2], [9, 2], [11, 2]] as const) set(buf, x, y, hi);
};

const styleMessy: HairFn = (buf, color, skinBase, a) => {
  const [hi, base] = shades(color);
  const length = a.length ?? 8;
  rect(buf, HX0 - 1, 2, HX1 + 1, 5, base);
  const spikes: [number, number][] = [[3, 2], [5, 1], [7, 2], [9, 1], [11, 2], [13, 1], [14, 2], [4, 2], [12, 2]];
  for (const [x, y] of spikes) set(buf, x, y, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  for (let x = 6; x < 12; x++) set(buf, x, 6, base);
  set(buf, 8, 6, skinBase); set(buf, 9, 6, skinBase);
  for (let y = 6; y <= length; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
  for (const [x, y] of spikes) set(buf, x, y, hi);
};

const styleRecede: HairFn = (buf, color, skinBase) => {
  const [, base, sh] = shades(color);
  for (let y = 4; y < 10; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
  for (let x = HX0; x <= HX1; x++) set(buf, x, 4, base);
  for (let x = HX0 + 1; x < HX1; x++) set(buf, x, 5, base);
  for (let y = 5; y < 9; y++) for (let x = 6; x < 12; x++) if (eq(rgbAt(buf, x, y), base)) set(buf, x, y, skinBase);
  for (let x = HX0; x <= HX1; x++) if (alphaAt(buf, x, 4)) set(buf, x, 4, sh);
};

const styleSpiky: HairFn = (buf, color, skinBase) => {
  const [hi, base] = shades(color);
  rect(buf, HX0, 3, HX1, 5, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 4, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  const spikes: [number, number][] = [[5, 2], [7, 1], [9, 2], [11, 1], [6, 2], [8, 2], [10, 2], [12, 2]];
  for (const [x, y] of spikes) set(buf, x, y, base);
  for (let x = 6; x < 12; x++) set(buf, x, 6, base);
  set(buf, 8, 6, skinBase); set(buf, 9, 6, skinBase);
  for (let y = 6; y < 8; y++) { set(buf, HX0, y, base); set(buf, HX1, y, base); }
  for (const [x, y] of spikes) set(buf, x, y, hi);
};

// Bald: a rounded skin crown (with a sheen) and only a low horseshoe fringe of
// hair around the temples / back of the head.
const styleBald: HairFn = (buf, color, skinBase, a) => {
  const [shi, sbase, ssh] = shades(skinBase, 1.1, 0.82);
  // rounded skin dome above the forehead
  for (let x = 6; x <= 11; x++) set(buf, x, 2, sbase);
  for (let x = 5; x <= 12; x++) set(buf, x, 3, sbase);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 4, sbase);
  // bald-head sheen + side falloff
  for (const x of [7, 8, 9]) set(buf, x, 2, shi);
  set(buf, 6, 3, shi); set(buf, 7, 3, shi);
  set(buf, 5, 3, ssh); set(buf, 12, 3, ssh); set(buf, HX1, 4, ssh);
  // low horseshoe hair fringe — sides only, leaving the crown bald.
  const [, base, sh] = shades(color);
  const top = a.recede ? 8 : 6; // recede:1 → only a thin fringe very low
  for (let y = top; y <= 10; y++) {
    set(buf, HX0 - 1, y, base); set(buf, HX0, y, base);
    set(buf, HX1, y, base); set(buf, HX1 + 1, y, base);
  }
  for (let y = top; y <= 10; y++) { set(buf, HX0 - 1, y, sh); set(buf, HX1 + 1, y, sh); }
};

const HAIR_FNS = { styleShort, styleFloppy, styleFrame, styleBun, styleCurly, styleMessy, styleRecede, styleSpiky, styleBald };
export type HairStyle = keyof typeof HAIR_FNS;
/** Enumerable hair styles, in the same order as HAIR_FNS — for a thumbnail grid
 *  in the custom-character builder. */
export const HAIR_STYLES: HairStyle[] = Object.keys(HAIR_FNS) as HairStyle[];

// ─── facial hair ─────────────────────────────────────────────────────────────
export type Facial = 'mustache' | 'mustacheSm' | 'stubble' | 'goatee' | 'fullbeard';
export const FACIAL_OPTIONS: Facial[] = ['mustache', 'mustacheSm', 'stubble', 'goatee', 'fullbeard'];
function drawFacial(buf: Buf, kind: Facial, color: RGB): void {
  const [, base, sh] = shades(color);
  if (kind === 'mustache') {
    for (const x of [6, 7, 8, 9, 10]) set(buf, x, 13, base);
    set(buf, 6, 12, base); set(buf, 10, 12, base);
  } else if (kind === 'mustacheSm') {
    for (const x of [7, 8, 9]) set(buf, x, 13, base);
  } else if (kind === 'stubble') {
    for (const [x, y] of [[5, 14], [6, 15], [7, 15], [8, 15], [9, 15], [10, 15], [11, 14], [12, 13], [4, 13], [5, 15], [10, 15]] as const)
      set(buf, x, y, sh, 150);
  } else if (kind === 'goatee') {
    for (const x of [8, 9]) set(buf, x, 15, base);
    set(buf, 8, 14, base); set(buf, 9, 14, base);
    for (const x of [7, 8, 9, 10]) set(buf, x, 13, base);
  } else if (kind === 'fullbeard') {
    // Fuller coverage than a goatee: solid beard climbing both jaw edges up to
    // the sideburns plus a filled chin — the mouth's center still peeks through.
    for (const x of [5, 6, 11, 12]) set(buf, x, 14, base);
    for (const x of [5, 6, 7, 10, 11, 12]) set(buf, x, 15, base);
    for (const x of [6, 7, 8, 9, 10, 11]) set(buf, x, 16, base);
    set(buf, 8, 15, sh); set(buf, 9, 15, sh);
  }
}

// ─── glasses ─────────────────────────────────────────────────────────────────
// An enumerable style choice rather than a single fixed look. `Recipe.glasses`
// being unset/omitted still means "no glasses" (mirrors how `Recipe.facial`
// works) — the fixed cast's `glasses: true` era is migrated to `glasses:
// 'round'`, which reproduces the original single style byte-for-byte.
export type GlassesKind = 'round' | 'square' | 'sun';
export const GLASSES_OPTIONS: GlassesKind[] = ['round', 'square', 'sun'];
function drawGlasses(buf: Buf, kind: GlassesKind): void {
  const frame: RGB = [60, 54, 62];
  const glint: RGB = [236, 240, 246];
  if (kind === 'square') {
    // Thicker, boxier rim: a full rectangle around each eye (no cut corners),
    // reading heavier/more structured than the round style.
    for (const x of [4, 5, 6, 7]) { set(buf, x, 8, frame); set(buf, x, 10, frame); }
    for (const x of [9, 10, 11, 12]) { set(buf, x, 8, frame); set(buf, x, 10, frame); }
    set(buf, 4, 9, frame); set(buf, 7, 9, frame);
    set(buf, 9, 9, frame); set(buf, 12, 9, frame);
    set(buf, 8, 8, frame);
    set(buf, 3, 9, frame); set(buf, 13, 9, frame);
    set(buf, 4, 8, glint); set(buf, 9, 8, glint);
    return;
  }
  if (kind === 'sun') {
    // Same cut-corner rim as 'round', but with fully opaque dark lenses —
    // hides the eyes entirely instead of just framing them.
    const lens: RGB = [30, 28, 34];
    for (const x of [5, 6]) { set(buf, x, 8, frame); set(buf, x, 10, frame); }
    for (const x of [10, 11]) { set(buf, x, 8, frame); set(buf, x, 10, frame); }
    set(buf, 4, 9, frame); set(buf, 7, 9, frame);
    set(buf, 9, 9, frame); set(buf, 12, 9, frame);
    set(buf, 8, 8, frame);
    set(buf, 3, 9, frame); set(buf, 13, 9, frame);
    for (const x of [5, 6]) set(buf, x, 9, lens);
    for (const x of [10, 11]) set(buf, x, 9, lens);
    set(buf, 5, 8, glint);
    return;
  }
  // 'round' — clear prescription glasses (the original single fixed look): a
  // thin rim that frames each eye without covering it, plus a glint so the
  // lens reads as transparent glass.
  for (const x of [5, 6]) { set(buf, x, 8, frame); set(buf, x, 10, frame); }
  set(buf, 4, 9, frame); set(buf, 7, 9, frame);
  set(buf, 4, 8, frame); set(buf, 7, 8, frame);
  for (const x of [10, 11]) { set(buf, x, 8, frame); set(buf, x, 10, frame); }
  set(buf, 9, 9, frame); set(buf, 12, 9, frame);
  set(buf, 9, 8, frame); set(buf, 12, 8, frame);
  set(buf, 8, 8, frame);
  set(buf, 3, 9, frame); set(buf, 13, 9, frame);
  set(buf, 4, 8, glint); set(buf, 9, 8, glint);
}

// ─── accessories (second wave: cheap, purely-additive overlays) ──────────────
// Drawn LAST in compose()/composeScene(), after clothing, head, hair, facial
// hair and glasses are already painted — a pure overlay that never touches any
// pixel unless `Recipe.accessory` is set, so all 15 fixed cast recipes (which
// never set it) render byte-identical to before this feature existed.
export type AccessoryKind = 'cap' | 'headphones' | 'earrings' | 'scarf' | 'lanyard' | 'watch';
export const ACCESSORY_OPTIONS: AccessoryKind[] = ['cap', 'headphones', 'earrings', 'scarf', 'lanyard', 'watch'];

/** Sensible default color per accessory kind, used when `Recipe.accessoryColor`
 *  is omitted — exported so the character-builder UI can seed its color picker
 *  with the same value the drawing engine would otherwise fall back to. */
export const ACCESSORY_DEFAULT_COLOR: Record<AccessoryKind, RGB> = {
  cap: [72, 96, 138],
  headphones: [42, 40, 46],
  earrings: [212, 175, 55],
  scarf: [176, 58, 58],
  lanyard: [70, 96, 150],
  watch: [206, 210, 220],
};

/** Baseball-cap crown + a short shaded brim, painted over the top of the head
 *  regardless of the hairstyle underneath (long styles keep flowing from the
 *  sides/back below the cap's edge). */
function drawCapFront(buf: Buf, color: RGB): void {
  const [hi, base] = shades(color);
  rect(buf, HX0, 1, HX1, 3, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 2, base);
  rect(buf, HX0 - 1, 3, HX1 + 1, 4, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  for (const x of [6, 7, 8]) set(buf, x, 1, hi);
  // Brim silhouette along the dome's front edge — sits above the eyebrows.
  const [, , brimSh] = shades(color, 1.22, 0.6);
  for (const x of [6, 7, 8, 9, 10, 11]) set(buf, x, 5, brimSh);
}

/** Back-of-head cap: same crown, no brim (not visible from behind), plus a
 *  small strap-adjuster mark for a bit of read at scene scale. */
function drawCapBack(buf: Buf, color: RGB): void {
  const [hi, base, sh] = shades(color);
  rect(buf, HX0, 1, HX1, 3, base);
  for (let x = HX0 - 1; x <= HX1 + 1; x++) set(buf, x, 2, base);
  rect(buf, HX0 - 1, 3, HX1 + 1, 4, base);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 5, base);
  for (const x of [8, 9]) set(buf, x, 1, hi);
  set(buf, 8, 5, sh); set(buf, 9, 5, sh);
}

/** Over-ear headphones: a band across the crown plus a cushion block at each
 *  ear, wide enough to read clearly over the character's own small ear bump.
 *  Symmetric front-to-back, so the same drawing works for both directions. */
function drawHeadphones(buf: Buf, color: RGB): void {
  const [hi, base, sh] = shades(color);
  for (let x = HX0; x <= HX1; x++) set(buf, x, 1, base);
  set(buf, HX0 - 1, 1, base); set(buf, HX1 + 1, 1, base);
  for (let y = 2; y <= 7; y++) { set(buf, HX0 - 1, y, base); set(buf, HX1 + 1, y, base); }
  for (const ex of [HX0 - 2, HX0 - 1]) rect(buf, ex, 8, ex, 11, base);
  for (const ex of [HX1 + 1, HX1 + 2]) rect(buf, ex, 8, ex, 11, base);
  set(buf, HX0 - 2, 9, hi); set(buf, HX1 + 2, 9, hi);
  set(buf, HX0 - 1, 11, sh); set(buf, HX1 + 1, 11, sh);
  for (const x of [7, 8, 9, 10]) if (alphaAt(buf, x, 1)) set(buf, x, 1, hi);
}

/** A single dangling stud below each ear — the cheapest possible accessory,
 *  front-only (hidden by the head from behind). */
function drawEarrings(buf: Buf, color: RGB): void {
  const [hi] = shades(color);
  set(buf, HX0 - 1, 12, hi);
  set(buf, HX1 + 1, 12, hi);
}

/** A wrap around the base of the neck, low enough to clear any cap/headphones
 *  at the head. Drawn identically for front and back (a scarf wraps all the
 *  way around) and at the same head-relative rows in both the portrait and
 *  the scene sprite, since the neck sits at a fixed height in both canvases. */
function drawScarf(buf: Buf, color: RGB): void {
  const [hi, base, sh] = shades(color);
  for (const x of [6, 7, 8, 9, 10, 11]) set(buf, x, 17, base);
  set(buf, 6, 17, sh); set(buf, 11, 17, sh);
  for (const x of [7, 8, 9, 10]) set(buf, x, 18, base);
  set(buf, 9, 19, hi); // a short hanging tail down the front
}

/** A badge on a neck strap, hanging over the chest — front-only (an office
 *  worker's ID badge). */
function drawLanyard(buf: Buf, color: RGB): void {
  const [hi, base] = shades(color);
  for (const y of [18, 19, 20]) { set(buf, 7, y, base); set(buf, 10, y, base); }
  const card: RGB = [244, 242, 238];
  rect(buf, 7, 21, 10, 24, card);
  rect(buf, 8, 22, 9, 23, hi);
}

/** A one-two pixel bright accent on the arm's outer sleeve edge, standing in
 *  for a wrist — the cheapest possible accessory, in the spirit of
 *  `drawEarrings`. Portrait and scene place the "wrist" at different rows
 *  (the scene torso sits higher, over legs), so this reads `CUR_H` to pick
 *  the right spot in whichever canvas is currently being composed. */
function drawWatch(buf: Buf, color: RGB): void {
  const [hi] = shades(color);
  if (CUR_H === SCENE_H) { set(buf, 4, 23, hi); set(buf, 4, 24, hi); }
  else { set(buf, 2, 26, hi); set(buf, 2, 27, hi); }
}

/** Dispatch for the accessory overlay — called once from compose() (portrait,
 *  always front) and once per frame from composeScene() (front AND back). */
function drawAccessory(buf: Buf, kind: AccessoryKind, color: RGB, back: boolean): void {
  if (kind === 'cap') { if (back) drawCapBack(buf, color); else drawCapFront(buf, color); return; }
  if (kind === 'headphones') { drawHeadphones(buf, color); return; }
  if (kind === 'earrings' && !back) drawEarrings(buf, color);
  if (kind === 'scarf') { drawScarf(buf, color); return; }
  if (kind === 'lanyard' && !back) drawLanyard(buf, color);
  if (kind === 'watch') { drawWatch(buf, color); return; }
}

// ─── clothing ────────────────────────────────────────────────────────────────
export type Cloth = 'suit' | 'dressshirt' | 'polo' | 'blouse' | 'cardigan' | 'sweater' | 'tshirt' | 'hoodie' | 'blazer';
export const CLOTH_KINDS: Cloth[] = ['suit', 'dressshirt', 'polo', 'blouse', 'cardigan', 'sweater', 'tshirt', 'hoodie', 'blazer'];
function bodyShape(buf: Buf, col: RGB, heavy = false): void {
  const [, base, sh] = shades(col);
  const rows: [number, number, number][] = heavy
    ? [[19, 5, 12], [20, 3, 14], [21, 2, 15], [22, 1, 16], [23, 1, 16], [24, 0, 17], [25, 0, 17], [26, 0, 17], [27, 0, 17]]
    : [[19, 6, 11], [20, 4, 13], [21, 3, 14], [22, 2, 15], [23, 2, 15], [24, 1, 16], [25, 1, 16], [26, 1, 16], [27, 1, 16]];
  for (const [y, a, b] of rows) rect(buf, a, y, b, y, base);
  const [lo, hi] = heavy ? [1, 16] : [2, 15];
  for (let y = 22; y < 28; y++) { set(buf, lo, y, sh); set(buf, hi, y, sh); }
}
function drawClothing(buf: Buf, kind: Cloth, c1: RGB, c2: RGB | undefined, tie: RGB | undefined, skin: string, heavy = false): void {
  const [hi, base, sh] = shades(c1);
  bodyShape(buf, c1, heavy);
  if (kind === 'suit') {
    const white: RGB = [238, 238, 236];
    for (const [x, y] of [[8, 19], [9, 19], [7, 20], [8, 20], [9, 20], [10, 20], [8, 21], [9, 21]] as const) set(buf, x, y, white);
    for (const [x, y] of [[6, 20], [7, 21], [11, 20], [10, 21], [6, 21], [11, 21]] as const) set(buf, x, y, sh);
    if (tie) { for (let y = 20; y < 26; y++) { set(buf, 8, y, tie); set(buf, 9, y, tie); } set(buf, 8, 20, shades(tie)[0]); }
    else for (let y = 22; y < 26; y++) { set(buf, 8, y, white); set(buf, 9, y, white); }
  } else if (kind === 'dressshirt') {
    for (const [x, y] of [[6, 19], [7, 19], [10, 19], [11, 19], [7, 20], [10, 20]] as const) set(buf, x, y, sh);
    for (let y = 20; y < 27; y += 2) set(buf, 8, y, sh);
    if (tie) for (let y = 19; y < 26; y++) { set(buf, 8, y, tie); set(buf, 9, y, tie); }
  } else if (kind === 'polo') {
    for (const [x, y] of [[6, 19], [7, 19], [10, 19], [11, 19]] as const) set(buf, x, y, hi);
    set(buf, 8, 20, sh); set(buf, 8, 22, sh);
    const accent = c2 ? shades(c2)[1] : hi;
    for (const [x, y] of [[7, 20], [9, 20]] as const) set(buf, x, y, accent);
  } else if (kind === 'blouse') {
    const s = SKIN[skin];
    for (const [x, y] of [[7, 19], [8, 19], [9, 19], [10, 19], [8, 20], [9, 20]] as const) set(buf, x, y, s.sh);
    for (let x = 5; x < 13; x++) if (eq(rgbAt(buf, x, 20), base)) set(buf, x, 20, hi);
  } else if (kind === 'cardigan') {
    const inner: RGB = c2 ? shades(c2)[1] : [235, 233, 226];
    for (let y = 19; y < 27; y++) { set(buf, 8, y, inner); set(buf, 9, y, inner); }
    for (const [x, y] of [[6, 19], [7, 19], [10, 19], [11, 19]] as const) set(buf, x, y, sh);
  } else if (kind === 'sweater') {
    for (const [x, y] of [[6, 19], [7, 19], [8, 19], [9, 19], [10, 19], [11, 19]] as const) set(buf, x, y, sh);
  } else if (kind === 'tshirt') {
    // Rounded crew neckline (no popped collar) plus a short-sleeve hem
    // highlight at the shoulder edge — reads more casual than a polo/sweater.
    for (const x of [7, 8, 9, 10]) set(buf, x, 19, sh);
    set(buf, 8, 20, hi); set(buf, 9, 20, hi);
    for (const [x, y] of [[6, 21], [11, 21]] as const) set(buf, x, y, hi);
  } else if (kind === 'hoodie') {
    // A hood pooling behind the neck: a raised collar wider than a normal
    // collar. Drawstrings hang from the neckline; a low seam hints at the
    // kangaroo pocket.
    for (const [x, y] of [[5, 20], [12, 20]] as const) set(buf, x, y, sh);
    for (const x of [6, 7, 10, 11]) set(buf, x, 19, sh);
    const string: RGB = c2 ? shades(c2)[0] : [235, 233, 226];
    set(buf, 7, 21, string); set(buf, 7, 22, string);
    set(buf, 10, 21, string); set(buf, 10, 22, string);
    for (let x = 6; x <= 11; x++) set(buf, x, 25, sh);
  } else if (kind === 'blazer') {
    // Notched lapels folding open from the collarbone in the jacket's own
    // light/dark shades (no shirt-white insert) — structured, dressier than a
    // suit worn without a tie. A single button anchors the front.
    for (const [x, y] of [[7, 19], [6, 20]] as const) set(buf, x, y, hi);
    for (const [x, y] of [[10, 19], [11, 20]] as const) set(buf, x, y, hi);
    set(buf, 8, 19, sh); set(buf, 9, 19, sh);
    for (const [x, y] of [[7, 21], [10, 21]] as const) set(buf, x, y, sh);
    const button: RGB = c2 ? shades(c2)[2] : sh;
    set(buf, 8, 23, button); set(buf, 9, 23, button);
  }
}
function collarNeck(buf: Buf, skin: string): void {
  rect(buf, 7, 18, 10, 19, SKIN[skin].sh);
}

// ─── scene body (full standing figure: torso + legs, front or back) ──────────
// Proportioned for standing (not the portrait bust): a narrower torso over real
// legs. Head (rows 2-16) sits above; this draws rows 18-31.
const SHOE: RGB = [44, 40, 48];

function drawSceneLegs(buf: Buf, pants: RGB, phase: number): void {
  const [, base, sh] = shades(pants);
  // two legs cols 5-7 / 10-12, gap at 8-9
  for (const [lx0, lx1] of [[5, 7], [10, 12]] as const) {
    rect(buf, lx0, 25, lx1, 30, base);
    for (let y = 25; y <= 30; y++) set(buf, lx1, y, sh); // inner shade
  }
  // feet — lift one foot per walk phase for a simple gait
  const leftLow = phase !== 1, rightLow = phase !== 2;
  rect(buf, 5, leftLow ? 31 : 30, 7, leftLow ? 31 : 30, SHOE);
  rect(buf, 10, rightLow ? 31 : 30, 12, rightLow ? 31 : 30, SHOE);
}

function drawSceneTorso(buf: Buf, r: Recipe, back: boolean): void {
  const [hi, base, sh] = shades(r.c1);
  // shoulders → torso, narrower than the portrait bust (wider + rounder if heavy)
  if (r.heavy) {
    rect(buf, 3, 18, 14, 18, base);
    rect(buf, 2, 19, 15, 19, base);
    rect(buf, 2, 20, 15, 24, base);
    for (let y = 20; y <= 24; y++) { set(buf, 2, y, sh); set(buf, 15, y, sh); set(buf, 14, y, sh); }
  } else {
    rect(buf, 4, 18, 13, 18, base);
    rect(buf, 3, 19, 14, 19, base);
    rect(buf, 4, 20, 13, 24, base);
    for (let y = 20; y <= 24; y++) { set(buf, 3, y, sh); set(buf, 14, y, sh); set(buf, 13, y, sh); } // arms / right shade
  }
  if (back) {
    // plain back with a collar line + center seam
    rect(buf, 6, 18, 11, 18, sh);
    for (let y = 19; y <= 24; y++) set(buf, 8, y, sh);
    return;
  }
  const skin = SKIN[r.skin];
  if (r.cloth === 'suit') {
    const white: RGB = [238, 238, 236];
    for (const [x, y] of [[8, 18], [9, 18], [7, 19], [8, 19], [9, 19], [10, 19], [8, 20], [9, 20]] as const) set(buf, x, y, white);
    for (const [x, y] of [[6, 19], [7, 20], [11, 19], [10, 20]] as const) set(buf, x, y, sh);
    if (r.tie) { for (let y = 19; y <= 24; y++) { set(buf, 8, y, r.tie); set(buf, 9, y, r.tie); } set(buf, 8, 19, shades(r.tie)[0]); }
  } else if (r.cloth === 'dressshirt') {
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18], [7, 19], [10, 19]] as const) set(buf, x, y, sh);
    if (r.tie) for (let y = 18; y <= 24; y++) { set(buf, 8, y, r.tie); set(buf, 9, y, r.tie); }
    else for (let y = 20; y <= 24; y += 2) set(buf, 8, y, sh);
  } else if (r.cloth === 'polo') {
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18]] as const) set(buf, x, y, hi);
    set(buf, 8, 19, sh); set(buf, 8, 21, sh);
  } else if (r.cloth === 'blouse') {
    for (const [x, y] of [[7, 18], [8, 18], [9, 18], [10, 18], [8, 19], [9, 19]] as const) set(buf, x, y, skin.sh);
    for (let x = 5; x < 13; x++) if (eq(rgbAt(buf, x, 19), base)) set(buf, x, 19, hi);
  } else if (r.cloth === 'cardigan') {
    const inner: RGB = r.c2 ? shades(r.c2)[1] : [235, 233, 226];
    for (let y = 18; y <= 24; y++) { set(buf, 8, y, inner); set(buf, 9, y, inner); }
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18]] as const) set(buf, x, y, sh);
  } else if (r.cloth === 'sweater') {
    for (const [x, y] of [[6, 18], [7, 18], [8, 18], [9, 18], [10, 18], [11, 18]] as const) set(buf, x, y, sh);
  } else if (r.cloth === 'tshirt') {
    for (const x of [7, 8, 9, 10]) set(buf, x, 18, sh);
    set(buf, 8, 19, hi); set(buf, 9, 19, hi);
    for (const [x, y] of [[6, 20], [11, 20]] as const) set(buf, x, y, hi);
  } else if (r.cloth === 'hoodie') {
    for (const [x, y] of [[5, 19], [12, 19]] as const) set(buf, x, y, sh);
    for (const x of [6, 7, 10, 11]) set(buf, x, 18, sh);
    const string: RGB = r.c2 ? shades(r.c2)[0] : [235, 233, 226];
    set(buf, 7, 20, string); set(buf, 7, 21, string);
    set(buf, 10, 20, string); set(buf, 10, 21, string);
    for (let x = 6; x <= 11; x++) set(buf, x, 24, sh);
  } else if (r.cloth === 'blazer') {
    for (const [x, y] of [[7, 18], [6, 19]] as const) set(buf, x, y, hi);
    for (const [x, y] of [[10, 18], [11, 19]] as const) set(buf, x, y, hi);
    set(buf, 8, 18, sh); set(buf, 9, 18, sh);
    for (const [x, y] of [[7, 20], [10, 20]] as const) set(buf, x, y, sh);
    const button: RGB = r.c2 ? shades(r.c2)[2] : sh;
    set(buf, 8, 22, button); set(buf, 9, 22, button);
  }
}

/** Back of the head: a rounded hair-covered skull with crown sheen + nape, no face. */
function drawHeadBack(buf: Buf, r: Recipe): void {
  const s = SKIN[r.skin];
  if (r.hair === 'styleBald') { drawHeadBackBald(buf, r); return; }
  const [hi, base, sh] = shades(r.hairc);
  // rounded skull silhouette (narrow at crown + nape, full through the middle)
  const rows: [number, number, number][] = [
    [2, 6, 11], [3, 5, 12], [4, 4, 13], [5, 4, 13], [6, 4, 13], [7, 4, 13], [8, 4, 13],
    [9, 4, 13], [10, 4, 13], [11, 4, 13], [12, 4, 13], [13, 5, 12], [14, 6, 11],
  ];
  for (const [y, a, b] of rows) rect(buf, a, y, b, y, base);
  // long styles drape down the sides past the head
  const len = r.hair === 'styleFrame' ? (r.hairargs?.length ?? 17)
            : r.hair === 'styleMessy' ? (r.hairargs?.length ?? 9) : 0;
  for (let y = 11; y <= len; y++) { set(buf, HX0 - 1, y, base); set(buf, HX0, y, base); set(buf, HX1, y, base); set(buf, HX1 + 1, y, base); }
  // roundness: darken the side edges and the nape
  for (let y = 4; y <= 12; y++) { set(buf, 4, y, sh); set(buf, 13, y, sh); }
  for (const [x, y] of [[5, 3], [12, 3], [5, 13], [12, 13], [6, 14], [11, 14]] as const) set(buf, x, y, sh);
  // crown sheen (rounded top catching the light) + subtle center part
  for (const [x, y] of [[7, 2], [8, 2], [9, 2], [10, 2], [7, 3], [8, 3], [9, 3]] as const) set(buf, x, y, hi);
  for (let y = 4; y <= 11; y++) set(buf, 9, y, hi);   // sheen down the crown
  for (let y = 4; y <= 12; y++) set(buf, 8, y, sh);   // part line
  // nape + neck (skin)
  rect(buf, 7, 14, 10, 14, sh);
  rect(buf, 7, 15, 10, 17, s.sh);
  rect(buf, 7, 15, 9, 15, s.base);
}

/** Back of a bald head: a skin skull with a sheen and a low hair fringe ring. */
function drawHeadBackBald(buf: Buf, r: Recipe): void {
  const s = SKIN[r.skin];
  const [shi, sbase, ssh] = shades(s.base, 1.1, 0.82);
  const rows: [number, number, number][] = [
    [2, 6, 11], [3, 5, 12], [4, 4, 13], [5, 4, 13], [6, 4, 13], [7, 4, 13], [8, 4, 13],
    [9, 4, 13], [10, 4, 13], [11, 4, 13], [12, 4, 13], [13, 5, 12], [14, 6, 11],
  ];
  for (const [y, a, b] of rows) rect(buf, a, y, b, y, sbase);
  for (let y = 4; y <= 12; y++) { set(buf, 4, y, ssh); set(buf, 13, y, ssh); }
  for (const [x, y] of [[7, 2], [8, 2], [9, 2], [8, 3], [9, 4], [9, 5]] as const) set(buf, x, y, shi);
  // low hair fringe ring around the back/sides
  const [, base, sh] = shades(r.hairc);
  for (let x = 4; x <= 13; x++) { set(buf, x, 11, base); set(buf, x, 12, base); }
  for (const x of [4, 13]) { set(buf, x, 11, sh); set(buf, x, 12, sh); }
  // nape + neck (skin)
  rect(buf, 7, 14, 10, 14, s.sh);
  rect(buf, 7, 15, 10, 17, s.sh);
  rect(buf, 7, 15, 9, 15, s.base);
}

function drawSceneBody(buf: Buf, r: Recipe, phase: number, back: boolean): void {
  drawSceneTorso(buf, r, back);
  drawSceneLegs(buf, defaultPants(r), phase);
}

// ─── outline pass ────────────────────────────────────────────────────────────
function outlinePass(buf: Buf): void {
  const pts: [number, number][] = [];
  for (let y = 0; y < CUR_H; y++) {
    for (let x = 0; x < CUR_W; x++) {
      if (alphaAt(buf, x, y) !== 0) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (alphaAt(buf, x + dx, y + dy) === 255) { pts.push([x, y]); break; }
      }
    }
  }
  for (const [x, y] of pts) set(buf, x, y, OUTLINE);
}

// ─── recipes ─────────────────────────────────────────────────────────────────
/** The full parametric description of a character: every knob the drawing
 *  primitives below understand. `paintPortrait`/`sceneFrameBufs` resolve one of
 *  these from the fixed `RECIPES` map by `OfficeCharacterName`;
 *  `paintPortraitFromRecipe`/`sceneFrameBufsFromRecipe` accept one directly, so
 *  a custom character (built from the same knobs) renders through the exact
 *  same drawing code as the 15 fixed cast members. */
export interface Recipe {
  skin: string; hairc: RGB; hair: HairStyle; hairargs?: HairArgs;
  cloth: Cloth; c1: RGB; c2?: RGB; tie?: RGB; pants?: RGB;
  brow?: Brow; mouth?: Mouth; blush?: boolean; facial?: Facial;
  /** Glasses style. Omitted (like `facial`) means no glasses at all — there is
   *  no separate on/off flag. */
  glasses?: GlassesKind;
  /** Bigger, lashed eyes for a more feminine, expressive face. */
  lashes?: boolean;
  /** Heavier build: chubby cheeks, a double chin, and a wider torso. */
  heavy?: boolean;
  /** Optional cosmetic accessory (cap / headphones / earrings / scarf / lanyard
   *  / watch), drawn last as a pure overlay — omitting it renders byte-identical
   *  to before this field existed, so it never affects the 15 fixed cast
   *  recipes above. */
  accessory?: AccessoryKind;
  /** Accent color for the accessory. Falls back to ACCESSORY_DEFAULT_COLOR[kind]
   *  when omitted. */
  accessoryColor?: RGB;
}

// Puff the lower face into round cheeks + a double chin so a character reads as
// heavier. Runs after drawHead (adds skin at the jaw) and is safe before the
// face features, which sit higher (eyes y9, mouth y14).
function drawHeavyFace(buf: Buf, skin: string): void {
  const s = SKIN[skin];
  // Chubby cheeks: bulge the jaw outward past the normal x4..13 head box.
  for (let y = 11; y <= 15; y++) { set(buf, HX0 - 1, y, s.base); set(buf, HX1 + 1, y, s.base); }
  set(buf, HX0 - 1, 15, s.sh); set(buf, HX1 + 1, 15, s.sh);
  // Fuller, rounder lower jaw.
  for (const x of [5, 6, 11, 12]) set(buf, x, 16, s.base);
  // Double chin: a second rounded roll under the jaw.
  rect(buf, 6, 17, 11, 18, s.base);
  for (const x of [6, 7, 8, 9, 10, 11]) set(buf, x, 18, s.sh);
  set(buf, 7, 17, s.sh); set(buf, 10, 17, s.sh); // crease shadow between chin + roll
}

const RECIPES: Record<OfficeCharacterName, Recipe> = {
  michael:  { skin: 'light', hairc: [58, 42, 28],   hair: 'styleShort',  hairargs: { part: 'L' }, cloth: 'suit', c1: [58, 63, 74], tie: [170, 58, 58], brow: 'flat', mouth: 'smile' },
  jim:      { skin: 'light', hairc: [92, 60, 34],   hair: 'styleFloppy', cloth: 'dressshirt', c1: [172, 196, 224], tie: [120, 130, 150], brow: 'flat', mouth: 'smile' },
  pam:      { skin: 'light', hairc: [120, 76, 42],  hair: 'styleFrame',  hairargs: { length: 18, vol: 2 }, cloth: 'cardigan', c1: [236, 174, 192], c2: [244, 242, 238], brow: 'soft', mouth: 'smile', blush: true, lashes: true },
  dwight:   { skin: 'light', hairc: [64, 48, 28],   hair: 'styleShort',  hairargs: { part: 'L', recede: 1 }, cloth: 'dressshirt', c1: [184, 155, 62], tie: [120, 82, 46], glasses: 'round', brow: 'angry', mouth: 'neutral' },
  kevin:    { skin: 'light', hairc: [58, 44, 30],   hair: 'styleBald',   cloth: 'polo', c1: [110, 140, 180], c2: [90, 120, 160], brow: 'flat', mouth: 'neutral', heavy: true },
  angela:   { skin: 'light', hairc: [186, 154, 90], hair: 'styleBun',    cloth: 'cardigan', c1: [150, 146, 170], c2: [235, 233, 226], brow: 'angry', mouth: 'frown', lashes: true },
  oscar:    { skin: 'tan',   hairc: [28, 22, 18],   hair: 'styleShort',  hairargs: { part: 'L' }, cloth: 'sweater', c1: [122, 60, 74], brow: 'flat', mouth: 'smile' },
  stanley:  { skin: 'dark',  hairc: [60, 54, 48],   hair: 'styleRecede', cloth: 'dressshirt', c1: [150, 120, 86], tie: [120, 78, 52], glasses: 'round', facial: 'mustache', brow: 'flat', mouth: 'neutral', heavy: true },
  phyllis:  { skin: 'light', hairc: [196, 162, 110], hair: 'styleCurly', cloth: 'blouse', c1: [202, 160, 192], glasses: 'round', brow: 'soft', mouth: 'smile', lashes: true, heavy: true },
  andy:     { skin: 'light', hairc: [74, 51, 32],   hair: 'styleShort',  hairargs: { part: 'R' }, cloth: 'polo', c1: [176, 65, 58], c2: [150, 50, 46], brow: 'raised', mouth: 'smile' },
  kelly:    { skin: 'tan',   hairc: [24, 18, 22],   hair: 'styleFrame',  hairargs: { length: 20, vol: 1 }, cloth: 'blouse', c1: [212, 90, 158], brow: 'soft', mouth: 'smile', blush: true, lashes: true },
  ryan:     { skin: 'light', hairc: [42, 32, 24],   hair: 'styleSpiky',  cloth: 'suit', c1: [58, 58, 68], tie: [40, 40, 50], brow: 'flat', mouth: 'neutral' },
  toby:     { skin: 'light', hairc: [106, 90, 66],  hair: 'styleShort',  hairargs: { part: 'L', recede: 1 }, cloth: 'dressshirt', c1: [150, 150, 120], facial: 'mustacheSm', brow: 'soft', mouth: 'frown' },
  creed:    { skin: 'light', hairc: [170, 166, 156], hair: 'styleBald',   cloth: 'dressshirt', c1: [126, 130, 96], facial: 'stubble', brow: 'flat', mouth: 'neutral' },
  meredith: { skin: 'light', hairc: [154, 82, 46],  hair: 'styleMessy',  hairargs: { length: 15 }, cloth: 'blouse', c1: [176, 86, 74], brow: 'raised', mouth: 'smile', lashes: true },
};

/** A COPY of one fixed cast member's recipe, or undefined for a name that is not
 *  one of the fifteen (e.g. a `custom:<uuid>` id).
 *
 *  Exists so a caller that wants to DERIVE a new look from an existing character
 *  — the appearance proposals in store/lookProposal.ts — has a base to start
 *  from. It hands back a deep-enough copy (the RGB tuples are the only nested
 *  values) precisely because that caller's whole job is to modify what it gets:
 *  handing out the live table would let a cosmetic tweak silently repaint one of
 *  the fifteen fixed characters for every agent wearing it. */
export function recipeForFixedCharacter(name: string): Recipe | undefined {
  const r = RECIPES[name as OfficeCharacterName];
  if (!r) return undefined;
  const rgb = (v: RGB | undefined): RGB | undefined => (v ? [v[0], v[1], v[2]] : undefined);
  return {
    ...r,
    hairc: rgb(r.hairc)!,
    c1: rgb(r.c1)!,
    c2: rgb(r.c2),
    tie: rgb(r.tie),
    pants: rgb(r.pants),
    accessoryColor: rgb(r.accessoryColor),
    hairargs: r.hairargs ? { ...r.hairargs } : undefined
  };
}

/** The face/hair group (head → face → facial hair → hair → glasses), no clothing. */
function drawHeadGroup(buf: Buf, r: Recipe): void {
  const skinBase = SKIN[r.skin].base;
  drawHead(buf, r.skin);
  if (r.heavy) drawHeavyFace(buf, r.skin);
  drawFace(buf, r.skin, r.brow ?? 'flat', r.mouth ?? 'neutral', r.blush ?? false, r.lashes ?? false);
  if (r.facial) drawFacial(buf, r.facial, r.hairc);
  HAIR_FNS[r.hair](buf, r.hairc, skinBase, r.hairargs ?? {});
  if (r.glasses) drawGlasses(buf, r.glasses);
}

function defaultPants(r: Recipe): RGB {
  if (r.pants) return r.pants;
  return r.cloth === 'suit' ? shades(r.c1)[2] : [54, 56, 70];
}

/** Portrait bust: shoulders-height clothing + front head group. */
function compose(r: Recipe): Buf {
  CUR_W = PORTRAIT_W; CUR_H = PORTRAIT_H;
  const buf = new Uint8ClampedArray(PORTRAIT_W * PORTRAIT_H * 4);
  drawClothing(buf, r.cloth, r.c1, r.c2, r.tie, r.skin, r.heavy ?? false);
  collarNeck(buf, r.skin);
  drawHeadGroup(buf, r);
  if (r.accessory) drawAccessory(buf, r.accessory, r.accessoryColor ?? ACCESSORY_DEFAULT_COLOR[r.accessory], false);
  outlinePass(buf);
  return buf;
}

/** Full-body 18×32 scene sprite. `back=false` reuses the portrait's exact face. */
function composeScene(r: Recipe, phase: number, back: boolean): Buf {
  CUR_W = SCENE_W; CUR_H = SCENE_H;
  const buf = new Uint8ClampedArray(SCENE_W * SCENE_H * 4);
  drawSceneBody(buf, r, phase, back);
  if (back) drawHeadBack(buf, r);
  else drawHeadGroup(buf, r);
  if (r.accessory) drawAccessory(buf, r.accessory, r.accessoryColor ?? ACCESSORY_DEFAULT_COLOR[r.accessory], back);
  outlinePass(buf);
  return buf;
}

// ─── public render ───────────────────────────────────────────────────────────
// Both the fixed 15-character roster (by `OfficeCharacterName`) and arbitrary
// user-built recipes render through the exact same compose()/composeScene()
// calls and the exact same caches below — a fixed name is just sugar for
// `RECIPES[name]` used as the cache key, so the 15 existing characters keep
// rendering byte-identically to before this module gained a recipe-based API.
const bufCache = new Map<string, Buf>();
const sceneCache = new Map<string, SceneFrames>();

/** Cheap, non-cryptographic string hash (cyrb53) over a recipe's JSON — just
 *  enough to key the render caches so an identical custom recipe (e.g. redrawn
 *  every frame for a live preview) is composed once, not on every call. */
export function hashRecipe(r: Recipe): string {
  const s = JSON.stringify(r);
  let h1 = 0xdeadbeef ^ s.length, h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function getBufForRecipe(key: string, r: Recipe): Buf {
  let buf = bufCache.get(key);
  if (!buf) {
    buf = compose(r);
    bufCache.set(key, buf);
  }
  return buf;
}

function getBuf(name: OfficeCharacterName): Buf {
  return getBufForRecipe(name, RECIPES[name] ?? RECIPES.jim);
}

export interface SceneFrames { front: Buf[]; back: Buf[]; }

function getSceneForRecipe(key: string, r: Recipe): SceneFrames {
  let frames = sceneCache.get(key);
  if (!frames) {
    frames = {
      front: [composeScene(r, 0, false), composeScene(r, 1, false), composeScene(r, 2, false)],
      back: [composeScene(r, 0, true), composeScene(r, 1, true), composeScene(r, 2, true)],
    };
    sceneCache.set(key, frames);
  }
  return frames;
}

/** Walk-phase frames (stand, step-L, step-R) for the in-scene sprite, front + back. */
export function sceneFrameBufs(name: OfficeCharacterName): SceneFrames {
  return getSceneForRecipe(name, RECIPES[name] ?? RECIPES.jim);
}

/** Same as `sceneFrameBufs`, for an arbitrary (e.g. user-built) recipe rather
 *  than a fixed cast name. Cached by a hash of the recipe's contents. */
export function sceneFrameBufsFromRecipe(recipe: Recipe): SceneFrames {
  return getSceneForRecipe(hashRecipe(recipe), recipe);
}

/** Stage `buf` (a PORTRAIT_W×PORTRAIT_H RGBA buffer) at 1× on an offscreen
 *  canvas, then blit it onto `ctx` scaled with smoothing off — the actual
 *  pixel-art blit shared by both public paint functions below. */
function blitPortrait(ctx: CanvasRenderingContext2D, buf: Buf, scale: number): void {
  const stage = document.createElement('canvas');
  stage.width = PORTRAIT_W; stage.height = PORTRAIT_H;
  const sctx = stage.getContext('2d')!;
  const img = sctx.createImageData(PORTRAIT_W, PORTRAIT_H);
  img.data.set(buf);
  sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, PORTRAIT_W * scale, PORTRAIT_H * scale);
  ctx.drawImage(stage, 0, 0, PORTRAIT_W, PORTRAIT_H, 0, 0, PORTRAIT_W * scale, PORTRAIT_H * scale);
}

/** Paint a character's procedural portrait onto `ctx`, nearest-neighbor at `scale`. */
export function paintPortrait(ctx: CanvasRenderingContext2D, name: OfficeCharacterName, scale = 2): void {
  blitPortrait(ctx, getBuf(name), scale);
}

/** Same as `paintPortrait`, for an arbitrary (e.g. user-built) recipe rather
 *  than a fixed cast name. Synchronous and cheap enough to call on every
 *  keystroke of a live builder preview — cached by a hash of the recipe. */
export function paintPortraitFromRecipe(ctx: CanvasRenderingContext2D, recipe: Recipe, scale = 2): void {
  blitPortrait(ctx, getBufForRecipe(hashRecipe(recipe), recipe), scale);
}
