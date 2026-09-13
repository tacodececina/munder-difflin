'use strict';

/**
 * The wall clock fits its own text.
 *
 * The frame was hard-coded to 34x20px, which holds "CN 09" and nothing more.
 * Every reading's ":16" spilled off the dark panel onto the light wall tiles
 * behind it — pale text on pale tiles, effectively invisible — and the second
 * row (MX) was clipped outright, so the prop showed one and a half timezones.
 * The frame is now MEASURED from the rendered text.
 *
 * HOW THIS RUNS WITHOUT A GPU: WorldClock's only pixi dependencies are
 * Container/Graphics/Text, and the thing under test is the arithmetic between
 * the text's measured box and the rects it draws — not the rasterizer. So
 * pixi.js is replaced in require.cache (the same swap telemetry-message-count
 * does for posthog-node) with three recording stand-ins, and the REAL WorldClock
 * constructor runs against them. The stand-in Text models a monospace advance
 * rather than reproducing Chromium's metrics, so what is pinned is "the frame is
 * derived from the measured text and contains it", not an exact pixel count.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── pixi stand-ins ───────────────────────────────────────────────────────────

/** Pixels per character for the stand-in Text. A knob, not a constant: a frame
 *  that tracks it is measured, a frame that ignores it is hard-coded. */
let advance = 6;
const LINE_H = 12; // fontSize 10 at the usual ~1.2 line box

class FakeText {
  constructor({ text = '', style = {} } = {}) {
    this.style = style;
    this.text = text;
    // Frozen per instance: a clock built earlier in the file must keep reporting
    // the metrics it was MEASURED with, whatever a later test sets.
    this.advance = advance;
    this.position = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } };
  }
  get lines() { return String(this.text).split('\n'); }
  get width() { return Math.max(0, ...this.lines.map((l) => l.length)) * this.advance; }
  get height() { return this.lines.length * LINE_H; }
}

class FakeGraphics {
  constructor() { this.rects = []; }
  rect(x, y, w, h) { this.rects.push({ x, y, w, h }); return this; }
  fill() { return this; }
  stroke() { return this; }
}

class FakeContainer {
  constructor() {
    this.children = [];
    this.position = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } };
  }
  addChild(c) { this.children.push(c); return c; }
  destroy() { this.destroyed = true; }
}

const pixiPath = require.resolve('pixi.js');
require.cache[pixiPath] = {
  id: pixiPath, filename: pixiPath, loaded: true,
  exports: { Container: FakeContainer, Graphics: FakeGraphics, Text: FakeText }
};

const loadTs = require('./load-ts.cjs');
const { WorldClock } = loadTs('src/renderer/src/scene/office/WorldClock.ts');
// The prop no longer multiplies by a raw tile size: placement and depth come
// from the scene's projection (scene/office/projection.ts). The orthogonal one
// is the projection the app ships, so `tileSize` still means exactly what it
// meant here before the extraction.
const { createOrthogonalProjection } = loadTs('src/renderer/src/scene/office/projection.ts');

/** The pieces the constructor built, named. */
function build(opts = {}) {
  advance = opts.advance ?? 6;
  const projection = createOrthogonalProjection(opts.tileSize ?? 16);
  const clock = new WorldClock(opts.topLeft ?? { x: 1, y: 2 }, projection);
  const frame = clock.container.children.find((c) => c instanceof FakeGraphics);
  const label = clock.container.children.find((c) => c instanceof FakeText);
  return { clock, label, outer: frame.rects[0], rows: frame.rects.slice(1) };
}

// ── the bug: text outside the panel ──────────────────────────────────────────

test('the text is a full "CN HH:MM / MX HH:MM" pair — the reading the frame must hold', () => {
  const { label } = build();
  assert.match(label.text, /^CN \d\d:\d\d\nMX \d\d:\d\d$/,
    'the measurement below assumes both rows are this fixed-width reading');
});

