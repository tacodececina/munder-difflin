// The office floor's RENDERING SHAPE, without the app. See office-gpu-probe.cjs.
// Bundled to office-gpu-probe.bundle.js by the probe's own build step.
import * as PIXI from 'pixi.js';

const TILE = 16, MAP_W = 48, MAP_H = 36;
// The real map's non-empty cell counts, per rendered layer (office.tmj):
// floor / walls / furniture-below / furniture-above.
const LAYER_TILES = [1472, 375, 462, 235];
const ATLAS_W = 256, ATLAS_H = 992;

let app, world, panel, state;

function buildAtlas() {
  const c = document.createElement('canvas');
  c.width = ATLAS_W; c.height = ATLAS_H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(ATLAS_W, ATLAS_H);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (i * 7) & 255; img.data[i + 1] = (i * 13) & 255;
    img.data[i + 2] = (i * 29) & 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = PIXI.Texture.from(c);
  t.source.scaleMode = 'nearest';
  return t;
}

/** The wall instrument: ONE canvas, ONE texture, re-uploaded on paint().
 *  Same size and same code path as scene/office/WallPanel.ts. */
function makePanel(parent) {
  const c = document.createElement('canvas');
  c.width = 212; c.height = 34;
  const ctx = c.getContext('2d');
  const tex = PIXI.Texture.from(c);
  tex.source.scaleMode = 'nearest';
  const s = new PIXI.Sprite(tex);
  s.x = 80; s.y = 16;
  parent.addChild(s);
  const buf = new Uint8ClampedArray(212 * 34 * 4);
  let n = 0;
  return {
    get paints() { return n; },
    paint() {
      const image = ctx.createImageData(212, 34);
      for (let i = 0; i < buf.length; i++) buf[i] = (i + n) & 255;
      image.data.set(buf);
      ctx.putImageData(image, 0, 0);
      tex.source.update();
      n++;
    }
  };
}

/** Overrides the probe's main process passes in on the URL, so the two cost
 *  knobs (backing-store resolution, frame cap) can be measured rather than
 *  argued about. Absent → exactly what OfficeFloor ships today. */
function knob(name, fallback) {
  const v = new URLSearchParams(location.search).get(name);
  return v === null ? fallback : Number(v);
}

function syntheticFixture(id) {
  if (id !== 'synthetic-office-11' && id !== 'synthetic-office-19') return null;
  const count = id.endsWith('-11') ? 11 : 19;
  return {
    id,
    agents: Array.from({ length: count }, (_, i) => `fixture-agent-${String(i + 1).padStart(2, '0')}`),
  };
}

