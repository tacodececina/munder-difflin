// Office-only procedural furniture. Whole silhouettes are drawn BEFORE slicing
// into 16px cells: no tile edge can introduce a seam in a desk or a display.
// No random noise, gradients, antialiasing or external artwork. Light is NW;
// ramps and mixing are the same vocabulary as tileArt / isoTileArt.
import { setPx, shades, mix, TILE_PALETTES, type RGB, type TilePalette } from './tileArt';

type Buf = Uint8ClampedArray;
export const TECH_PALETTE_KEY = 'office-tech';
export const TECH_CELL = 16;
export const TECH_COLUMNS = 16;

// Dimensions in tiles. IDs below 513 are reserved for the engine's monitors.
const sizes = {
  floor: [2, 2], carpet: [2, 2], timber: [2, 2],
  wall: [1, 3], sideWall: [1, 1], glass: [1, 3],
  screen: [14, 4], whiteboard: [6, 3], server: [3, 5], network: [3, 5],
  bench: [11, 3], console: [11, 3], corner: [5, 4], standing: [4, 3],
  island: [8, 5], meeting: [8, 4], chair: [1, 2], chairNorth: [1, 2],
  sofa: [5, 3], armchair: [2, 3], planter: [3, 3], plant: [2, 3],
  cafeTable: [2, 1], coffee: [7, 4], fridge: [2, 4], shelf: [3, 3],
  reception: [6, 3], cable: [4, 1], cooler: [1, 3], bin: [1, 2],
  window: [5, 2], rug: [6, 3], signOps: [5, 1], signLab: [5, 1],
  signDeploy: [5, 1], signBreak: [5, 1], signMeet: [5, 1], signEntry: [6, 1],
} as const;
export type TechProp = keyof typeof sizes;
export interface TechPiece { gid: number; w: number; h: number }
let nextGid = 513;
export const TECH_PIECES = Object.fromEntries(Object.entries(sizes).map(([key, [w, h]]) => {
  const piece = { gid: nextGid, w, h };
  nextGid += w * h;
  return [key, piece];
})) as Record<TechProp, TechPiece>;
export const TECH_TILECOUNT = Math.ceil((nextGid - 1) / TECH_COLUMNS) * TECH_COLUMNS;
export const TECH_ATLAS_META = {
  firstgid: 1, image: 'procedural:tech-office', imagewidth: TECH_COLUMNS * TECH_CELL,
  imageheight: TECH_TILECOUNT / TECH_COLUMNS * TECH_CELL,
  tilewidth: TECH_CELL, tileheight: TECH_CELL, columns: TECH_COLUMNS, tilecount: TECH_TILECOUNT,
};
export function techGid(key: TechProp, x = 0, y = 0): number {
  const p = TECH_PIECES[key];
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) throw new Error(`Invalid ${key} cell ${x},${y}`);
  return p.gid + y * p.w + x;
}

// A small fixed pixel alphabet; labels are physical signs and instrument UI,
// not a second typography system. All strokes form connected pixel clusters.
const FONT: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011',
  D: '110101101101110', E: '111100110100111', F: '111100110100100',
  G: '011100101101011', H: '101101111101101', I: '111010010010111',
  J: '001001001101010', K: '101101110101101', L: '100100100100111',
  M: '101111111101101', N: '101111111111101', O: '010101101101010',
  P: '110101110100100', Q: '010101101111011', R: '110101110101101',
  S: '011100010001110', T: '111010010010010', U: '101101101101111',
  V: '101101101101010', W: '101101111111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111',
  '0': '111101101101111', '1': '010110010010111', '2': '110001010100111',
  '3': '110001010001110', '4': '101101111001001', '5': '111100110001110',
  '6': '011100111101111', '7': '111001010010010', '8': '111101111101111',
  '9': '111101111001110', '/': '001001010100100', '-': '000000111000000',
  ':': '000010000010000', '.': '000000000000010', ' ': '000000000000000',
};

/** A raw RGBA buffer plus its size — what every draw function in this file
 *  returns, and what `buildTechOfficeAtlas` slices into tiles. */
export interface PixelBuffer { data: Buf; width: number; height: number }

/** The two pixel primitives, lifted out of `drawTechProp`'s closure so the LIVE
 *  wall surfaces below (drawn on every data change, not baked into the atlas)
 *  stamp letters and blocks through exactly the same code as the furniture. */
function rectOn(buf: PixelBuffer, x: number, y: number, rw: number, rh: number, c: RGB, a = 255): void {
  for (let py = Math.max(0, y); py < Math.min(buf.height, y + rh); py++)
    for (let px = Math.max(0, x); px < Math.min(buf.width, x + rw); px++) setPx(buf.data, buf.width, px, py, c, a);
}
function textOn(buf: PixelBuffer, s: string, x: number, y: number, c: RGB, scale = 1): void {
  for (const ch of s) {
    const pixels = FONT[ch] ?? FONT[' '];
    for (let i = 0; i < 15; i++)
      if (pixels[i] === '1') rectOn(buf, x + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale, scale, c);
    x += 4 * scale;
  }
}
/** Width in pixels of `s` in the prop alphabet, trailing gap included — the
 *  measurement every "does this fit in the column?" decision below is made on. */
