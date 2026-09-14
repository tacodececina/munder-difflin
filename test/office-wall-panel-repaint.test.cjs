'use strict';

// HOW OFTEN DO THE WALL INSTRUMENTS ACTUALLY RE-UPLOAD THEIR TEXTURE?
//
// WHY THIS SUITE EXISTS. The office was reported burning ~5.7 s of GPU-process
// CPU per second of wall clock, and the first suspect was WallPanel.paint():
// it ends in `this.texture.source.update()`, which is a texture upload to the
// GPU, and a texture upload every frame is exactly the shape of that symptom.
// The repaint is supposed to be held back by a SIGNATURE check — repaint only
// when the reading changed — and a signature that is not stable when the data
// is unchanged would defeat it silently. Nothing throws when that happens; the
// wall just looks right while the machine melts.
//
// So this is a COUNTER, not an assertion about shape: it drives the exact guard
// OfficeFloor wraps around `paint()` over ten simulated minutes of ticks and
// polls, and reports the number. The control case — the same ten minutes with
// the guard removed — is measured alongside it, so the difference is a number
// rather than a claim.
//
// (The verdict, for the record: the guard holds. The panel repaints on the
// order of once a minute, not once a frame. The 5.7 s/s had another cause —
// see src/renderer/src/scene/office/softwareRendering.ts and
// tools/perf/office-gpu-probe.cjs, which measured the gpu-process directly and
// found the whole scene costs 0.12 s/s on a GPU and 13 s/s in software.)

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { FloorWeather, BREAKER_BEAT_MS } = loadTs('src/renderer/src/scene/office/weather.ts');
const {
  agentPips, heldValue, readoutSignature, planSignature, bucketShipped,
  CI_TTL_MS, SHIPPED_TTL_MS, PLAN_TTL_MS, SHIPPED_POLL_MS, SHIPPED_LOG_WINDOW,
} = loadTs('src/renderer/src/scene/office/wallReadout.ts');

const FPS = 60;
const FRAME_MS = 1000 / FPS;

/**
 * The floor's wall-instrument wiring, lifted out of OfficeFloor.tsx's init
 * effect with nothing changed but the panel (a counter instead of a canvas) and
 * the clock (simulated instead of Date.now). If this drifts from the scene the
 * measurement stops meaning anything, so it is deliberately a transcription:
 *
 *   - `updateOpsPanel`  — the ~1 Hz accumulator on the ticker.
 *   - `paintOps`        — build the readout, compare signatures, repaint.
 *   - `pollShipped`     — the 60 s hive/log.jsonl read, then paintOps.
 *   - `pollTaskBoard`   — the 5 s ledger read that also drives paintPlan.
 *
 * @param guarded false removes ONLY the signature check — the control case.
 */
function runFloor({ seconds, guarded = true, agents = 6, churn = false }) {
  const weather = new FloorWeather();
  const present = new Set(Array.from({ length: agents }, (_, i) => `agent-${i}`));

  let now = 1_800_000_000_000;
  let opsPaints = 0;
  let planPaints = 0;
  let opsSignature = '';
  let planSig = '';
  let heldCI = null;
  let heldShipped = null;
  let heldPlan = null;

  const paintOps = () => {
    const readout = {
      agents: agentPips(weather.fresh(now, present), now, present),
      ci: heldValue(heldCI, now, CI_TTL_MS),
      shipped: heldValue(heldShipped, now, SHIPPED_TTL_MS),
    };
    const sig = readoutSignature(readout);
    if (guarded && sig === opsSignature) return;
    opsSignature = sig;
    opsPaints++;
  };
  const paintPlan = () => {
    const board = heldValue(heldPlan, now, PLAN_TTL_MS);
    const sig = planSignature(board);
    if (guarded && sig === planSig) return;
    planSig = sig;
    planPaints++;
  };

  // Cold start: both surfaces open on NO DATA, exactly as the scene does.
  opsPaints++;
  planPaints++;

  // A quiet but REALISTIC floor: every agent reports `healthy` on the breaker's
  // 30 s beat, the ledger holds steady, and the event feed is a short (complete)
  // one. Nothing a human would call "a change" happens at all — which is the
  // condition the guard has to survive.
  const log = [{ ts: now - 120_000, kind: 'task:done', taskId: 't-1' }];
  const ledger = { tasks: [{ status: 'todo' }, { status: 'doing' }, { status: 'done' }] };

  let opsAcc = 0;
  let beatAcc = 0;
  let shippedAcc = 0;
  let ledgerAcc = 0;
  let beat = 0;

  const frames = Math.round((seconds * 1000) / FRAME_MS);
  for (let f = 0; f < frames; f++) {
    now += FRAME_MS;
    const dt = FRAME_MS / 1000;

    // main's breaker beat, pushed into the same FloorWeather the sky reads.
    beatAcc += FRAME_MS;
    if (beatAcc >= BREAKER_BEAT_MS) {
      beatAcc = 0;
      beat++;
      for (const id of present) {
        // `churn` makes ONE agent flap between levels every beat — the case
        // where a repaint is genuinely owed, so the counter can be read against
        // something that is not zero.
        const level = churn && id === 'agent-0' && beat % 2 === 0 ? 'steering' : 'healthy';
        weather.record({ agentId: id, level, ts: now }, now);
      }
    }

    // The ticker's ~1 Hz re-read (OfficeFloor.updateOpsPanel).
    opsAcc += dt;
    if (opsAcc >= 1) { opsAcc = 0; paintOps(); }

    // hive/log.jsonl → the SHIPPED bars, every 60 s.
    shippedAcc += FRAME_MS;
    if (shippedAcc >= SHIPPED_POLL_MS) {
      shippedAcc = 0;
      const buckets = bucketShipped(log, now, SHIPPED_LOG_WINDOW);
      if (buckets) heldShipped = { value: buckets, at: now };
      paintOps();
    }

    // hive/tasks.json → the PLAN / BUILD / SHIP board, every 5 s.
    ledgerAcc += FRAME_MS;
    if (ledgerAcc >= 5000) {
      ledgerAcc = 0;
      heldPlan = {
        value: { plan: ledger.tasks.filter((t) => t.status === 'todo').length,
          build: ledger.tasks.filter((t) => t.status === 'doing').length,
          blocked: 0,
          ship: ledger.tasks.filter((t) => t.status === 'done').length },
        at: now,
      };
      paintPlan();
    }
  }

  return { frames, opsPaints, planPaints };
}

