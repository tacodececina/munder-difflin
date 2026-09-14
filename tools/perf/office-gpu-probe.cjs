'use strict';

/**
 * GPU-PROCESS COST PROBE for the office floor.
 *
 * The bug this exists for: `--type=gpu-process` burning ~5.7 s of CPU per real
 * second while the renderer and main processes stay normal. You cannot reason
 * that out of a diff — the renderer's own profiler does not see the GPU
 * process at all. Electron does: `app.getAppMetrics()` reports cumulative CPU
 * per child process, TYPED, so the gpu-process line can be sampled directly.
 *
 * This harness rebuilds the SHAPE of the office floor (a 48x36 tile map of
 * sprites off one procedural atlas, a world container driven by the same
 * camera arithmetic, optional live wall panels) in a throwaway window, and
 * reports CPU per process type per scenario. No app state, no agents, no IPC:
 * only the rendering.
 *
 * Run it with Electron, not node (it needs a window and app.getAppMetrics):
 *
 *   node_modules/.bin/electron tools/perf/office-gpu-probe.cjs
 *   node_modules/.bin/electron tools/perf/office-gpu-probe.cjs --software camera
 *   node_modules/.bin/electron tools/perf/office-gpu-probe.cjs --software --res=1 --fps=8
 *
 * Results go to office-gpu-probe.log beside this file — on Windows, Electron is
 * a GUI-subsystem binary and its stdout never reaches the shell.
 *
 * Scenarios (see office-gpu-probe.src.mjs for what each one turns on):
 *   off       ticker stopped — the floor's true zero
 *   idle      rendering every frame, static world transform
 *   camera    + Camera.update()'s per-frame transform write — as shipped
 *   panel1hz  + a wall panel repainted once a second — as shipped
 *   panel60hz + a wall panel repainted EVERY FRAME — the original hypothesis
 *
 * Switches: `--software` forces SwiftShader; `--res=N` / `--fps=N` override the
 * two dials renderBudget() sets (scene/office/softwareRendering.ts).
 *
 * WHAT IT MEASURED (this machine, 24 threads, 1280x800 window, `camera`):
 *
 *   backend                                      gpu-process   renderer
 *   hardware  ANGLE/D3D11, Radeon 890M, res 2      0.09 s/s     0.07 s/s
 *   software  ANGLE/SwiftShader,        res 2     13.39 s/s     0.04 s/s
 *   software  ANGLE/SwiftShader,        res 1     12.29 s/s     0.11 s/s
 *   software  + renderBudget (res 1, maxFPS 8)     3.60 s/s     0.05 s/s
 *   software  + res 1, maxFPS 5                    2.21 s/s     0.04 s/s
 *   software  ticker stopped                       0.05 s/s     0.02 s/s
 *
 * `--fps=N` is NOMINAL: Pixi's ticker refunds whatever a frame overshot the cap
 * by, so an irregular software backend delivers more than it was asked for —
 * the rows above ran at 33.7 / 11.0 / 6.9 fps for caps of 0 / 8 / 5 (frame
 * counts are in the log beside each row). Cost is linear in the frames it
 * actually rendered, ~0.32 s CPU per frame in all three.
 *
 * and, in every one of those rows, repainting the wall instrument at 60 Hz
 * instead of 1 Hz moved the gpu-process number by less than the run-to-run
 * noise. The texture upload was not the bug; the backend was.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// Electron is a GUI-subsystem binary on Windows: console.log from the main
// process never reaches the parent shell. Everything goes to a file.
const LOG = path.join(__dirname, 'office-gpu-probe.log');
fs.writeFileSync(LOG, '');
const log = (...parts) => {
  const line = parts.join(' ');
  fs.appendFileSync(LOG, line + '\n');
};

const SCENARIOS = ['off', 'idle', 'camera', 'panel1hz', 'panel60hz'];
const WARMUP_MS = 3000;
const SAMPLE_MS = 8000;

const wanted = process.argv.slice(2).filter((a) => SCENARIOS.includes(a));
const run = wanted.length > 0 ? wanted : SCENARIOS;

// `--software` reproduces what Chromium does when it cannot use the real GPU:
// it runs the whole GL stack on SwiftShader, INSIDE the gpu-process, on a
// thread pool sized to the machine's cores. This is the control condition for
// "is the office scene expensive, or is the backend wrong?".
const SOFTWARE = process.argv.includes('--software');
if (SOFTWARE) {
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
}

// The probe's renderer imports pixi.js, whose CJS build pulls in an ESM-only
// dependency; the file:// page therefore needs a bundle rather than a <script>.
// Built here, on demand, so the 1.5 MB artefact never has to be committed.
const BUNDLE = path.join(__dirname, 'office-gpu-probe.bundle.js');
function ensureBundle() {
  const src = path.join(__dirname, 'office-gpu-probe.src.mjs');
  const fresh = fs.existsSync(BUNDLE)
    && fs.statSync(BUNDLE).mtimeMs >= fs.statSync(src).mtimeMs;
  if (fresh) return;
  const esbuild = path.join(__dirname, '..', '..', 'node_modules', '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  const res = require('node:child_process').spawnSync(esbuild, [
    src, '--bundle', '--format=iife', '--platform=browser',
    `--outfile=${BUNDLE}`, '--log-level=warning',
  ], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) throw new Error('could not bundle the probe renderer');
}

/** CPU seconds per process type, summed. `cpu.cumulativeCPUUsage` is seconds. */
function snapshot() {
  const out = new Map();
  for (const m of app.getAppMetrics()) {
    const type = m.type || 'unknown';
    const used = typeof m.cpu?.cumulativeCPUUsage === 'number' ? m.cpu.cumulativeCPUUsage : 0;
    out.set(type, (out.get(type) ?? 0) + used);
  }
  return out;
}

