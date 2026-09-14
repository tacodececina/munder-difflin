'use strict';
// Dumps the two wall instruments — baked prop + live readout composited over it
// — as base64 RGBA on stdout, one entry per scene, for a visual check that the
// readings are legible at this pixel size. Same "RGBA bridge, not a second art
// implementation" contract as export-tech-preview.cjs: this composites exactly
// the buffers Pixi composites, through the same functions.
//
// The scenes are the ones worth LOOKING at rather than asserting on: a busy
// floor, a floor where every source answered zero, and a floor where none of
// them answered at all. "no data looks different from zero" is pinned in
// test/office-wall-readout.test.cjs; whether it also READS different is a
// judgement only an eye can make.
//
//   node tools/mapgen/preview-wall-readout.cjs > scenes.json
//   # then decode each entry with any image tool, e.g. PIL:
//   #   Image.frombytes('RGBA', (w, h), base64.b64decode(rgba))
const loadTs = require('../../test/load-ts.cjs');
const {
  drawTechProp, drawOpsReadout, drawPlanReadout, OPS_READOUT_RECT, PLAN_READOUT_RECT, rgbFromHex
} = loadTs('src/renderer/src/scene/office/techOfficeArt.ts');
const { TILE_PALETTES } = loadTs('src/renderer/src/scene/office/tileArt.ts');

const pal = TILE_PALETTES['office-tech'];
const ink = {
  todo: rgbFromHex(0xf2df8a), doing: rgbFromHex(0x9ecbf0),
  blocked: rgbFromHex(0xf0a3a3), done: rgbFromHex(0xa8e0b0),
};

/** Paint `src` into `dst` at (ox,oy). */
function blit(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      if (src.data[s + 3] === 0) continue;
      const d = ((oy + y) * dst.width + (ox + x)) * 4;
      dst.data.set(src.data.subarray(s, s + 4), d);
    }
  }
}

function frame(prop, rect, readout) {
  const base = drawTechProp(prop, pal);
  const out = { data: new Uint8ClampedArray(base.data), width: base.width, height: base.height };
  blit(out, readout, rect.x, rect.y);
  return out;
}

const SCENES = [
  ['live', frame('screen', OPS_READOUT_RECT, drawOpsReadout({
    agents: ['healthy', 'healthy', 'steering', 'healthy', 'constrained', 'healthy', 'stopped'],
    ci: ['pass', 'fail', 'pass', 'pass', 'running'],
    shipped: [0, 2, 5, 1, 0, 0, 3, 9, 2],
  }, pal, ink))],
  ['empty', frame('screen', OPS_READOUT_RECT, drawOpsReadout({
    agents: null, ci: [], shipped: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  }, pal, ink))],
  ['nodata', frame('screen', OPS_READOUT_RECT, drawOpsReadout(
    { agents: null, ci: null, shipped: null }, pal, ink))],
  ['board', frame('whiteboard', PLAN_READOUT_RECT,
    drawPlanReadout({ plan: 7, build: 2, blocked: 1, ship: 23 }, pal, ink))],
  ['board-zero', frame('whiteboard', PLAN_READOUT_RECT,
    drawPlanReadout({ plan: 0, build: 0, blocked: 0, ship: 0 }, pal, ink))],
  ['board-nodata', frame('whiteboard', PLAN_READOUT_RECT, drawPlanReadout(null, pal, ink))],
];

process.stdout.write(JSON.stringify(SCENES.map(([name, buf]) => ({
  name, width: buf.width, height: buf.height,
  rgba: Buffer.from(buf.data).toString('base64'),
}))));