/** What the GL context says it is running on — the string the fix keys off. */
function readRendererName(a) {
  try {
    const gl = a.renderer?.gl;
    if (!gl) return '(no gl)';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch (e) { return '(error ' + e + ')'; }
}

async function boot() {
  const host = document.getElementById('host');
  const economy = knob('economy', 0) > 0;
  app = new PIXI.Application();
  await app.init({
    background: 0x12131a,
    antialias: false,
    roundPixels: true,
    // Exactly what OfficeFloor asks for, unless the probe overrides it.
    resolution: knob('res', Math.max(window.devicePixelRatio || 1, 2)),
    autoDensity: true,
    width: host.clientWidth,
    height: host.clientHeight,
  });
  const fps = knob('fps', economy ? 2 : 0);
  if (fps > 0) app.ticker.maxFPS = fps;
  host.appendChild(app.canvas);

  const fixture = syntheticFixture(new URLSearchParams(location.search).get('fixture'));

  const atlas = buildAtlas();
  world = new PIXI.Container();
  app.stage.addChild(world);

  const charLayer = new PIXI.Container();
  charLayer.sortableChildren = true;

  // `sorted` = how many of the furniture-above tiles are handed to the SORTED
  // container instead of their own flat one. The total sprite count is
  // identical either way; only the membership of the per-frame zIndex pass
  // changes, which is the cost the occlusion fix had to be weighed against.
  // 0 = the floor as it was, 48 = what tileOcclusion.ts actually selects on the
  // office map, 235 = the rejected "sort the whole furniture-above layer".
  const sortedTiles = knob('sorted', 0);
  const cells = (ATLAS_W / TILE) * (ATLAS_H / TILE);
  LAYER_TILES.forEach((count, li) => {
    const isAbove = li === LAYER_TILES.length - 1;
    const layer = new PIXI.Container();
    let placed = 0;
    for (let y = 0; y < MAP_H && placed < count; y++) {
      for (let x = 0; x < MAP_W && placed < count; x++) {
        const localId = (x * 7 + y * 13) % cells;
        const frame = new PIXI.Rectangle((localId % 16) * TILE, Math.floor(localId / 16) * TILE, TILE, TILE);
        const sp = new PIXI.Sprite(new PIXI.Texture({ source: atlas.source, frame }));
        sp.x = x * TILE; sp.y = y * TILE;
        if (isAbove && placed < sortedTiles) {
          sp.zIndex = (y + 1) * TILE + 1;
          charLayer.addChild(sp);
        } else {
          layer.addChild(sp);
        }
        placed++;
      }
    }
    world.addChild(layer);
  });

  world.addChild(charLayer);
  panel = makePanel(charLayer);
  panel.paint();

  // The cast and the props that already live in the sorted container. The first
  // WALKERS of them rewrite their zIndex every frame, which is what makes the
  // container re-sort at all.
  const WALKERS = 15;
  const cast = [];
  const fixtureAgents = fixture?.agents ?? [];
  for (let i = 0; i < (fixture ? fixtureAgents.length : knob('cast', 0)); i++) {
    const c = new PIXI.Container();
    const frameY = Math.floor((i % 32) / 16) * TILE;
    const frames = [0, 1, 2, 1].map((col) => new PIXI.Texture({
      source: atlas.source,
      frame: new PIXI.Rectangle(col * TILE, frameY, TILE, TILE * 2),
    }));
    const sp = new PIXI.AnimatedSprite(frames);
    sp.animationSpeed = 0.06;
    if (economy) sp.gotoAndStop(0); else sp.play();
    sp.anchor.set(0.5, 1);
    c.addChild(sp);
    c.x = (i * 37) % (MAP_W * TILE);
    c.y = (i * 53) % (MAP_H * TILE);
    c.zIndex = c.y;
    charLayer.addChild(c);
    c.label = fixtureAgents[i] ?? `synthetic-cast-${i + 1}`;
    cast.push(c);
  }

  // Camera state; the arithmetic below is copied verbatim from Camera.ts.
  const view = { w: app.screen.width, h: app.screen.height };
  const map = { w: MAP_W * TILE, h: MAP_H * TILE };
  const minZoom = Math.min(view.w / map.w, view.h / map.h);
  const cam = { x: map.w / 2, y: map.h / 2, zoom: minZoom, tx: map.w / 2, ty: map.h / 2, tz: minZoom };

  state = {
    scenario: 'idle', frames: 0, acc: 0, paintsAtStart: 0,
    dirty: false, changeAt: 0, renderLatencyMs: null,
  };

  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS / 1000;
    state.frames++;
    if (economy && state.dirty) {
      state.renderLatencyMs = +(performance.now() - state.changeAt).toFixed(1);
      state.dirty = false;
      app.ticker.stop();
    }

    if (state.scenario !== 'idle') {
      // Camera.update(), unchanged — including the two writes to container.x.
      cam.x += (cam.tx - cam.x) * 0.08;
      cam.y += (cam.ty - cam.y) * 0.08;
      cam.zoom += (cam.tz - cam.zoom) * 0.08;
      world.scale.set(cam.zoom);
      world.x = view.w / 2 - cam.x * cam.zoom;
      world.y = view.h / 2 - cam.y * cam.zoom;
      const sw = map.w * cam.zoom, sh = map.h * cam.zoom;
      if (sw <= view.w) world.x = (view.w - sw) / 2;
      else world.x = Math.min(0, Math.max(view.w - sw, world.x));
      if (sh <= view.h) world.y = (view.h - sh) / 2;
      else world.y = Math.min(0, Math.max(view.h - sh, world.y));
    }

    // Walking avatars: a new world Y, and therefore a new zIndex, every frame —
    // the thing that dirties the sort.
    if (state.scenario !== 'off') {
      for (let i = 0; i < Math.min(WALKERS, cast.length); i++) {
        const c = cast[i];
        c.y = (c.y + 1) % (MAP_H * TILE);
        c.zIndex = c.y;
      }
    }

    if (state.scenario === 'panel60hz') {
      panel.paint();
    } else if (state.scenario === 'panel1hz') {
      state.acc += dt;
      if (state.acc >= 1) { state.acc = 0; panel.paint(); }
    }
  });

  window.__probe = {
    start(scenario) {
      // `off` is the floor paused the way OfficeFloor pauses it behind a
      // fullscreen terminal: the ticker stops, the scene graph and the GL
      // context stay. It is the floor's true zero.
      state.scenario = scenario;
      state.frames = 0;
      state.acc = 0;
      state.paintsAtStart = panel.paints;
      state.dirty = economy && scenario !== 'off';
      state.changeAt = state.dirty ? performance.now() : 0;
      state.renderLatencyMs = null;
      if (scenario === 'off') app.ticker.stop(); else app.ticker.start();
    },
    change() {
      if (!economy) return;
      state.dirty = true;
      state.changeAt = performance.now();
      app.ticker.start();
    },
    stats() {
      return {
        frames: state.frames,
        paints: panel.paints - state.paintsAtStart,
        canvas: `${app.canvas.width}x${app.canvas.height}`,
        resolution: app.renderer.resolution,
        gpu: readRendererName(app),
        economy,
        mode: economy ? 'software-economy' : 'continuous',
        renderLatencyMs: state.renderLatencyMs,
        fixture: fixture?.id ?? null,
        fixtureAgents,
      };
    }
  };
}

window.__probeReady = boot().catch((e) => { console.log('BOOT ERROR: ' + ((e && e.stack) || e)); throw e; });
