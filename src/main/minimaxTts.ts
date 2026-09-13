/**
 * minimaxTts — one POST to MiniMax's T2A v2 endpoint, run from the Electron MAIN
 * process, so the office can be HEARD and not only read.
 *
 * Shaped after `freeflow.ts` (the Groq speech-to-text call) and
 * `chatterOpenAI.ts` (the chatter's HTTP route), for the same two reasons those
 * live in main: the user's API key never enters a renderer, and a main-side
 * fetch dodges CORS entirely. Electron bundles Node 20, so global `fetch` +
 * `AbortController` are here with no new dependency.
 *
 * THE THREE RULES, inherited verbatim from chatterOpenAI.ts:
 *
 * 1. IT NEVER THROWS. No key, a bad URL, DNS, a 500, a MiniMax `base_resp`
 *    error, a body that is not JSON, a timeout, an abort — all of it comes back
 *    as `{ ok: false }`. The caller plays no sound and the text dialogue on the
 *    floor is completely unaffected. A voice feature that can break the scene is
 *    not worth having.
 * 2. IT NEVER INVENTS. There is no placeholder beep, no cached last clip, no
 *    "audio unavailable" line. Empty means silence.
 * 3. THE KEY NEVER LEAVES THIS FUNCTION. Read from main-process config, used
 *    once in the Authorization header, and `redact()` scrubs it out of every
 *    error string before that string can be stored or surfaced. It is never
 *    logged, never returned, and never mirrored to the renderer — the renderer
 *    learns only its boolean PRESENCE, via `officeVoices:status`.
 *
 * WHAT COMES BACK. T2A v2 in non-streaming mode answers with JSON, and the audio
 * sits in `data.audio` as a HEX string (not base64 — a real and easy mistake).
 * We decode it here and hand the renderer raw bytes plus a MIME type, which is
 * all an <audio> element needs.
 */

import { DEFAULT_MINIMAX_ENDPOINT, DEFAULT_MINIMAX_MODEL } from './officeVoices';
import { readCappedText } from './httpBody';

/** A café beat is a second or two of speech. Anything beyond this ceiling is a
 *  misconfigured endpoint or an attempt to push memory around, not a clip. */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/** Ceiling on the RESPONSE BODY, which is a different quantity from
 *  MAX_AUDIO_BYTES above: MAX_AUDIO_BYTES bounds what we are willing to DECODE,
 *  and it was only ever checked after the whole body had already been buffered.
 *  This bounds what we are willing to BUFFER — the part the endpoint chooses.
 *  Twice the audio ceiling because the payload arrives hex-encoded (two
 *  characters per byte), plus room for the JSON envelope around it. */
const MAX_RESPONSE_BYTES = 2 * MAX_AUDIO_BYTES + 64 * 1024;

/** The whole round trip, bounded. A clip that lands after its beat has passed is
 *  discarded by the renderer anyway, so waiting longer buys nothing. */
export const TTS_TIMEOUT_MS = 12_000;

/** Audio shape asked of MiniMax. mp3 because every Chromium <audio> plays it,
 *  32 kHz mono because this is one voice muttering across a pixel office, not
 *  music — it keeps the payload crossing IPC small. */
const AUDIO_SETTING = Object.freeze({
  sample_rate: 32_000,
  bitrate: 128_000,
  format: 'mp3',
  channel: 1
});

export const TTS_MIME_TYPE = 'audio/mpeg';

export interface TtsRequest {
  /** User's MiniMax key. Authorization header only; never logged. */
  apiKey: string;
  /** Endpoint URL. Defaults to the global t2a_v2 host. */
  endpoint?: string;
  /** MiniMax GroupId. Some deployments require it as a query parameter; when
   *  absent the URL is used exactly as given. */
  groupId?: string;
  /** `speech-2.6-turbo` (default) or `speech-2.6-hd`. */
  model?: string;
  /** The line to speak. Already length-capped by `speakableText`. */
  text: string;
  /** MiniMax system voice id — see officeVoices.ts for how it is chosen. */
  voiceId: string;
  /** Hard ceiling for the round trip. Defaults to TTS_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Abort handle (app quit / home change / the scene going away). Aborting
   *  resolves as a plain failure, never as a rejection. */
  signal?: AbortSignal;
}

export interface TtsResult {
  ok: boolean;
  /** Decoded audio bytes. Present only when `ok`. */
  audio?: Uint8Array;
  /** MIME type of `audio`, for the renderer's Blob. */
  mimeType?: string;
  /** Human-readable cause with the key scrubbed out. Nobody prints it today; it
   *  exists so a caller CAN decide, without the decision leaking a credential. */
  error?: string;
}

/** Strip every occurrence of the credential from a message before it can be
 *  stored, surfaced or logged. Belt and braces — nothing echoes the key today,
 *  but an endpoint that quoted the Authorization header back in an error body
 *  would otherwise launder it into our strings. */