export function techTextWidth(s: string, scale = 1): number {
  return s.length * 4 * scale;
}

export function drawTechProp(key: TechProp | 'monitorOff' | 'monitorOn' | 'monitorBack' | 'monitorBackOn', pal: TilePalette): PixelBuffer {
  const [wt, ht] = key === 'monitorOff' || key === 'monitorOn' || key === 'monitorBack' || key === 'monitorBackOn' ? [2, 2] : sizes[key];
  const w = wt * TECH_CELL, h = ht * TECH_CELL;
  const data = new Uint8ClampedArray(w * h * 4);
  const buf: PixelBuffer = { data, width: w, height: h };
  const [hi, steel, dark] = shades(pal.wall.base, 1.14, 0.8);
  const ink = shades(pal.floor.mortar, 1.16, 0.72)[2];
  const surface = mix(pal.wall.base, pal.floor.fleck, 0.3);
  const accent = pal.wall.line;
  const muted = mix(steel, accent, 0.32);
  const paper = mix(pal.floor.fleck, [255, 255, 255], 0.55);
  const wood = pal.floor.fleck;
  const shadow = mix(ink, pal.floor.base, 0.35);
  function rect(x: number, y: number, rw: number, rh: number, c: RGB, a = 255) {
    rectOn(buf, x, y, rw, rh, c, a);
  }
  function text(s: string, x: number, y: number, c = paper, scale = 1) {
    textOn(buf, s, x, y, c, scale);
  }
  function panel(x: number, y: number, rw: number, rh: number, c = steel) {
    rect(x + 2, y + 3, rw, rh, shadow, 180);
    rect(x, y, rw, rh, ink);
    rect(x + 1, y + 1, rw - 2, rh - 2, c);
    rect(x + 1, y + 1, rw - 2, 1, hi);
    rect(x + 1, y + 1, 1, rh - 2, hi);
    rect(x + 2, y + rh - 3, rw - 3, 2, dark);
  }
  function desk(x: number, y: number, rw: number, rh: number, c = surface) {
    rect(x + 4, y + rh, rw - 2, 5, shadow, 185);
    rect(x + 4, y + rh - 1, 3, 7, ink);
    rect(x + rw - 6, y + rh - 1, 3, 7, ink);
    rect(x + 3, y + rh - 4, rw - 5, 4, dark);
    rect(x, y + 2, rw, rh - 4, ink);
    rect(x + 2, y, rw - 4, rh - 2, ink);
    rect(x + 2, y + 2, rw - 4, rh - 6, c);
    rect(x + 3, y + 3, rw - 6, 2, mix(c, hi, 0.2));
    rect(x + 3, y + 1, rw - 6, 1, hi);
    rect(x + 1, y + 3, 1, rh - 8, hi);
    rect(x + 2, y + rh - 4, rw - 4, 2, dark);
    rect(x + 5, y + rh - 2, rw - 10, 2, mix(c, dark, 0.6));
  }
  function foliage(x: number, y: number) {
    const leaf = mix(accent, wood, 0.5), leafShade = shades(leaf, 1.14, 0.72)[2];
    rect(x + 7, y + 4, 2, 25, leafShade);
    for (const [lx, ly, side] of [[4, 1, 1], [0, 7, 1], [9, 5, -1], [2, 14, 1], [9, 13, -1]]) {
      rect(x + lx + 1, y + ly, 4, 2, leaf);
      rect(x + lx, y + ly + 2, 6, 4, leafShade);
      rect(x + lx + 1, y + ly + 1, 4, 3, leaf);
      rect(x + lx + 2, y + ly + 5, 3, 3, leafShade);
      rect(x + lx + (side > 0 ? 4 : 0), y + ly + 6, 3, 3, leafShade);
    }
  }

  switch (key) {
    case 'floor': case 'carpet': case 'timber': {
      const base = key === 'timber' ? mix(wood, pal.floor.base, 0.78)
        : key === 'carpet' ? shades(pal.floor.base, 1.16, 0.86)[2] : pal.floor.base;
      rect(0, 0, w, h, base);
      // Continuous 32px panel; a join on east/south only. No checkerboard
      // brightness shifts, no isolated flecks fighting the furniture.
      if (key === 'floor') {
        rect(w - 1, 0, 1, h, mix(base, pal.floor.mortar, 0.32));
        rect(0, h - 1, w, 1, mix(base, pal.floor.mortar, 0.32));
      } else if (key === 'timber') {
        for (let y = 7; y < h; y += 8) rect(0, y, w, 1, mix(base, pal.floor.mortar, 0.3));
        rect(15, 0, 1, 7, dark); rect(4, 16, 1, 7, dark);
      } else {
        for (let y = 3; y < h; y += 8) for (let x = (y % 16 ? 2 : 6); x < w; x += 8)
          rect(x, y, 2, 1, mix(base, steel, 0.12));
      }
      break;
    }
    case 'wall':
      rect(0, 0, w, h, dark); rect(0, 0, w, 3, hi);
      rect(0, 4, w, 3, ink); rect(0, 7, w, 35, steel);
      rect(0, 40, w, 3, dark); rect(0, 43, w, 2, muted); rect(0, 45, w, 3, ink);
      break;
    case 'sideWall':
      rect(0, 0, 7, h, ink); rect(1, 0, 2, h, hi); rect(3, 0, 3, h, steel);
      break;
    case 'glass':
      rect(3, 0, 3, h, ink); rect(3, 0, 1, h, hi); rect(6, 0, 5, h, muted, 95);
      rect(8, 0, 1, h, accent, 130); rect(3, 28, 8, 2, hi); rect(3, 45, 8, 3, dark);
      break;
    case 'screen': {
      // CHROME ONLY. What used to live inside this glass — a "99.98 UPTIME", a
      // service topology naming API / CORE / DB / CI, and a nine-bar chart
      // whose heights were a literal array two lines down — was invented, and
      // an invented instrument is worse than no instrument. The bezel, the
      // glass, the sign and the rules are stage furniture and stay baked; the
      // readings are drawn LIVE over OPS_READOUT_RECT by drawOpsReadout, from
      // the breaker beat, the ledger's event log and the `gh` CLI.
      panel(1, 1, w - 4, h - 5, dark);
      rect(5, 5, w - 12, h - 14, ink);
      text('OPERATIONS / LIVE', 11, 9, accent);
      rect(10, 20, w - 26, 1, dark);
      rect(6, h - 8, w - 16, 1, accent); break;
    }
    case 'whiteboard': {
      // CHROME ONLY, same reasoning as the screen: the four sticky notes that
      // used to hang under this header stood for no card on any board. The
      // header is a real heading written on a real board and stays; the notes
      // and the column rules are drawn live over PLAN_READOUT_RECT by
      // drawPlanReadout, one note per card in hive/tasks.json.
      panel(2, 2, w - 5, h - 9, paper);
      rect(6, 7, w - 13, 2, dark); text('PLAN / BUILD / SHIP', 9, 12, dark);
      rect(4, h - 7, w - 9, 3, dark); rect(w - 22, h - 9, 10, 2, accent); break;
    }
    case 'server': case 'network': {
      panel(2, 2, w - 7, h - 6, dark);
      rect(6, 9, w - 17, h - 18, ink); rect(w - 10, 9, 2, h - 18, steel);
      text(key === 'server' ? 'R01' : 'NET', 9, 5, paper);
      for (let i = 0; i < 6; i++) {
        const y = 16 + i * 8;
        rect(9, y, 24, 6, steel); rect(10, y + 1, 22, 1, hi);
        rect(12, y + 3, 12, 2, ink); rect(28, y + 2, 3, 2, i === 4 ? wood : accent);
        if (key === 'network') {
          rect(12, y + 3, 3, 2, muted); rect(18, y + 3, 3, 2, muted);
          rect(34, y, 3, 6, muted);
        }
      }
      rect(7, 71, 28, 2, ink); rect(5, 76, 6, 3, ink); rect(32, 76, 6, 3, ink); break;
    }
    case 'bench': case 'console':
      desk(1, 14, w - 3, 27);
      rect(8, 16, w - 19, 3, ink); rect(9, 16, w - 21, 1, muted);
      if (key === 'console') {
        rect(4, 12, 12, 23, dark); rect(w - 18, 12, 12, 23, dark);
        rect(6, 13, 8, 2, accent); rect(w - 16, 13, 8, 2, accent);
        text('OPS', w - 38, 35, muted);
      } else {
        rect(w - 28, 21, 12, 9, wood); rect(w - 27, 22, 9, 1, paper);
        rect(w / 2, 35, 2, 6, ink);
      }
      break;
    case 'corner':
      desk(1, 14, w - 3, 27, wood); desk(w - 23, 31, 21, 26, wood);
      rect(w - 22, 31, 18, 6, wood); rect(w - 16, 42, 8, 5, dark);
      rect(w - 15, 43, 5, 1, paper);
      rect(6, 33, 12, 3, mix(wood, dark, 0.5)); rect(10, 34, 5, 1, hi); break;
    case 'standing':
      desk(1, 14, w - 3, 18);
      rect(8, 31, 3, 13, hi); rect(w - 13, 31, 3, 13, steel);
      rect(4, 44, 14, 3, ink); rect(w - 20, 44, 14, 3, ink);
      rect(w - 20, 30, 10, 3, dark); rect(w - 17, 30, 4, 2, accent); break;
    case 'island':
      desk(1, 12, w - 3, 60);
      rect(3, 39, w - 7, 5, ink); rect(4, 39, w - 9, 1, muted);
      rect(61, 15, 2, 53, dark);
      // Recessed cable spine joins the four working surfaces.
      rect(13, 40, 34, 2, accent); rect(80, 40, 32, 2, muted); break;
    case 'meeting':
      desk(4, 9, w - 9, 45, wood);
      rect(56, 23, 17, 12, ink); rect(58, 25, 13, 7, steel); rect(62, 28, 5, 2, accent);
      rect(22, 21, 15, 10, paper); rect(24, 24, 10, 1, muted); rect(24, 27, 6, 1, muted);
      rect(88, 34, 16, 8, dark); rect(90, 35, 12, 5, muted); break;
    case 'monitorOff': case 'monitorOn':
      rect(2, 3, 28, 17, ink); rect(3, 3, 26, 1, hi); rect(2, 4, 1, 14, steel);
      rect(4, 5, 24, 12, key === 'monitorOn' ? muted : dark);
      rect(5, 6, 9, 2, key === 'monitorOn' ? accent : steel);
      rect(14, 20, 4, 3, dark); rect(10, 23, 12, 2, ink);
      rect(3, 26, 19, 5, dark); rect(4, 26, 17, 1, hi); rect(5, 28, 14, 1, steel);
      rect(26, 26, 4, 5, muted); break;
    case 'monitorBack': case 'monitorBackOn':
      // No vertical flip: the rear casing has its own NW highlight, with
      // keyboard on the sitter's (north) side and vents facing the viewer.
      rect(4, 14, 19, 4, dark); rect(5, 14, 17, 1, hi); rect(6, 16, 14, 1, steel);
      rect(27, 14, 4, 4, muted); rect(13, 18, 5, 3, ink);
      rect(2, 20, 28, 12, ink); rect(3, 21, 26, 10, steel);
      rect(3, 21, 26, 1, hi); rect(3, 22, 1, 8, hi);
      rect(8, 24, 17, 2, dark); rect(8, 28, 17, 2, dark);
      rect(25, 29, 3, 2, key === 'monitorBackOn' ? accent : dark); break;
    case 'chair': case 'chairNorth':
      rect(7, 22, 2, 6, ink); rect(2, 28, 13, 2, ink);
      panel(2, 8, 12, 14, dark); rect(4, 11, 8, 6, muted);
      rect(1, 15, 2, 8, ink); rect(14, 15, 2, 8, ink);
      rect(4, key === 'chair' ? 20 : 7, 8, 5, steel);
      rect(5, key === 'chair' ? 20 : 7, 6, 1, hi); break;
    case 'sofa': case 'armchair':
      panel(1, 7, w - 4, h - 14, dark);
      rect(5, 10, w - 13, 9, muted); rect(6, 10, w - 16, 2, hi);
      for (let x = 8; x < w - 10; x += 22) {
        rect(x, 23, Math.min(20, w - 11 - x), 13, steel);
        rect(x, 23, Math.min(20, w - 11 - x), 1, hi);
      }
      rect(3, 20, 5, 19, dark); rect(w - 11, 20, 6, 19, dark);
      rect(10, h - 7, 4, 4, ink); rect(w - 18, h - 7, 4, 4, ink); break;
    case 'plant': case 'planter':
      panel(3, 29, w - 7, 14, dark); rect(5, 30, w - 12, 4, ink);
      foliage(5, 3); if (key === 'planter') foliage(25, 6);
      rect(5, 39, w - 12, 1, muted); break;
    case 'cafeTable':
      desk(1, 1, w - 3, 11, wood); break;
    case 'coffee':
      desk(1, 34, w - 3, 23, wood);
      panel(4, 6, 28, 34, dark); rect(8, 10, 19, 6, muted);
      text('BREW', 10, 11, ink); rect(10, 21, 15, 12, ink);
      rect(14, 25, 7, 7, paper); rect(7, 36, 22, 2, steel);
      panel(41, 23, 14, 17, steel); rect(45, 20, 6, 4, paper);
      rect(69, 39, 29, 12, dark); rect(72, 41, 23, 7, muted);
      rect(90, 32, 3, 11, hi); rect(84, 32, 7, 2, hi);
      rect(39, 58, 1, 5, dark); rect(69, 58, 1, 5, dark); break;
    case 'fridge':
      panel(2, 3, w - 5, h - 7, steel);
      rect(5, 6, w - 11, 19, dark); rect(5, 27, w - 11, 1, ink);
      rect(w - 9, 31, 2, 10, ink); rect(w - 9, 12, 2, 7, hi);
      rect(7, 9, 7, 3, accent); break;
    case 'shelf':
      panel(2, 3, w - 5, h - 8, dark);
      for (let y = 9; y < 37; y += 13) {
        rect(6, y, w - 13, 10, ink);
        for (let x = 9; x < w - 10; x += 9) { rect(x, y + 2, 6, 8, x % 3 ? steel : wood); rect(x + 1, y + 3, 4, 1, paper); }
        rect(5, y + 10, w - 12, 2, hi);
      } break;
    case 'reception':
      desk(1, 13, w - 3, 28, wood);
      rect(8, 28, w - 21, 11, dark); text('HQ / RECEPTION', 17, 31, accent);
      rect(w - 25, 7, 16, 13, ink); rect(w - 24, 8, 13, 9, muted); break;
    case 'cable':
      rect(0, 5, w, 7, dark); rect(0, 5, w, 1, hi); rect(0, 11, w, 1, ink);
      rect(0, 7, w, 1, muted); for (let x = 4; x < w; x += 12) rect(x, 6, 2, 5, steel); break;
    case 'cooler':
      panel(2, 17, 12, 25, steel); panel(4, 4, 8, 16, muted);
      rect(5, 25, 6, 7, ink); rect(6, 24, 4, 2, accent); break;
    case 'bin':
      panel(3, 12, 11, 17, dark); rect(4, 12, 9, 3, ink); rect(6, 17, 2, 8, steel); break;
    case 'window':
      panel(1, 1, w - 4, h - 5, dark); rect(4, 4, w - 10, h - 11, muted);
      for (let i = 0; i < 7; i++) {
        const bh = [7, 12, 9, 16, 8, 13, 10][i]; rect(6 + i * 10, 25 - bh, 8, bh, dark);
        rect(8 + i * 10, 27 - bh, 3, 2, wood);
      }
      rect(w / 2, 3, 2, h - 8, steel); break;
    case 'rug':
      rect(1, 1, w - 2, h - 2, dark); rect(3, 3, w - 6, h - 6, pal.floor.base);
      rect(5, 5, 2, h - 10, muted); rect(w - 7, 5, 2, h - 10, muted); break;
    default: {
      const labels = { signOps: '01 / OPERATIONS', signLab: '02 / ENGINEERING', signDeploy: '03 / DEPLOY', signBreak: '05 / RECHARGE', signMeet: '04 / BRIEFING', signEntry: 'TECH / OPERATIONS' };
      rect(1, 3, w - 2, 11, dark); rect(1, 3, 2, 11, accent); text(labels[key], 7, 6, paper); break;
    }
  }
  return buf;
}

