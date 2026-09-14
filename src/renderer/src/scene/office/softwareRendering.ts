/**
 * IS THIS FLOOR BEING DRAWN BY A GPU, OR BY THE CPU PRETENDING TO BE ONE?
 *
 * THE BUG THIS EXISTS FOR. In production the Chromium GPU process was measured
 * burning 5.72 seconds of CPU per second of wall clock — near six cores — while
 * the renderer process (61 s) and main (27 s) stayed completely normal and the
 * window kept responding. Nothing in the scene explains that: the floor's whole
 * rendering shape costs about 0.12 s CPU/s in the gpu-process on a real GPU, and
 * the most expensive thing the wall instruments can possibly do — re-upload
 * their texture EVERY frame instead of once a second — adds 0.008 s/s to it.
 * Measured, both of them; see tools/perf/office-gpu-probe.cjs.
 *
 * What DOES explain it, exactly, is Chromium falling back to SwiftShader. Then
 * the entire GL stack runs on a thread pool inside the gpu-process, sized to the
 * machine's cores, and the same unchanged scene costs 13.2 s CPU/s on a 24-thread
 * box — renderer untouched, window still responsive, every symptom reproduced.
 * Scale that pool down to a laptop and it lands on the number that was reported.
 *
 * Chromium takes that decision for itself, at gpu-process startup, and does not
 * revisit it: a GPU process that has crashed enough times, a session with no
 * usable D3D device (a machine driven over RDP when the app started), a driver
 * on the blocklist. Reconnecting to the physical console afterwards does not
 * bring the GPU back — which is why "I closed the RDP session and it was still
 * 5.72" is consistent with this, not evidence against it.
 *
 * THE POINT OF THIS MODULE. The app had no idea any of that had happened. It
 * asked for a 2x backing store and an uncapped ticker and drew a full-window
 * animated scene at whatever rate it could, forever, into a software
 * rasteriser — a cartoon office costing six cores, with nothing anywhere saying
 * why. So: ask the context what it is, once, before the scene is built; when the
 * answer is "software", draw a cheaper floor and SAY SO in the log.
 *
 * It does not pretend to fix software rendering — nothing in this repo can. It
 * bounds the damage (13.5 → 3.6 s CPU/s, measured, same probe) and makes the
 * cause visible in one line instead of a two-hour hunt through a diff.
 *
 * The classifier is a pure string test so it can be unit-tested against the
 * renderer strings the real backends actually report, with no GPU in the room —
 * the same discipline weather.ts, wingFraming.ts and glRecovery.ts are held to.
 */

/**
 * Markers that appear in `UNMASKED_RENDERER_WEBGL` when there is no GPU behind
 * the context. Verified against live strings from the probe:
 *
 *   hardware  `ANGLE (AMD, AMD Radeon(TM) 890M Graphics (0x0000150E)
 *              Direct3D11 vs_5_0 ps_5_0, D3D11)`
 *   software  `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)
 *              (0x0000C0DE)), SwiftShader driver)`
 *
 * The rest are the other software backends a Chromium can land on: Chromium's
 * older SwANGLE spelling, Mesa's CPU rasterisers on Linux, and Windows' own
 * Basic Render Driver, which is what a session with no usable adapter hands
 * out. Deliberately a fixed list of KNOWN software backends rather than a
 * guess: misreading a real GPU as software would quietly halve the resolution of
 * a floor that was perfectly fine.
 *
 * Every entry here is long and specific enough that a hardware renderer string
 * cannot contain it by accident. WARP is the one that is not, so it is matched
 * separately — see WARP_MARKER.
 */
const SOFTWARE_MARKERS = [
  'swiftshader',
  'swangle',
  'llvmpipe',
  'softpipe',
  'lavapipe',
  'software rasterizer',
  'microsoft basic render',
] as const;

/**
 * Windows' WARP rasteriser, matched as a WORD rather than as a substring.
 *
 * `warp` is four letters and means something in plenty of unrelated contexts, so
 * a bare `includes('warp')` would classify any hardware renderer whose string
 * merely spelled those letters inside a longer word as software — halving its
 * resolution and capping its ticker for no reason. That is precisely the
 * mistake the list above is careful not to make, and the fix costs nothing: the
 * spellings Chromium actually reports always stand WARP alone,
 *
 *   `ANGLE (Unknown, WARP Direct3D11 vs_5_0 ps_5_0, D3D11)`
 *   `Microsoft Direct3D12 (WARP)`
 *
 * so requiring non-letters on both sides keeps every real one and drops the
 * accidents. (Digits and punctuation are deliberately allowed as neighbours:
 * renderer strings are full of `(WARP)`, `WARP,`, `D3D12 WARP`.)
 */
const WARP_MARKER = /(^|[^a-z])warp([^a-z]|$)/;