function delta(before, after, seconds) {
  const rows = [];
  for (const [type, end] of after) {
    const start = before.get(type) ?? 0;
    rows.push({ type, cpuSecondsPerSecond: +((end - start) / seconds).toFixed(3) });
  }
  return rows.sort((a, b) => b.cpuSecondsPerSecond - a.cpuSecondsPerSecond);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(win, scenario) {
  await win.webContents.executeJavaScript(`window.__probe.start(${JSON.stringify(scenario)})`);
  await sleep(WARMUP_MS);
  const before = snapshot();
  const t0 = Date.now();
  await sleep(SAMPLE_MS);
  const after = snapshot();
  const seconds = (Date.now() - t0) / 1000;
  const frames = await win.webContents.executeJavaScript('window.__probe.stats()');
  return { scenario, seconds: +seconds.toFixed(2), ...frames, cpu: delta(before, after, seconds) };
}

ensureBundle();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
    },
  });
  log('[probe] software=' + SOFTWARE + ' cores=' + require('node:os').cpus().length);
  log('[probe] gpu feature status ' + JSON.stringify(app.getGPUFeatureStatus()));
  win.webContents.on('console-message', (_e, _lvl, msg) => log("[renderer]", msg));
  const query = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--(res|fps|sorted|cast)=(\d+(?:\.\d+)?)$/.exec(a);
    if (m) query[m[1]] = m[2];
  }
  await win.loadFile(path.join(__dirname, 'office-gpu-probe.html'), { query });
  log('[probe] knobs ' + JSON.stringify(query));
  try {
    await win.webContents.executeJavaScript('window.__probeReady');
  } catch (err) {
    log("[probe] boot failed:", err && err.message ? err.message : err);
    app.exit(1);
    return;
  }

  const results = [];
  for (const scenario of run) {
    const r = await measure(win, scenario);
    results.push(r);
    log(`=== ${r.scenario} === ${r.seconds}s, ${r.frames} frames (${(r.frames / r.seconds).toFixed(1)} fps), ${r.paints} panel paints`);
    for (const row of r.cpu) log(`    ${row.type.padEnd(14)} ${row.cpuSecondsPerSecond.toFixed(3)} s CPU / s`);
  }
  log('JSON ' + JSON.stringify(results));
  app.exit(0);
});