export function buildTechOfficeAtlas(pal = TILE_PALETTES[TECH_PALETTE_KEY]) {
  const { imagewidth: width, imageheight: height } = TECH_ATLAS_META;
  const data: Buf = new Uint8ClampedArray(width * height * 4);
  function cell(src: ReturnType<typeof drawTechProp>, sx: number, sy: number, gid: number) {
    const dx = ((gid - 1) % TECH_COLUMNS) * TECH_CELL;
    const dy = Math.floor((gid - 1) / TECH_COLUMNS) * TECH_CELL;
    for (let y = 0; y < TECH_CELL; y++) {
      const offset = ((sy * TECH_CELL + y) * src.width + sx * TECH_CELL) * 4;
      data.set(src.data.subarray(offset, offset + TECH_CELL * 4), ((dy + y) * width + dx) * 4);
    }
  }
  for (const key of Object.keys(TECH_PIECES) as TechProp[]) {
    const p = TECH_PIECES[key], src = drawTechProp(key, pal);
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) cell(src, x, y, techGid(key, x, y));
  }
  for (const [kind, gids] of [
    ['monitorOff', [365, 366, 381, 382]], ['monitorOn', [367, 368, 383, 384]],
    ['monitorBack', [369, 370, 385, 386]], ['monitorBackOn', [371, 372, 387, 388]],
  ] as const) {
    const src = drawTechProp(kind, pal);
    gids.forEach((gid, i) => cell(src, i % 2, Math.floor(i / 2), gid));
  }
  return { data, width, height, columns: TECH_COLUMNS, cell: TECH_CELL, tilecount: TECH_TILECOUNT };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE WALL SURFACES
