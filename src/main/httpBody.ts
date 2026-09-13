/**
 * httpBody — reading a response body with a ceiling that actually binds.
 *
 * WHY IT EXISTS. Two main-process adapters POST to an endpoint the USER
 * configured — `chatterOpenAI.ts` (any OpenAI-compatible host) and
 * `minimaxTts.ts` (MiniMax's T2A) — and both used to hand the answer straight to
 * `res.text()`, which buffers whatever arrives, for as long as it keeps
 * arriving. chatterOpenAI did check `content-length` first, but that header is a
 * COURTESY: it is absent from every chunked response, so the ceiling could be
 * skipped by simply not declaring a size. A hostile or merely broken endpoint
 * could then push hundreds of megabytes into the Electron main process — the one
 * process in the app that must never die, since it owns every PTY.
 *
 * So the cap moved onto the bytes that actually ARRIVE. `readCappedText` pulls
 * the body through its stream and stops the moment the running total exceeds the
 * limit, cancelling the body (which closes the socket) instead of finishing the
 * download and complaining afterwards.
 *
 * IT NEVER INVENTS AND NEVER PARTIALLY SUCCEEDS. Over the limit is `null`, not a
 * truncated string: half a JSON document parsed "successfully" is a worse
 * failure than no document. Callers treat `null` exactly like any other
 * unusable answer — no line, no sound, no throw.
 */

/** The slice of a WHATWG `Response` this module actually touches. Declared
 *  structurally on purpose: the main process compiles with `types: ["node"]` and
 *  no DOM lib, and a structural type also lets tests hand in a stub. */
export interface CappedBodyResponse {
  text(): Promise<string>;
  body?: {
    getReader?: () => {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
      releaseLock(): void;
    };
  } | null;
}

/**
 * Read a response body as text, refusing to buffer more than `maxBytes` of it.
 *
 * Returns the decoded text, or `null` when the endpoint sent more than the cap
 * allows. `maxBytes` counts BYTES on the wire, not characters — which is the
 * quantity that costs memory, and the only one the sender controls directly.
 */
export async function readCappedText(
  res: CappedBodyResponse,
  maxBytes: number
): Promise<string | null> {
  const body = res.body;
  // No readable stream at all (a stubbed fetch, an exotic polyfill): fall back
  // to the unstreamed read and cap what came back. Weaker — those bytes are
  // already in memory — but never weaker than the behaviour this replaced.
  if (!body || typeof body.getReader !== 'function') {
    const whole = await res.text();
    return whole.length > maxBytes ? null : whole;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  let out = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!value || value.byteLength === 0) continue;
      seen += value.byteLength;
      if (seen > maxBytes) {
        // Hang up rather than drain politely: the point is to stop paying for
        // bytes we have already decided not to use.
        await reader.cancel('response exceeded the byte ceiling').catch(() => undefined);
        return null;
      }
      // `stream: true` so a multi-byte character split across two chunks is
      // decoded once, not twice into replacement characters.
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } finally {
    // A cancelled reader is already unlocked; releasing it twice throws and
    // would turn a size refusal into a rejection.
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
