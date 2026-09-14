'use strict';
// RGBA bridge, not a second art implementation. Python consumes exactly the
// buffers Pixi receives, with the same monitor-display offsets.
const fs = require('node:fs');
const loadTs = require('../../test/load-ts.cjs');
const { buildTechOfficeAtlas } = loadTs('src/renderer/src/scene/office/techOfficeArt.ts');
const { monitorVisualOffsets, monitorDisplayGid } = loadTs('src/renderer/src/scene/office/deskVisuals.ts');
const atlas = buildTechOfficeAtlas();
const map = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const offsets = monitorVisualOffsets(map);
const above = map.layers.find(l => l.name === 'furniture-above').data;
process.stdout.write(JSON.stringify({
  width: atlas.width, height: atlas.height, columns: atlas.columns,
  rgba: Buffer.from(atlas.data).toString('base64'),
  monitorOffsets: Object.fromEntries(offsets),
  monitorGids: Object.fromEntries([...offsets].map(([k, dy]) => {
    const [x, y] = k.split(',').map(Number);
    return [k, monitorDisplayGid(above[y * map.width + x], dy)];
  })),
}));
