/**
 * voicePlayback — the renderer half of the office's voice: it decides whether a
 * café beat is worth hearing, and plays it.
 *
 * WHAT ALREADY EXISTED, AND WHY THIS DOES NOT REBUILD IT. The renderer has
 * exactly one audio output path: an `HTMLAudioElement` routed through
 * `applyOutputSink` (`setSinkId`), fed by the speaker the user chose in the
 * Realtime Michael device picker. That is the whole pipeline — Michael's voice
 * arrives as a WebRTC track attached to such an element, and Free Flow only ever
 * goes the other way (mic → Groq). So this module reuses `applyOutputSink` and
 * `currentOutputDeviceId` from `realtime/session.ts` rather than inventing a
 * second notion of "where sound comes out": one device picker governs both, and
 * a user who routed Michael to their headset gets the office there too.
 *
 * WHAT IT ADDS is everything a scene needs that a phone call does not:
 *
 *   ONE VOICE AT A TIME. Two agents at a table speak in alternating beats. If a
 *   clip is still playing when the next beat fires, the new line is DROPPED, not
 *   queued: a queue would drift further behind the bubbles with every line until
 *   the audio was describing a conversation that ended a minute ago.
 *
 *   LATE AUDIO IS DISCARDED, NEVER BANKED. Synthesis takes a second or two; a
 *   beat lasts about three. A clip that comes back after its bubble is gone has
 *   missed its moment, and playing it would put a voice on a line nobody can see.
 *   `STALE_AFTER_MS` is that judgement, and it is checked after the await.
 *
 *   NOBODY IS WATCHING ⇒ NOBODY IS TALKING. If the window is hidden (minimised,
 *   another workspace, a background tab) the request is never made. The office is
 *   ambience for a scene being looked at, not a podcast.
 *
 *   SILENCE IS THE FAILURE MODE. Every path here — flag off, no bridge, the main
 *   process refusing, a decode failure, an autoplay block, a device that vanished
 *   — ends in `return` with no sound and no exception. The dialogue keeps
 *   rendering exactly as it does today. Nothing in this file can break the floor.
 *
 * WITH THE FLAG OFF THERE IS NO STATE AT ALL: `enabled` starts false, `speak()`
 * returns on its first line, and no audio element, blob URL or timer is ever
 * created. The flag is mirrored from config the same way the floor mirrors
 * `officeChatterEnabled` — initial `getConfig()` plus every `config:changed`.
 */

import { applyOutputSink, currentOutputDeviceId } from '@/realtime/session';

/** A clip that resolves later than this has missed the bubble it belongs to.
 *  Sized against the floor's beat pacing (`beatSeconds`: reading time + jitter,
 *  a couple of seconds for a short line), so a clip is allowed to arrive a beat
 *  late but never two. */
const STALE_AFTER_MS = 3_500;

/** Hard cap on how long one clip may hold the "someone is speaking" latch. A
 *  café line is one or two seconds; if an element never fires `ended` (a codec
 *  the sink refused, a device yanked mid-playback) the latch must still clear,
 *  or the office goes permanently mute until the next reload. */
const MAX_CLIP_MS = 15_000;

/** Mirrored from `officeVoicesEnabled`. False until config says otherwise, so
 *  the very first beat after a cold start cannot make a request. */
let enabled = false;

/** The clip currently sounding, if any. Non-null is exactly the "one voice at a
 *  time" latch — a new beat that finds it set says nothing. */
let playing: HTMLAudioElement | null = null;
/** Object URL behind `playing`, revoked the moment the clip settles. */
let playingUrl: string | null = null;
/** Watchdog for `MAX_CLIP_MS`. */
let clipTimer: ReturnType<typeof setTimeout> | null = null;

/** Bumped by `stopOfficeVoices()`. Every in-flight request captures the value it
 *  started with and gives up if it changed — that is how a scene teardown or a
 *  toggle-off drops clips that are still in the air. */
let generation = 0;

/** True while a synthesis round trip is out. Stops a burst of beats from firing
 *  several requests before the first one answers (the main-side per-minute
 *  ledger would refuse them, but the right place not to ask is here). */
let requesting = false;

/** Turn office voices on or off. Called from the floor with the live config
 *  flag; switching OFF stops whatever is sounding immediately. */
export function setOfficeVoicesEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  if (!enabled) stopOfficeVoices();
}

