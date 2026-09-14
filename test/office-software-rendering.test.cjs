'use strict';

// THE FLOOR MUST NOTICE WHEN IT IS BEING DRAWN BY THE CPU.
//
// The bug: Chromium's gpu-process burning 5.72 s of CPU per second of wall
// clock — near six cores — while the renderer and main processes stayed normal
// and the window kept responding. Measured with tools/perf/office-gpu-probe.cjs,
// which samples app.getAppMetrics() per process type while rendering the office
// floor's exact shape, the cause is not in the scene:
//
//   hardware GL (ANGLE/D3D11, AMD Radeon 890M)   gpu-process  0.12 s CPU / s
//   software GL (ANGLE/SwiftShader), same scene  gpu-process 13.17 s CPU / s
//
// Same scene graph, same frame loop, same everything — 110x, and the renderer
// process does not move. Chromium chooses that fallback for itself and never
// revisits it, so the app has to notice and draw a cheaper floor.
//
// This suite pins the classifier against the renderer strings the real backends
// report (captured from that probe, not invented) and the budget it produces.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  isSoftwareRenderer, renderBudget, probeRendererName,
  SOFTWARE_FRAME_CAP, SOFTWARE_RESOLUTION,
} = loadTs('src/renderer/src/scene/office/softwareRendering.ts');

// Verbatim from the probe on this machine — the two strings the whole diagnosis
// turned on.
const HARDWARE = 'ANGLE (AMD, AMD Radeon(TM) 890M Graphics (0x0000150E) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SOFTWARE = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';

test('the two strings the measurement was taken on classify correctly', () => {
  assert.equal(isSoftwareRenderer(HARDWARE), false);
  assert.equal(isSoftwareRenderer(SOFTWARE), true);
});

test('every software backend Chromium can land on is recognised', () => {
  for (const name of [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)',
    'Google SwiftShader',
    'ANGLE (SwANGLE (Google SwiftShader Device (Subzero)))',
    'Mesa/X.org, llvmpipe (LLVM 15.0.6, 256 bits)',
    'Mesa, softpipe',
    'llvmpipe (LLVM 17.0.6, 128 bits)',
    'Microsoft Basic Render Driver',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Unknown, WARP Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Microsoft Direct3D12 (WARP)',
  ]) {
    assert.equal(isSoftwareRenderer(name), true, `not recognised as software: ${name}`);
  }
});

test('WARP is matched as a word, not as four letters found anywhere', () => {
  // Every other marker is long enough to be safe on its own; 'warp' is not.
  // Matching it as a substring would degrade a healthy floor — halve its
  // resolution, cap its ticker — over a coincidence of spelling, which is the
  // exact mistake the marker list is otherwise careful to avoid. The real
  // spellings always stand the word alone, so a boundary costs nothing.
  for (const name of [
    'ANGLE (Unknown, WARP Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Microsoft Direct3D12 (WARP)',
    'WARP',
  ]) {
    assert.equal(isSoftwareRenderer(name), true, `a real WARP was missed: ${name}`);
  }
  for (const name of [
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Warpdrive Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Acme Timewarp GPU OpenGL Engine',
    'ANGLE (Acme, Warpcore XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ]) {
    assert.equal(isSoftwareRenderer(name), false, `misread as software: ${name}`);
  }
});

test('real GPUs are never mistaken for software', () => {
  for (const name of [
    HARDWARE,
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
    'AMD Radeon Pro 5500M OpenGL Engine',
  ]) {
    assert.equal(isSoftwareRenderer(name), false, `misread as software: ${name}`);
  }
});

test('an unreadable answer is NOT treated as software', () => {
  // WEBGL_debug_renderer_info is optional and can be withheld. Degrading a
  // healthy floor because we could not ask would be a self-inflicted
  // regression on every machine with the extension turned off.
  for (const name of [null, undefined, '', 0, {}]) {
    assert.equal(isSoftwareRenderer(name), false);
  }
});

test('the hardware budget is byte-for-byte what the floor asked for before', () => {
  // OfficeFloor's original expression: Math.max(window.devicePixelRatio || 1, 2)
  for (const dpr of [1, 1.25, 1.5, 2, 2.5, 3, 0, NaN]) {
    const b = renderBudget(HARDWARE, dpr);
    assert.equal(b.resolution, Math.max(dpr || 1, 2), `dpr ${dpr}`);
    assert.equal(b.maxFPS, 0, 'a healthy floor must stay uncapped');
    assert.equal(b.software, false);
  }
});

test('the software budget drops both dials, and says which renderer decided it', () => {
  const b = renderBudget(SOFTWARE, 2.5);
  assert.equal(b.software, true);
  assert.equal(b.resolution, SOFTWARE_RESOLUTION, 'four times the pixels is not worth four cores');
  assert.equal(b.maxFPS, SOFTWARE_FRAME_CAP);
  assert.equal(b.renderer, SOFTWARE, 'the log line needs the string the decision was made on');
  // Sanity on the dial itself: cost is linear in frames, so a cap that is not
  // well below a display refresh would not move the number at all. The bound is
  // deliberately loose on the top side because Pixi's cap is NOMINAL — it
  // refunds whatever a frame overshot it by, and on an irregular software
  // backend a nominal 8 was measured delivering 11.0 fps (probe, 88 frames in
  // 8.02 s). The number that has to stay small is this one; what it buys is the
  // measured 12.29 → 3.60 s CPU/s in the gpu-process.
  assert.ok(SOFTWARE_FRAME_CAP > 0 && SOFTWARE_FRAME_CAP < 20);
});

test('probing for a renderer never throws where there is no DOM', () => {
  // It runs inside OfficeFloor's init, before anything is rendered; a throw
  // there would take the whole floor down over a diagnostic.
  assert.equal(probeRendererName(), null);
});