//
// Two props in this atlas are INSTRUMENTS rather than furniture: the panoramic
// display over 01/OPERATIONS and the planning whiteboard in 04/BRIEFING. Their
// chrome is baked above; the readings are redrawn here whenever the underlying
// data changes, and composited over the prop by OfficeFloor.
//
// They live in this file, and not next to the Pixi code that mounts them, for
// the same reason every other prop does: they are drawn with `rectOn`/`textOn`,
// in the theme's palette, in the same three-pixel alphabet as the room signs —
// one hand, one vocabulary. And like `drawTechProp` they are PURE functions
// from data to an RGBA buffer, so what they draw is testable without a GPU.
//
// WHAT THEY MAY NOT DO: invent. Every `null` below is a source that could not
// be read, and every one of them draws the words NO DATA. See wallReadout.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** The live region of the `screen` prop, in prop-local pixels: the glass BELOW
 *  the header rule. The bezel, the glass edge and the OPERATIONS / LIVE sign
 *  above it are baked and never repaint. */
export const OPS_READOUT_RECT = { x: 5, y: 21, w: 212, h: 34 } as const;

/** The live region of the `whiteboard` prop: the note field under the written
 *  header. The board, its header and the marker tray are baked. */
export const PLAN_READOUT_RECT = { x: 4, y: 18, w: 86, h: 20 } as const;

