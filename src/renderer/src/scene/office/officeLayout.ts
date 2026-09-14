// Shared coordinates: the generator and OFFICE_THEME import this exact data.
import type { ThemeConfig } from './themeRegistry';

export const OFFICE_SIZE = { width: 48, height: 36 };
export const OFFICE_SEATS = [
  { name: 'desk-ceo', x: 5, y: 28, group: 'lead-corner' },
  { name: 'pc-1', x: 4, y: 16, group: 'island', monitorOffsetY: 3 },
  { name: 'pc-2', x: 8, y: 16, group: 'island', monitorOffsetY: 3 },
  { name: 'pc-3', x: 4, y: 22, group: 'island' },
  { name: 'pc-4', x: 8, y: 22, group: 'island' },
  { name: 'pc-5', x: 16, y: 18, group: 'bench' },
  { name: 'pc-6', x: 20, y: 18, group: 'bench' },
  { name: 'pc-7', x: 24, y: 18, group: 'bench' },
  { name: 'pc-8', x: 15, y: 26, group: 'corner' },
  { name: 'pc-9', x: 22, y: 27, group: 'corner' },
  { name: 'pc-10', x: 3, y: 33, group: 'standing' },
  { name: 'pc-11', x: 9, y: 31, group: 'standing' },
  { name: 'pc-12', x: 23, y: 32, group: 'standing' },
  { name: 'warroom-seat-1', x: 4, y: 9, group: 'console-a' },
  { name: 'warroom-seat-2', x: 8, y: 9, group: 'console-a' },
  { name: 'warroom-seat-3', x: 17, y: 10, group: 'console-b' },
  { name: 'warroom-seat-4', x: 21, y: 10, group: 'console-b' },
  { name: 'desk-deploy-1', x: 31, y: 19, group: 'deploy-standing' },
  { name: 'desk-deploy-2', x: 33, y: 23, group: 'deploy-standing' },
];
export const OFFICE_CAFE = [
  { name: 'cafe-seat-1', x: 34, y: 25 }, { name: 'cafe-seat-2', x: 34, y: 27 },
  { name: 'cafe-seat-3', x: 42, y: 28 }, { name: 'cafe-seat-4', x: 42, y: 30 },
  { name: 'cafe-stand-coffee', x: 31, y: 33 }, { name: 'cafe-stand-vending', x: 39, y: 33 },
];
export const OFFICE_ENTRANCE = { x: 16, y: 34 };
export const OFFICE_ZONES = {
  'wing-engineering': { x: 1, y: 15, w: 27, h: 20 },
  'wing-warroom': { x: 1, y: 3, w: 27, h: 9 },
  'wing-meeting': { x: 30, y: 3, w: 17, h: 9 },
  'wing-deploy': { x: 30, y: 15, w: 17, h: 9 },
  'wing-break': { x: 30, y: 24, w: 17, h: 11 },
  boardroom: { x: 34, y: 5, w: 8, h: 7 },
};
export const OFFICE_BINDINGS = {
  primarySeatNames: OFFICE_SEATS.map(s => s.name),
  cafeSeatNames: OFFICE_CAFE.filter(s => s.name.startsWith('cafe-seat-')).map(s => s.name),
  cafeStands: [['cafe-stand-coffee', 'coffee'], ['cafe-stand-vending', 'vending']],
  coffee: {
    trayTile: { x: 34, y: 31 }, trayStand: { x: 34, y: 33 },
    machineStand: { x: 31, y: 33 }, sinkTile: { x: 36, y: 31 },
    sinkStand: { x: 36, y: 33 }, maxCups: 4,
  },
  anchors: {
    calendar: { x: 3, y: 1 }, clock: { x: 1, y: 1 }, worldClock: { x: 22, y: 1 },
    boards: { x: 18, y: 14 }, askBoard: { x: 3, y: 14 }, coffeeSteam: { x: 31, y: 29 },
    boardPinStand: { x: 20, y: 15 }, boardTakeStand: { x: 21, y: 15 },
    boardArchiveStand: { x: 24, y: 15 },
    // The two LIVE surfaces. `gen-tech-office.cjs` stamps the `screen` and
    // `whiteboard` props at exactly these tiles, so the generator and the
    // renderer's readout overlay cannot drift apart: move the prop here and the
    // map and the instrument move together.
    opsScreen: { x: 5, y: 1 }, planBoard: { x: 36, y: 1 },
  },
  errandSpots: [
    { kind: 'water', stand: { x: 2, y: 27 }, facing: 'up', fx: { x: 2, y: 26 }, duration: 4.5, godOnly: true },
    { kind: 'smoke', stand: { x: 32, y: 3 }, facing: 'up', fx: { x: 32, y: 1 }, duration: 18, godOnly: true },
    { kind: 'water', stand: { x: 13, y: 22 }, facing: 'right', fx: { x: 14, y: 22 }, duration: 4.5 },
    { kind: 'water', stand: { x: 45, y: 28 }, facing: 'up', fx: { x: 45, y: 27 }, duration: 4.5 },
    { kind: 'window', stand: { x: 32, y: 3 }, facing: 'up', fx: { x: 32, y: 1 }, duration: 5 },
    { kind: 'dispenser', stand: { x: 27, y: 20 }, facing: 'up', fx: { x: 27, y: 19 }, duration: 3.5 },
    { kind: 'fridge', stand: { x: 39, y: 33 }, facing: 'up', fx: { x: 39, y: 32 }, duration: 3.2 },
    { kind: 'shelf', stand: { x: 44, y: 34 }, facing: 'up', fx: { x: 44, y: 33 }, duration: 4 },
    { kind: 'bin', stand: { x: 29, y: 33 }, facing: 'right', fx: { x: 30, y: 33 }, duration: 2.6 },
  ],
} satisfies Pick<ThemeConfig, 'primarySeatNames' | 'cafeSeatNames' | 'cafeStands' | 'coffee' | 'anchors' | 'errandSpots'>;