/** Silence everything now and invalidate in-flight clips. Called on toggle-off
 *  and on scene teardown, so a clip can never outlive the floor that asked for
 *  it. Idempotent and safe when nothing is playing. */
export function stopOfficeVoices(): void {
  generation++;
  requesting = false;
  releaseClip();
}

/** Tear down the current element and its blob URL. The single place playback
 *  state is cleared, so there is one definition of "quiet". */
function releaseClip(): void {
  if (clipTimer) { clearTimeout(clipTimer); clipTimer = null; }
  const el = playing;
  playing = null;
  const url = playingUrl;
  playingUrl = null;
  if (el) {
    try { el.pause(); el.src = ''; } catch { /* already gone */ }
  }
  if (url) {
    try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
  }
}

/** Is the user actually looking at this window? `document.hidden` covers
 *  minimised, occluded-by-fullscreen and another-workspace on every platform
 *  Electron ships to. Deliberately NOT focus: a visible but unfocused window is
 *  still being watched, and muting it would be wrong. */
function watching(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export interface SpeakRequest {
  /** The hive agent id — what the per-agent voice pin is keyed on. */
  agentId: string;
  /** The RAW cast key (`dwight`, `custom:<uuid>`), not a display name: it is
   *  what the deterministic assignment in main keys on. */
  character?: string;
  /** The line, exactly as it is being shown in the thought bubble. */
  text: string;
}

/**
 * Say one café beat out loud, if every condition for it holds. Fire-and-forget:
 * the caller does not await it, does not branch on it, and is not told whether
 * anything was heard. Never throws.
 */
export function speakOfficeLine(req: SpeakRequest): void {
  // Flag first, before anything is read or allocated — off means this feature
  // does not exist.
  if (!enabled) return;
  if (!req?.agentId || !req?.text?.trim()) return;
  // Already someone talking, or already waiting on a clip: this line goes
  // unspoken rather than into a queue that would drift behind the bubbles.
  if (playing || requesting) return;
  if (!watching()) return;
  const bridge = window.cth?.officeVoicesSpeak;
  if (!bridge) return;   // stale preload bridge — silent, like every other miss

  const startedAt = Date.now();
  const gen = generation;
  requesting = true;
  void bridge({ agentId: req.agentId, character: req.character ?? '', text: req.text })
    .then((res) => {
      requesting = false;
      // AFTER THE AWAIT, re-check everything that could have changed while the
      // request was out. Each of these is a real, ordinary case — not a defensive
      // flourish — and all four end the same way: drop the clip.
      if (gen !== generation) return;                        // scene gone / toggled off
      if (!enabled) return;                                  // flag flipped mid-flight
      if (!watching()) return;                               // user looked away
      if (Date.now() - startedAt > STALE_AFTER_MS) return;   // its bubble has passed
      if (playing) return;                                   // another line won the slot
      if (!res?.ok || !res.audio || res.audio.byteLength === 0) return;  // main said no
      play(res.audio, res.mimeType || 'audio/mpeg', gen);
    })
    .catch(() => { requesting = false; /* no sound, no noise about it */ });
}

/** Attach one clip to a fresh element on the user's chosen speaker and start it.
 *  Best-effort throughout: an autoplay refusal, an unsupported codec or a
 *  vanished device all land in `releaseClip` and leave the floor unchanged. */
function play(audio: ArrayBuffer, mimeType: string, gen: number): void {
  let url: string;
  try {
    url = URL.createObjectURL(new Blob([audio], { type: mimeType }));
  } catch {
    return;
  }
  const el = new Audio();
  el.src = url;
  playing = el;
  playingUrl = url;
  // Clear the latch on every terminal outcome the element has, plus a watchdog
  // for the outcomes it does not report.
  const done = (): void => { if (playing === el) releaseClip(); };
  el.addEventListener('ended', done, { once: true });
  el.addEventListener('error', done, { once: true });
  clipTimer = setTimeout(done, MAX_CLIP_MS);
  // Route to the same speaker the Realtime voice loop uses, then start. The sink
  // is applied first so the first syllable is not emitted from the old device.
  void applyOutputSink(el, currentOutputDeviceId())
    .catch(() => { /* unsupported sink — the default device is fine */ })
    .then(() => {
      // The scene may have gone away during that microtask.
      if (gen !== generation || playing !== el) { done(); return; }
      return el.play();
    })
    .catch(done);   // autoplay policy, decode failure — silence, never a throw
}
