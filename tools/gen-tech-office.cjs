#!/usr/bin/env node
'use strict';

// A composed floor plan, not a desk distribution algorithm. Named groups own
// furniture; seats add only monitors. node tools/gen-tech-office.cjs [--check]
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('../test/load-ts.cjs');
const { TECH_PIECES: P, TECH_ATLAS_META, techGid } = loadTs('src/renderer/src/scene/office/techOfficeArt.ts');
const { OFFICE_SIZE, OFFICE_SEATS, OFFICE_CAFE, OFFICE_ENTRANCE, OFFICE_ZONES } = loadTs('src/renderer/src/scene/office/officeLayout.ts');
const { validateOfficeMap } = require('./mapgen/validate-tech-office.cjs');
const OUT = path.resolve(__dirname, '../src/renderer/src/assets/maps/office.tmj');

function buildOfficeMap() {
  const { width: W, height: H } = OFFICE_SIZE, TS = 16;
  const names = ['floor', 'walls', 'furniture-below', 'furniture-above', 'collision'];
  const L = Object.fromEntries(names.map(n => [n, Array(W * H).fill(0)]));
  const placements = [];
  const idx = (x, y) => y * W + x;
  function put(layer, x, y, gid) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= W || y >= H)
      throw new Error(`Out of bounds: ${layer} (${x},${y})`);
    if (layer.startsWith('furniture') && gid && L[layer][idx(x, y)])
      throw new Error(`Overlapping furniture: ${layer} (${x},${y})`);
    L[layer][idx(x, y)] = gid;
  }
  function block(x, y, w, h) {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) put('collision', x + dx, y + dy, 1);
  }
  function material(key, x, y, w, h) {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++)
      put('floor', x + dx, y + dy, techGid(key, (x + dx) % 2, (y + dy) % 2));
  }
  function prop(key, x, y, layer = 'furniture-below') {
    const p = P[key];
    if (!p) throw new Error(`Unknown prop ${key}`);
    for (let dy = 0; dy < p.h; dy++) for (let dx = 0; dx < p.w; dx++)
      put(layer, x + dx, y + dy, techGid(key, dx, dy));
    placements.push({ key, x, y, layer });
  }
  function solid(key, x, y) { prop(key, x, y); block(x, y, P[key].w, P[key].h); }
  function band(x, y, w, doors = []) {
    for (let dx = 0; dx < w; dx++) {
      if (doors.includes(x + dx)) continue;
      for (let dy = 0; dy < 3; dy++) put('walls', x + dx, y + dy, techGid('wall', 0, dy));
      block(x + dx, y, 1, 3);
    }
  }

  // Calm graphite background; warm material only in the lounge.
  material('floor', 1, 3, W - 2, H - 4);
  material('carpet', 2, 5, 25, 7);
  material('carpet', 2, 16, 10, 8);
  material('carpet', 14, 16, 13, 4);
  material('carpet', 33, 5, 11, 7);
  material('timber', 30, 25, 17, 10);
  band(0, 0, W);
  band(1, 12, 27, [12, 13, 14, 15]);
  band(30, 12, 17, [30, 31, 32, 33]);
  for (let y = 3; y < H; y++) {
    put('walls', 0, y, techGid('sideWall')); block(0, y, 1, 1);
    put('walls', W - 1, y, techGid('sideWall')); block(W - 1, y, 1, 1);
  }
  for (let x = 1; x < W - 1; x++) if (x < 15 || x > 18) {
    put('walls', x, H - 1, techGid('wall', 0, 0)); block(x, H - 1, 1, 1);
  }
  // Short glass blades replace the old full-height dividing wall.
  for (const [x, y] of [[28, 3], [28, 6], [28, 9], [28, 16], [28, 19]]) {
    prop('glass', x, y, 'walls'); block(x, y, 1, 3);
  }

  // 01 — Operations: panoramic wall and staggered consoles.
  prop('screen', 5, 1, 'furniture-above'); block(5, 3, 14, 2);
  prop('signOps', 3, 5, 'furniture-above');
  prop('console', 3, 7); block(3, 8, 11, 1);
  prop('console', 16, 8); block(16, 9, 11, 1);
  solid('plant', 1, 9);
  prop('cable', 19, 4, 'furniture-above');

  // 02 — Four people around ONE cable-spine island. North sitters face south;
  // monitorOffsetY is shared by static art, DeskScreen, shelf, note and cup.
  prop('island', 3, 17); block(3, 17, 8, 5);
  prop('bench', 15, 16); block(15, 17, 11, 1);
  prop('corner', 14, 24); block(14, 25, 5, 1); block(18, 26, 1, 2);
  prop('corner', 21, 25); block(21, 26, 5, 1); block(25, 27, 1, 2);
  prop('corner', 3, 26); block(3, 27, 5, 1); block(7, 28, 1, 2);
  prop('standing', 2, 31); block(2, 32, 4, 1);
  prop('standing', 8, 29); block(8, 30, 4, 1);
  prop('standing', 22, 30); block(22, 31, 4, 1);
  solid('planter', 14, 20);
  solid('plant', 1, 24);
  solid('cooler', 27, 17);
  prop('signLab', 17, 12, 'furniture-above');

  // 03 — Rack + network cabinet and their service aisle.
  solid('server', 37, 15); solid('network', 41, 15);
  prop('cable', 36, 20); prop('cable', 40, 20);
  prop('standing', 30, 17); block(30, 18, 4, 1);
  prop('standing', 32, 21); block(32, 22, 4, 1);
  solid('shelf', 43, 21);
  prop('signDeploy', 35, 13, 'furniture-above');

  // 04 — One generous table, content board and city window.
  prop('window', 30, 1, 'furniture-above');
  prop('whiteboard', 36, 1, 'furniture-above');
  prop('meeting', 34, 6); block(34, 7, 8, 3);
  for (const x of [35, 38, 40]) {
    prop('chairNorth', x, 5, 'furniture-above');
    prop('chair', x, 10, 'furniture-above');
  }
  solid('plant', 44, 8);
  prop('signMeet', 41, 4, 'furniture-above');

  // 05 — Offset two-person tables, sofa, coffee and storage.
  solid('sofa', 40, 24); solid('plant', 45, 25);
  prop('cafeTable', 33, 26, 'furniture-above'); block(33, 26, 2, 1);
  prop('cafeTable', 41, 29, 'furniture-above'); block(41, 29, 2, 1);
  solid('coffee', 31, 29); solid('fridge', 38, 29); solid('shelf', 43, 31);
  solid('bin', 30, 32);
  prop('signBreak', 31, 24, 'furniture-above');
  // The lower chair half fits in one cell, leaving the table legible.
  for (const s of OFFICE_CAFE.filter(s => s.name.startsWith('cafe-seat-'))) {
    put('furniture-below', s.x, s.y, techGid('chair', 0, 1));
  }

  // Arrival: offset reception keeps the central approach open.
  solid('reception', 14, 30);
  prop('signEntry', 19, 34, 'furniture-above');
  for (const s of OFFICE_SEATS) {
    for (const [gid, dx, dy] of [[365, 0, -2], [366, 1, -2], [381, 0, -1], [382, 1, -1]])
      put('furniture-above', s.x + dx, s.y + dy, gid);
    if (s.monitorOffsetY) prop('chairNorth', s.x, s.y - 1);
    else if (!s.group.includes('standing')) prop('chair', s.x, s.y, 'furniture-above');
  }
  let oid = 1;
  const point = s => ({
    id: oid++, name: s.name, type: '', point: true, x: s.x * TS, y: s.y * TS,
    width: 0, height: 0, rotation: 0, visible: true,
    ...(s.monitorOffsetY ? { properties: [{ name: 'monitorOffsetY', type: 'int', value: s.monitorOffsetY }] } : {}),
  });
  const layers = names.map((name, i) => ({
    id: i + 1, name, type: 'tilelayer', data: L[name], width: W, height: H,
    x: 0, y: 0, opacity: 1, visible: name !== 'collision',
  }));
  layers.push({ id: 6, name: 'spawn-points', type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true,
    objects: [...OFFICE_SEATS, ...OFFICE_CAFE, { name: 'entrance', ...OFFICE_ENTRANCE }].map(point) });
  layers.push({ id: 7, name: 'zones', type: 'objectgroup', x: 0, y: 0, opacity: 1, visible: true,
    objects: Object.entries(OFFICE_ZONES).map(([name, z]) => ({
      id: oid++, name, type: '', x: z.x * TS, y: z.y * TS, width: z.w * TS, height: z.h * TS, rotation: 0, visible: true,
    })) });
  return {
    compressionlevel: -1, infinite: false, orientation: 'orthogonal', renderorder: 'right-down',
    type: 'map', version: '1.10', tiledversion: '1.10.2', width: W, height: H, tilewidth: TS, tileheight: TS,
    nextlayerid: 8, nextobjectid: oid, layers,
    tilesets: [{ ...TECH_ATLAS_META, name: 'tech-office', margin: 0, spacing: 0 }],
    properties: [
      { name: 'generator', type: 'string', value: 'tools/gen-tech-office.cjs — edit composition and officeLayout.ts; validate before writing.' },
      { name: 'proceduralAtlas', type: 'string', value: 'tech-office' },
      { name: 'propPlacements', type: 'string', value: JSON.stringify(placements) },
    ],
  };
}
function writeOfficeMap(map, out = OUT) {
  const report = validateOfficeMap(map); // MUST precede all filesystem writes.
  fs.writeFileSync(out, JSON.stringify(map) + '\n', 'utf8');
  return report;
}
if (require.main === module) {
  try {
    const map = buildOfficeMap();
    const report = process.argv.includes('--check') ? validateOfficeMap(map) : writeOfficeMap(map);
    console.log(`${process.argv.includes('--check') ? 'Validated' : 'Wrote'} office: ${map.width}x${map.height}; ${report.seats} desks; ${report.reachable} reachable tiles; all 8 contracts pass.`);
  } catch (err) {
    console.error(`OFFICE VALIDATION FAILED — map NOT written:\n${err.message}`);
    process.exitCode = 1;
  }
}
module.exports = { buildOfficeMap, writeOfficeMap };