test('a quiet floor repaints the wall instruments on the order of once a minute, not once a frame', () => {
  const seconds = 600; // ten simulated minutes
  const measured = runFloor({ seconds });

  // The instrument's own output, so the number is in the test log rather than
  // only in an assertion message.
  console.log(
    `[wall-panel] ${seconds}s @${FPS}fps = ${measured.frames} frames → `
    + `${measured.opsPaints} ops paints, ${measured.planPaints} plan paints`
  );

  // The SHIPPED bars are anchored on `now`, so they legitimately shift once per
  // 60 s poll; that, plus the cold-start paint, is the entire budget.
  assert.ok(measured.opsPaints <= seconds / 60 + 2,
    `ops panel repainted ${measured.opsPaints} times in ${seconds}s — expected ~${seconds / 60}`);
  // A ledger that never changes must never repaint its board after the first.
  assert.equal(measured.planPaints, 2, 'plan board repainted on an unchanged ledger');

  // And the control: the same ten minutes with the signature check removed.
  const unguarded = runFloor({ seconds, guarded: false });
  console.log(
    `[wall-panel] control (no signature guard) → ${unguarded.opsPaints} ops paints, `
    + `${unguarded.planPaints} plan paints`
  );
  assert.ok(unguarded.opsPaints > measured.opsPaints * 20,
    'the control should repaint far more often, or the guard is not what is holding the number down');

  // Even the unguarded worst case is bounded by the POLL rate, never by the
  // frame rate — the throttles are upstream of the guard, so no reading of this
  // module can produce a per-frame texture upload.
  assert.ok(unguarded.opsPaints < measured.frames / 10,
    'even without the guard the panel must not be able to repaint per frame');
});

test('a genuinely changing floor still repaints — the guard is not just always-false', () => {
  const churned = runFloor({ seconds: 600, churn: true });
  const quiet = runFloor({ seconds: 600 });
  console.log(`[wall-panel] churning floor → ${churned.opsPaints} ops paints (quiet: ${quiet.opsPaints})`);
  assert.ok(churned.opsPaints > quiet.opsPaints,
    'an agent flapping on the breaker must move the wall');
});

test('the ops signature is stable across reads when nothing changed', () => {
  // The specific failure this whole file was written to look for: a signature
  // that folds in a timestamp, a Set iteration order or a freshness marker, and
  // so differs every time it is computed from identical data.
  const weather = new FloorWeather();
  const present = new Set(['b', 'a', 'c']);
  const now = 1_800_000_000_000;
  // Recorded in an order that is NOT the sorted order, so an unsorted
  // projection would show up here.
  weather.record({ agentId: 'b', level: 'steering', ts: now }, now);
  weather.record({ agentId: 'a', level: 'healthy', ts: now }, now);
  weather.record({ agentId: 'c', level: 'stopped', ts: now }, now);

  const sigAt = (t) => readoutSignature({
    agents: agentPips(weather.fresh(t, present), t, present),
    ci: null,
    shipped: null,
  });

  const first = sigAt(now);
  assert.equal(sigAt(now), first);
  assert.equal(sigAt(now + 1), first, 'the signature must not move with the clock alone');
  assert.equal(sigAt(now + 5000), first);
  assert.equal(first, 'healthy,steering,stopped|-|-');
});