function redact(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join('[redacted]');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Validate and compose the request URL.
 *
 * http(s) only, for the same reason chatterOpenAI refuses other schemes: a
 * settings field that accepted `file:` would be a local read primitive. A
 * GroupId, when configured, rides as a query parameter (which is how MiniMax's
 * own examples spell it) without disturbing one the user already pasted.
 */
export function ttsUrl(endpoint: string | undefined, groupId?: string): string | null {
  const raw = (endpoint ?? '').trim() || DEFAULT_MINIMAX_ENDPOINT;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const gid = (groupId ?? '').trim();
  if (gid && !url.searchParams.has('GroupId')) url.searchParams.set('GroupId', gid);
  return url.toString();
}

/**
 * Decode MiniMax's hex-encoded audio payload.
 *
 * Returns null for anything that is not a clean, even-length run of hex digits —
 * a partial or corrupt payload must become silence, not a Uint8Array full of
 * NaN-derived zeros that the renderer would happily try to play.
 */
export function decodeHexAudio(hex: unknown): Uint8Array | null {
  if (typeof hex !== 'string') return null;
  const clean = hex.trim();
  if (!clean || clean.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(clean)) return null;
  if (clean.length / 2 > MAX_AUDIO_BYTES) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Synthesise one line. Resolves — always. A falsy `ok` means "there is no
 * sound", and every caller's answer to that is to do nothing.
 */
export async function synthesizeSpeech(req: TtsRequest): Promise<TtsResult> {
  const apiKey = (req.apiKey ?? '').trim();
  const text = (req.text ?? '').trim();
  const voiceId = (req.voiceId ?? '').trim();

  // "No key configured" is a normal, silent state — the user turned voices on
  // before filling Settings in — not an error worth a toast.
  if (!apiKey) return { ok: false, error: 'no MiniMax API key configured' };
  if (!text) return { ok: false, error: 'nothing to say' };
  if (!voiceId) return { ok: false, error: 'no voice id resolved' };
  const url = ttsUrl(req.endpoint, req.groupId);
  if (!url) return { ok: false, error: 'MiniMax endpoint is not a valid http(s) URL' };

  // Our own timeout AND the caller's abort handle, folded into one controller so
  // a quit cuts the socket at once instead of waiting the request out.
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();
  if (req.signal) {
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), Math.max(1, req.timeoutMs ?? TTS_TIMEOUT_MS));

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: (req.model ?? '').trim() || DEFAULT_MINIMAX_MODEL,
        text,
        stream: false,
        voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
        audio_setting: AUDIO_SETTING
      }),
      signal: controller.signal
    });

    // Capped as it arrives — T2A answers with no content-length to check, so
    // `res.text()` here was an unbounded buffer into the main process.
    const raw = await readCappedText(res, MAX_RESPONSE_BYTES);
    if (raw === null) return { ok: false, error: 'MiniMax response too large' };
    if (!res.ok) {
      const detail = extractError(raw) || res.statusText || '';
      return { ok: false, error: redact(`MiniMax ${res.status}${detail ? `: ${detail}` : ''}`, apiKey) };
    }

    let json: {
      data?: { audio?: unknown };
      base_resp?: { status_code?: unknown; status_msg?: unknown };
    };
    try { json = JSON.parse(raw); } catch {
      return { ok: false, error: 'MiniMax response was not JSON' };
    }

    // MiniMax reports application-level failures inside a 200: an expired key, a
    // retired voice id and an exhausted balance all arrive this way. Treating the
    // HTTP status as the answer would have us decode an absent payload.
    const code = json.base_resp?.status_code;
    if (typeof code === 'number' && code !== 0) {
      const msg = typeof json.base_resp?.status_msg === 'string' ? json.base_resp.status_msg : '';
      return { ok: false, error: redact(`MiniMax error ${code}${msg ? `: ${msg}` : ''}`, apiKey) };
    }

    const audio = decodeHexAudio(json.data?.audio);
    if (!audio || audio.byteLength === 0) return { ok: false, error: 'MiniMax returned no audio' };
    return { ok: true, audio, mimeType: TTS_MIME_TYPE };
  } catch (e) {
    // AbortError covers BOTH our timeout and the caller's stop; neither is worth
    // distinguishing downstream, because both mean "no sound this time".
    const aborted = e instanceof Error && e.name === 'AbortError';
    return {
      ok: false,
      error: redact(aborted ? 'MiniMax request timed out or was cancelled' : errMsg(e), apiKey)
    };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Pull MiniMax's own sentence out of a JSON error body. */
function extractError(raw: string): string {
  try {
    const j = JSON.parse(raw) as {
      base_resp?: { status_msg?: unknown };
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof j.base_resp?.status_msg === 'string') return j.base_resp.status_msg;
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error.message === 'string') return j.error.message;
    if (typeof j.message === 'string') return j.message;
  } catch { /* not json — the status line is all we have */ }
  return '';
}