/**
 * True when `renderer` names a CPU rasteriser.
 *
 * An empty or unreadable string is NOT software. `WEBGL_debug_renderer_info` is
 * an optional extension and can be withheld; answering "software" because we
 * could not ask would degrade a healthy floor on the strength of no evidence,
 * and the failure mode this guards against is loud and measurable, so it can
 * afford to need proof.
 */
export function isSoftwareRenderer(renderer: string | null | undefined): boolean {
  if (typeof renderer !== 'string' || renderer.length === 0) return false;
  const name = renderer.toLowerCase();
  return SOFTWARE_MARKERS.some((marker) => name.includes(marker)) || WARP_MARKER.test(name);
}

/**
 * What the floor hands `app.ticker.maxFPS` while it is being drawn in software.
 *
 * A NOMINAL number, not the delivered frame rate. Pixi's throttle is a gate with
 * a refund in it (Ticker.update): it skips the frame while
 * `(now - _lastFrame) | 0` is under `1000 / maxFPS`, then re-bases `_lastFrame`
 * to `now - delta % (1000 / maxFPS)` — so every overshoot is handed back. On a
 * steady cadence that is exact (the same gate driven by a bare rAF loop in this
 * window: 63 passes in 8.00 s, 7.9 fps for a nominal 8). Software rendering is
 * not steady, and a 240 ms delta against a 125 ms gate re-bases `_lastFrame`
 * 115 ms into the PAST, letting the next frame through almost immediately. The
 * delivered rate therefore runs above the nominal one — about 1.38x here.
 *
 * Measured, and the reason this file exists (probe, SwiftShader, `camera`,
 * res 1, 8 s samples — `--fps=N` re-runs any row):
 *
 *   ticker.maxFPS   delivered         gpu-process     CPU per frame
 *   0 (uncapped)    33.7 fps (270)    12.29 s CPU/s   0.365 s
 *   8               11.0 fps  (88)     3.60 s CPU/s   0.327 s
 *   5                6.9 fps  (55)     2.21 s CPU/s   0.321 s
 *
 * Cost is linear in the frames ACTUALLY rendered — the DELIVERED column is what
 * buys the saving, and this constant only steers it. Eight is kept because that
 * is the setting
 * the shipped 3.6 s CPU/s was measured at, and because the ~11 fps it really
 * delivers still reads as walking rather than as a slideshow; it is the same
 * order as the alarm clock's deliberate ~12 fps redraw cap, which is this
 * scene's existing precedent for "animate, but not every frame". Lowering it to
 * 5 buys another 1.4 s CPU/s if a machine ever needs it, at 7 fps.
 */
export const SOFTWARE_FRAME_CAP = 8;

/**
 * Backing-store scale while software-rendering.
 *
 * The floor normally asks for `max(devicePixelRatio, 2)` so the half-scale
 * bubble text stays legible — four times the pixels of a 1:1 canvas, which a
 * GPU does not notice and a CPU rasteriser very much does. Crisp text is not
 * worth four cores, so software gets 1:1.
 */
export const SOFTWARE_RESOLUTION = 1;

/**
 * Ask a throwaway context what backend this process got, BEFORE the scene's own
 * context exists — the answer decides `resolution`, which `Application.init()`
 * takes and does not like being changed afterwards.
 *
 * The context is released immediately via `WEBGL_lose_context`. That matters
 * here specifically: Chromium caps a renderer at ~16 live WebGL contexts and
 * this app is already at the edge of it (every agent terminal takes one — see
 * glRecovery.ts), so a probe that leaked a context would cause the very eviction
 * that module exists to survive.
 *
 * Returns `null` when there is nothing to ask — no document, no WebGL, no
 * debug-renderer extension — and every caller reads `null` as "assume a GPU".
 */
export function probeRendererName(): string | null {
  try {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info
      ? gl.getParameter((info as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/** What the floor should do about the backend it was given. */
export interface RenderBudget {
  /** `Application.init`'s `resolution`. */
  resolution: number;
  /** `app.ticker.maxFPS`; 0 means "no cap", Pixi's own default. */
  maxFPS: number;
  /** True when the answer above is a DEGRADED one, so the caller can say so. */
  software: boolean;
  /** The renderer string the decision was made on, for the log line. */
  renderer: string | null;
}

/**
 * The floor's rendering budget for this process.
 *
 * `devicePixelRatio` is injected rather than read so the rule is testable; the
 * hardware branch is byte-for-byte the expression OfficeFloor used before this
 * module existed, so a healthy machine renders exactly what it always did.
 */
export function renderBudget(renderer: string | null, devicePixelRatio: number): RenderBudget {
  const software = isSoftwareRenderer(renderer);
  return {
    resolution: software ? SOFTWARE_RESOLUTION : Math.max(devicePixelRatio || 1, 2),
    maxFPS: software ? SOFTWARE_FRAME_CAP : 0,
    software,
    renderer,
  };
}
