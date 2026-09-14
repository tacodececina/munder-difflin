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

export function drawTechProp(key: TechProp | 'monitorOff' | 'monitorOn' | 'monitorBack' | 'monitorBackOn', pal: TilePalette) {
  const [wt, ht] = key === 'monitorOff' || key === 'monitorOn' || key === 'monitorBack' || key === 'monitorBackOn' ? [2, 2] : sizes[key];
  const w = wt * TECH_CELL, h = ht * TECH_CELL;
  const data = new Uint8ClampedArray(w * h * 4);
  const [hi, steel, dark] = shades(pal.wall.base, 1.14, 0.8);
  const ink = shades(pal.floor.mortar, 1.16, 0.72)[2];
  const surface = mix(pal.wall.base, pal.floor.fleck, 0.3);
  const accent = pal.wall.line;
  const muted = mix(steel, accent, 0.32);
  const paper = mix(pal.floor.fleck, [255, 255, 255], 0.55);
  const wood = pal.floor.fleck;
  const shadow = mix(ink, pal.floor.base, 0.35);
  function rect(x: number, y: number, rw: number, rh: number, c: RGB, a = 255) {
    for (let py = Math.max(0, y); py < Math.min(h, y + rh); py++)
      for (let px = Math.max(0, x); px < Math.min(w, x + rw); px++) setPx(data, w, px, py, c, a);
  }
  function text(s: string, x: number, y: number, c = paper, scale = 1) {
    for (const ch of s) {
      const pixels = FONT[ch] ?? FONT[' '];
      for (let i = 0; i < 15; i++) if (pixels[i] === '1') rect(x + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale, scale, c);
      x += 4 * scale;
    }
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
      panel(1, 1, w - 4, h - 5, dark);
      rect(5, 5, w - 12, h - 14, ink);
      text('OPERATIONS / LIVE', 11, 9, accent);
      text('99.98', 165, 9, paper); text('UPTIME', 166, 18, muted);
      rect(10, 20, 138, 1, dark);
      // Service topology with deliberate hierarchy and routed connectors.
      rect(28, 33, 95, 2, muted); rect(63, 27, 2, 22, muted);
      for (const [x, y, label] of [[12, 28, 'API'], [53, 23, 'CORE'], [99, 28, 'DB'], [53, 44, 'CI']] as const) {
        rect(x, y, 28, 12, muted); rect(x + 1, y + 1, 26, 10, ink); text(label, x + 4, y + 4, accent);
      }
      rect(152, 26, 1, 28, dark);
      for (let i = 0; i < 9; i++) {
        const bh = [7, 12, 10, 17, 14, 22, 19, 24, 22][i];
        rect(160 + i * 5, 52 - bh, 3, bh, i < 6 ? muted : accent);
      }
      rect(6, h - 8, w - 16, 1, accent); break;
    }
    case 'whiteboard': {
      panel(2, 2, w - 5, h - 9, paper);
      rect(6, 7, w - 13, 2, dark); text('PLAN / BUILD / SHIP', 9, 12, dark);
      for (let x = 31; x < 80; x += 27) rect(x, 21, 1, 15, muted);
      for (const [x, y, rw] of [[10, 22, 14], [10, 30, 10], [38, 22, 16], [65, 26, 17]]) {
        rect(x, y, rw, 5, muted); rect(x + 2, y + 1, rw - 5, 1, dark);
      }
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
  return { data, width: w, height: h };
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