/**
 * Status colours, supplied by the theme rather than derived from the tile
 * palette.
 *
 * The floor ALREADY has a colour language for work — `theme.palette.noteColors`
 * paints the cork boards' cards and the sticky notes on the desks. The wall
 * instruments borrow it verbatim so a yellow mark means the same thing on the
 * whiteboard, on the cork board and on a desk, and so a re-themed floor
 * re-tints all three together.
 */
export interface ReadoutInk { todo: RGB; doing: RGB; blocked: RGB; done: RGB }

/** `theme.palette.noteColors` are Pixi 0xRRGGBB numbers; this file speaks RGB. */
export function rgbFromHex(hex: number): RGB {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

/** Fallback status colours, matching OFFICE_THEME.palette.noteColors. Only ever
 *  used by a caller that does not pass its theme's own — the tests, and any
 *  future surface with no theme in hand. */
const DEFAULT_INK: ReadoutInk = {
  todo: rgbFromHex(0xf2df8a), doing: rgbFromHex(0x9ecbf0),
  blocked: rgbFromHex(0xf0a3a3), done: rgbFromHex(0xa8e0b0)
};

/** Mirrors BreakerLevel in weather.ts / src/main/breaker.ts. Declared locally so
 *  the art file stays a leaf — it imports the tile palette and nothing else. */
type Level = 'healthy' | 'steering' | 'constrained' | 'stopped';

/** What `drawOpsReadout` needs, structurally identical to wallReadout's
 *  OpsReadout (the module that derives it). Declared here rather than imported
 *  for the leaf reason above; the readout tests assert one satisfies the other. */
export interface OpsReadoutData {
  agents: readonly Level[] | null;
  ci: readonly ('pass' | 'fail' | 'running' | 'other')[] | null;
  /** Per hour: a count, or `null` for an hour the event feed never covered. */
  shipped: readonly (number | null)[] | null;
}
/** Ditto, for wallReadout's PlanBoard. */
export interface PlanReadoutData { plan: number; build: number; blocked: number; ship: number }

// Panel geometry, in READOUT-LOCAL pixels. Three columns of equal width with a
// rule between them; the widths are what a 212px glass divides into, and every
// label and mark below is placed against these rather than against the prop.
const OPS_COLS = [4, 75, 146] as const;
const OPS_RULES = [70, 141] as const;
const OPS_LABEL_Y = 2;
const PIP = 4, PIP_PITCH = 6, PIP_ROW = 7, PIPS_PER_ROW = 10, PIP_ROWS = 3, PIP_TOP = 12;
const CHIP_W = 10, CHIP_H = 7, CHIP_PITCH = 12, CHIP_TOP = 13, CHIP_SLOTS = 5;
const BAR_W = 4, BAR_PITCH = 5, BAR_UNIT = 3, BAR_FULL = 8, BAR_BASE = 31, BARS = 9;

/**
 * The operations wall's three live panels.
 *
 * AGENTS  one pip per agent the breaker beat is currently reporting, coloured
 *         by level. Deliberately not a count: "how many" is already on the
 *         status pin, and at this size a shape reads where a number does not.
 * CI      up to five recent workflow runs, oldest → newest left to right, so
 *         the rightmost chip is the latest build. Slots with no run behind them
 *         are drawn as empty outlines, which is what a repo with fewer than
 *         five runs honestly looks like.
 * SHIPPED one bar per hour of real closures over the last nine hours. A bar is
 *         three pixels per closure; an hour at or beyond BAR_FULL saturates and
 *         says so with a capped top rather than being clipped in silence. An
 *         hour with nothing in it keeps a one-pixel stub, so "measured and
 *         empty" cannot be mistaken for "not drawn" — and an hour the event
 *         feed never reached (a `null` bucket) gets NO stub, leaving the bare
 *         axis, so it cannot be mistaken for "measured and empty" either. When
 *         every hour is unmeasured the column says NO DATA outright: a chart of
 *         nine blanks is not a reading.
 */
export function drawOpsReadout(
  data: OpsReadoutData,
  pal: TilePalette = TILE_PALETTES[TECH_PALETTE_KEY],
  ink: ReadoutInk = DEFAULT_INK
): PixelBuffer {
  const { w, h } = OPS_READOUT_RECT;
  const buf: PixelBuffer = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  const [, steel, dark] = shades(pal.wall.base, 1.14, 0.8);
  const glass = shades(pal.floor.mortar, 1.16, 0.72)[2];
  const accent = pal.wall.line;
  const muted = mix(steel, accent, 0.32);

  rectOn(buf, 0, 0, w, h, glass);
  for (const x of OPS_RULES) rectOn(buf, x, 1, 1, h - 2, dark);
  const labels = ['AGENTS', 'CI', 'SHIPPED'] as const;
  OPS_COLS.forEach((x, i) => textOn(buf, labels[i], x, OPS_LABEL_Y, muted));
  const noData = (x: number): void => { textOn(buf, 'NO DATA', x, PIP_TOP + 3, mix(muted, glass, 0.45)); };

  // ── AGENTS ────────────────────────────────────────────────────────────────
  if (!data.agents) noData(OPS_COLS[0]);
  else {
    const levelInk: Record<Level, RGB> = {
      healthy: ink.done, steering: ink.todo, constrained: ink.blocked, stopped: ink.blocked
    };
    const shown = Math.min(data.agents.length, PIPS_PER_ROW * PIP_ROWS);
    for (let i = 0; i < shown; i++) {
      const x = OPS_COLS[0] + (i % PIPS_PER_ROW) * PIP_PITCH;
      const y = PIP_TOP + Math.floor(i / PIPS_PER_ROW) * PIP_ROW;
      const level = data.agents[i];
      rectOn(buf, x, y, PIP, PIP, levelInk[level] ?? muted);
      // A STOPPED agent is not just "worse than constrained", it is a run that
      // was actually killed. Same coral, hollowed out — a pip with nothing in it.
      if (level === 'stopped') rectOn(buf, x + 1, y + 1, PIP - 2, PIP - 2, glass);
    }
    // More agents than slots: the last pip becomes a pile, the same overflow
    // gesture the cork boards use for their thirteenth card.
    if (data.agents.length > shown) {
      const x = OPS_COLS[0] + (PIPS_PER_ROW - 1) * PIP_PITCH;
      const y = PIP_TOP + (PIP_ROWS - 1) * PIP_ROW;
      rectOn(buf, x + 1, y - 1, PIP, PIP, muted);
      rectOn(buf, x, y, PIP, PIP, ink.done);
    }
  }

  // ── CI ────────────────────────────────────────────────────────────────────
  if (!data.ci) noData(OPS_COLS[1]);
  else {
    const chipInk = { pass: ink.done, fail: ink.blocked, running: ink.doing, other: muted };
    for (let slot = 0; slot < CHIP_SLOTS; slot++) {
      const x = OPS_COLS[1] + slot * CHIP_PITCH;
      const run = data.ci[data.ci.length - CHIP_SLOTS + slot];
      rectOn(buf, x, CHIP_TOP, CHIP_W, CHIP_H, dark);
      if (!run) continue;                                   // empty slot: outline only
      rectOn(buf, x + 1, CHIP_TOP + 1, CHIP_W - 2, CHIP_H - 2, chipInk[run]);
      // A run still going gets a hollow core, so "green" can never be read as
      // "green so far".
      if (run === 'running') rectOn(buf, x + 3, CHIP_TOP + 2, CHIP_W - 6, CHIP_H - 4, dark);
    }
  }

  // ── SHIPPED ───────────────────────────────────────────────────────────────
  rectOn(buf, OPS_COLS[2], BAR_BASE, BARS * BAR_PITCH + 2, 1, dark);
  const hours = data.shipped;
  // Nine unmeasured hours is not a chart of nine empty hours; it is the panel
  // failing to read its source, spelled the way every other failure is.
  const measured = hours?.some((n, i) => i < BARS && n !== null && n !== undefined) ?? false;
  if (!measured) noData(OPS_COLS[2]);
  else {
    for (let i = 0; i < BARS; i++) {
      const x = OPS_COLS[2] + 2 + i * BAR_PITCH;
      const n = hours?.[i];
      // An hour the feed never covered gets no mark at all — bare axis. Any
      // stub here would claim the hour was looked at and found quiet.
      if (n === null || n === undefined) continue;
      // An hour with nothing in it still gets a mark, a shade up from the axis
      // it sits on: "measured, and empty" has to be visibly different from the
      // bare axis an unmeasured hour leaves.
      if (n <= 0) { rectOn(buf, x, BAR_BASE - 1, BAR_W, 1, mix(dark, muted, 0.55)); continue; }
      const units = Math.min(n, BAR_FULL);
      const height = units * BAR_UNIT;
      rectOn(buf, x, BAR_BASE - height, BAR_W, height, accent);
      if (n > BAR_FULL) rectOn(buf, x, BAR_BASE - height, BAR_W, 1, ink.done);
    }
  }
  return buf;
}

// Note geometry on the whiteboard, in READOUT-LOCAL pixels. The two rules fall
// under the two slashes of the header written above them (prop-local x 31 and
// 61, i.e. readout-local 27 and 57), so each column hangs off its own word.
const PLAN_COLS = [2, 30, 60] as const;
const PLAN_RULES = [27, 57] as const;
const NOTE_W = 5, NOTE_H = 4, NOTE_PITCH = 7, NOTE_ROW = 6, NOTES_PER_ROW = 3, NOTE_ROWS = 2, NOTE_TOP = 7;

/**
 * The planning board's three columns, one note per real card.
 *
 * The header written on this board — PLAN / BUILD / SHIP — is the ledger's own
 * three states, so the mapping needs no invention: `todo` plans, `doing` builds,
 * `done` ships. `blocked` rides in BUILD, drawn in the blocked colour: a card
 * somebody picked up and got stuck on has left PLAN and has not reached SHIP.
 *
 * Each column prints its count (see `countLabelOf` — three digits is what fits,
 * and past that the number is dropped rather than clamped into a lie) above a
 * note stack that saturates at six and then piles.
 */
export function drawPlanReadout(
  board: PlanReadoutData | null,
  pal: TilePalette = TILE_PALETTES[TECH_PALETTE_KEY],
  ink: ReadoutInk = DEFAULT_INK
): PixelBuffer {
  const { w, h } = PLAN_READOUT_RECT;
  const buf: PixelBuffer = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  const [, steel, dark] = shades(pal.wall.base, 1.14, 0.8);
  const pin = shades(pal.floor.mortar, 1.16, 0.72)[2];
  const accent = pal.wall.line;
  const muted = mix(steel, accent, 0.32);
  const paper = mix(pal.floor.fleck, [255, 255, 255], 0.55);

  rectOn(buf, 0, 0, w, h, paper);
  if (!board) {
    textOn(buf, 'NO DATA', PLAN_COLS[1], NOTE_TOP, muted);
    return buf;
  }
  for (const x of PLAN_RULES) rectOn(buf, x, 0, 1, h, muted);

  // Column → the notes it holds, in drawing order. BUILD shows its blocked
  // cards first so they are the ones that survive the six-note cap: a stuck
  // card is what a glance at this board needs to find.
  const columns: RGB[][] = [
    new Array<RGB>(Math.max(0, board.plan)).fill(ink.todo),
    [
      ...new Array<RGB>(Math.max(0, board.blocked)).fill(ink.blocked),
      ...new Array<RGB>(Math.max(0, board.build)).fill(ink.doing)
    ],
    new Array<RGB>(Math.max(0, board.ship)).fill(ink.done)
  ];
  const counts = [board.plan, board.blocked + board.build, board.ship];

  columns.forEach((notes, col) => {
    const cx = PLAN_COLS[col];
    const label = countLabelOf(counts[col]);
    if (label) textOn(buf, label, cx, 0, dark);
    const shown = Math.min(notes.length, NOTES_PER_ROW * NOTE_ROWS);
    for (let i = 0; i < shown; i++) {
      const x = cx + (i % NOTES_PER_ROW) * NOTE_PITCH;
      const y = NOTE_TOP + Math.floor(i / NOTES_PER_ROW) * NOTE_ROW;
      rectOn(buf, x, y, NOTE_W, NOTE_H, notes[i]);
      rectOn(buf, x + 2, y, 1, 1, pin);                      // the pin
    }
    if (notes.length > shown && shown > 0) {
      const x = cx + (NOTES_PER_ROW - 1) * NOTE_PITCH;
      const y = NOTE_TOP + (NOTE_ROWS - 1) * NOTE_ROW;
      rectOn(buf, x + 1, y - 1, NOTE_W, NOTE_H, mix(notes[shown - 1], accent, 0.4));
      rectOn(buf, x, y, NOTE_W, NOTE_H, notes[shown - 1]);
      rectOn(buf, x + 2, y, 1, 1, pin);
    }
  });
  return buf;
}

/** Local copy of wallReadout's `countLabel` rule — the art file is a leaf and
 *  imports no sibling module; `office-wall-readout.test.cjs` pins the two to
 *  each other so they cannot drift. */
function countLabelOf(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  const whole = Math.floor(n);
  return whole <= 999 ? String(whole) : '';
}
