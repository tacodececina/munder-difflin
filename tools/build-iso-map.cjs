'use strict';

// Generates src/renderer/src/assets/maps/isometric.tmj — the small prototype
// floor the `isometric` theme renders.
//
// WHY A GENERATOR AND NOT A HAND-EDITED .tmj: the other four maps were authored
// in Tiled against real 16x16 atlases, so their JSON is a human artifact worth
// keeping. This one is a 12x12 test bed painted from an atlas that does not
// exist as a file (isoTileArt.ts generates it at load time), so the map is a
// derived artifact too — and a 300-number `data` array is not something to
// hand-maintain. Re-run with `node tools/build-iso-map.cjs`.
//
// COORDINATES. Tiled stores object x/y in pixels; parseSpawnPoints/parseZones
// (tiledCollision.ts) divide by map.tilewidth/tileheight to get tiles back. On
// an isometric map Tiled's own object placement is in a different space (BOTH
// axes scaled by tileheight), but nothing here ever opens this file in Tiled —
// the renderer is the only reader, and it goes through those two parsers. So
// the objects below are written in the parsers' own convention:
// x = tx * tilewidth, y = ty * tileheight.
//
// That mismatch is invisible to anyone who opens the .tmj in real Tiled: the
// points would land somewhere else, and re-saving would silently rewrite them
// into Tiled's space, shifting every seat. A comment in this generator cannot
// warn that person, so the map carries the warning itself as a custom map
// property (`spawnPointSpace`, below) — the one channel that survives a
// round-trip through the editor.

const fs = require('node:fs');
const path = require('node:path');

const W = 12;
const H = 12;
const TILE_W = 32; // isoTileArt.ts ISO_TILE_W
const TILE_H = 16; // isoTileArt.ts ISO_TILE_H

// Gids into the generated atlas (firstgid 1, slot order = ISO_ATLAS_SLOTS).
const FLOOR = [1, 2, 3, 4];
const WALL = 5;
const DESK = 8;

const idx = (x, y) => y * W + x;
const blank = () => new Array(W * H).fill(0);

// The two "back" edges of an isometric room are tile row 0 (which recedes to
// the north-east) and tile column 0 (north-west). Walling exactly those two
// gives the classic open-fronted iso room: you see into it from the south.
const isWall = (x, y) => x === 0 || y === 0;

// Six L-shaped corner desks. Each is two blocks — one tile NORTH of the chair
// and one tile WEST of it — which in this projection is up-and-right plus
// up-and-left, i.e. the desk wraps the corner the sitter faces, the way a desk
// reads in any isometric game. The north block is the one that matters
// mechanically: OfficeFloor.facingForSeat probes (x, y-1) first, finds it
// non-walkable and asks the projection what that step looks like, which is the
// sprite sheet's back row — so you see the sitter's shoulders and the desk
// beyond them.
const SEATS = [
  ['desk-ceo', 2, 3],
  ['pc-1', 5, 3],
  ['pc-2', 8, 3],
  ['pc-3', 2, 7],
  ['pc-4', 5, 7],
  ['pc-5', 8, 7],
];
const DESKS = SEATS.flatMap(([, x, y]) => [[x, y - 1], [x - 1, y]]);

// A free-standing counter across the middle of the open floor, with a gap in
// it. This is here to be WALKED PAST: agents crossing the room from the door to
// their desks pass north of it (the counter hides their legs) and south of it
// (they hide the counter), which is the whole y-sorting claim made visible
// without needing to read a zIndex. The gap keeps the room navigable.
const COUNTER = [[2, 9], [3, 9], [4, 9], [7, 9], [8, 9], [9, 9]];

const ENTRANCE = [6, 11];

const floor = blank();
const walls = blank();
const furnitureBelow = blank();
const collision = blank();

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // Same 2x2 meta-tile cadence the orthogonal floors use, so the four
    // procedural variants alternate instead of one stamp repeating.
    floor[idx(x, y)] = FLOOR[(x % 2) + (y % 2) * 2];
    if (isWall(x, y)) {
      walls[idx(x, y)] = WALL;
      collision[idx(x, y)] = 1;
    }
  }
}
for (const [x, y] of [...DESKS, ...COUNTER]) {
  furnitureBelow[idx(x, y)] = DESK;
  collision[idx(x, y)] = 1;
}

const tileLayer = (name, data, id) => ({
  id, name, type: 'tilelayer', data,
  width: W, height: H, x: 0, y: 0, opacity: 1, visible: name !== 'collision',
});

const map = {
  // The one field that selects the projection — see TiledMapRenderer's ctor.
  orientation: 'isometric',
  renderorder: 'right-down',
  compressionlevel: -1,
  infinite: false,
  type: 'map',
  version: '1.10',
  tiledversion: '1.10.2',
  nextlayerid: 20,
  nextobjectid: 20,
  width: W,
  height: H,
  tilewidth: TILE_W,
  tileheight: TILE_H,
  // Read this before editing the file in Tiled — see COORDINATES above.
  properties: [
    {
      name: 'spawnPointSpace',
      type: 'string',
      value: 'GENERATED FILE (tools/build-iso-map.cjs) — do not edit in Tiled. '
        + 'spawn-point objects use this repo\'s parser convention '
        + '(x = tileX * tilewidth, y = tileY * tileheight), NOT Tiled\'s isometric '
        + 'object space (both axes scaled by tileheight). Opening and re-saving '
        + 'this map in Tiled will move every seat.',
    },
  ],
  layers: [
    tileLayer('floor', floor, 1),
    tileLayer('walls', walls, 2),
    tileLayer('furniture-below', furnitureBelow, 3),
    tileLayer('furniture-above', blank(), 4),
    tileLayer('collision', collision, 5),
    {
      id: 6, name: 'spawn-points', type: 'objectgroup', draworder: 'topdown',
      opacity: 1, visible: true, x: 0, y: 0,
      objects: [
        ...SEATS.map(([name, x, y], i) => ({
          id: 100 + i, name, type: '', point: true,
          x: x * TILE_W, y: y * TILE_H, width: 0, height: 0, rotation: 0, visible: true,
        })),
        {
          id: 199, name: 'entrance', type: '', point: true,
          x: ENTRANCE[0] * TILE_W, y: ENTRANCE[1] * TILE_H,
          width: 0, height: 0, rotation: 0, visible: true,
        },
      ],
    },
    // No `zones` layer on purpose: the only zone the scene reads is
    // `boardroom`, which adds overflow desk seating, and this prototype has
    // exactly the six seats above.
  ],
  tilesets: [
    // Metadata only — themeLoader.resolveThemeMap replaces this entry with the
    // theme's own TilesetEntry, and the image itself is generated (no file).
    {
      firstgid: 1, name: 'iso', image: 'iso',
      imagewidth: 128, imageheight: 64,
      tilewidth: 32, tileheight: 32, columns: 4, tilecount: 8,
      margin: 0, spacing: 0,
    },
  ],
};

const out = path.resolve(__dirname, '..', 'src/renderer/src/assets/maps/isometric.tmj');
fs.writeFileSync(out, JSON.stringify(map), 'utf8');
console.log(`wrote ${out} (${W}x${H}, ${SEATS.length} seats, ${DESKS.length} desks)`);