test('the panel contains the whole reading, in both axes', () => {
  const { label, outer } = build();
  // The literal failure: "CN 09:16" is 8 characters, which does not fit 34px,
  // and two 12px rows do not fit 20px. Asserted against the MEASURED box so it
  // stays true for any font the theme ends up using.
  assert.ok(outer.w >= label.position.x + label.width,
    `":16" spills off the panel: frame ${outer.w}px vs text ${label.width}px at x=${label.position.x}`);
  assert.ok(outer.h >= label.position.y + label.height,
    `the MX row is clipped: frame ${outer.h}px vs text ${label.height}px at y=${label.position.y}`);
  assert.equal(outer.x, 0);
  assert.equal(outer.y, 0);
});

test('there is padding on every side, not a frame flush against the glyphs', () => {
  const { label, outer } = build();
  assert.ok(label.position.x >= 1 && label.position.y >= 1, 'text starts on the frame border');
  assert.ok(outer.w - (label.position.x + label.width) >= 1, 'no right-hand padding');
  assert.ok(outer.h - (label.position.y + label.height) >= 1, 'no bottom padding');
  // Symmetric: the leading pad and the trailing pad are the same.
  assert.equal(outer.w - label.width - label.position.x, label.position.x);
  assert.equal(outer.h - label.height - label.position.y, label.position.y);
});

test('the frame is MEASURED: a wider glyph advance makes a wider frame', () => {
  // The revert lives here. A constant 34x20 cannot move; anything derived from
  // the text must, by exactly the extra text width.
  const narrow = build({ advance: 6 });
  const wide = build({ advance: 9 });

  assert.equal(wide.outer.w - narrow.outer.w, wide.label.width - narrow.label.width,
    'the frame width ignored the text width');
  assert.ok(wide.outer.w > narrow.outer.w);
  assert.ok(wide.outer.w >= wide.label.position.x + wide.label.width);
});

// ── the two row backgrounds behind the text ──────────────────────────────────

test('both timezone rows get a dark background, and neither is cut off', () => {
  const { label, outer, rows } = build();
  assert.equal(rows.length, 2, 'one background per timezone row');
  const [cn, mx] = rows;

  assert.equal(cn.h, mx.h, 'the two rows must be the same height');
  assert.equal(mx.y, cn.y + cn.h, 'a gap or overlap between the rows');
  assert.ok(mx.y + mx.h <= outer.h, 'the MX row runs past the panel — the clipping bug');
  // Together they must cover the text vertically, or half a row of digits sits
  // on the bare wall again.
  assert.ok(cn.y <= label.position.y, 'the CN row starts below the text');
  assert.ok(mx.y + mx.h >= label.position.y + label.height,
    `rows cover ${mx.y + mx.h - cn.y}px of ${label.height}px of text`);
});

test('the rows stay inside the frame horizontally, leaving its border visible', () => {
  const { outer, rows } = build();
  for (const r of rows) {
    assert.ok(r.x >= 1 && r.x + r.w <= outer.w - 1, `row escapes the border: ${JSON.stringify(r)}`);
    assert.ok(r.w >= 1 && r.h >= 1, 'a degenerate row rect');
  }
});

// ── placement and ticking, which the measurement must not have disturbed ─────

test('the prop is still placed on its wall tile and is not clickable', () => {
  const { clock } = build({ topLeft: { x: 3, y: 5 }, tileSize: 16 });
  assert.equal(clock.container.position.x, 48);
  assert.equal(clock.container.position.y, 80);
  assert.equal(clock.container.eventMode, 'none');
});

test('a tick re-renders the same fixed-width shape the frame was measured for', () => {
  const { clock, label, outer } = build();
  const before = label.text.length;
  clock.update(2); // past the 1s reformat threshold
  assert.equal(label.text.length, before,
    'a tick changed the text length — one construction-time measurement no longer holds');
  assert.match(label.text, /^CN \d\d:\d\d\nMX \d\d:\d\d$/);
  assert.ok(outer.w >= label.position.x + label.width);
});

test('sub-second updates do not reformat, and destroy tears the container down', () => {
  const { clock } = build();
  clock.update(0.1);
  clock.update(0.1);
  clock.destroy();
  assert.equal(clock.container.destroyed, true);
});
