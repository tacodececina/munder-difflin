/**
 * chatterOpenAI — the SECOND generation route for the office chatter.
 *
 * WHY IT EXISTS. Everything decorative that the office writes (break-room
 * dialogue in officeChat.ts, the in-character asides in officeVoice.ts) is
 * cooked by `brewSlot.ts`, and until now the slot knew exactly one way to reach
 * a model: `runHiddenClaude`, which spawns the user's own `claude` CLI. That is
 * the SAME subscription the agents doing real work draw on. A talkative office
 * therefore competes with the agents resolving actual incidents — the chatter
 * was never independent of the work, it just looked like it was.
 *
 * This module is the independent route: one POST to an OpenAI-compatible
 * `/chat/completions` endpoint with `Authorization: Bearer <key>`. That shape is
 * spoken by DeepSeek, MiniMax, Together, Groq, opencode-go, Ollama and LM Studio
 * alike, so pointing the chatter at a cheap or local model is a configuration
 * change (`chatterProvider` + `chatterBaseUrl` + `chatterApiKey`), never a code
 * change. Nothing here is reachable unless the user opts in: the default
 * provider stays 'claude-hidden' and this file is inert.
 *
 * THE THREE RULES THIS FILE OBEYS.
 *
 * 1. IT NEVER THROWS. Every failure — no key, a malformed base URL, DNS, a 500,
 *    a body that is not the JSON we expected, a timeout — comes back as
 *    `{ ok: false }`. `brewSlot` turns that into "no line", the caller plays its
 *    canned fallback, and a flaky endpoint can neither wedge the single brew
 *    slot nor take the app down with it.
 * 2. IT NEVER INVENTS. There is no placeholder text, no cached last answer, no
 *    "sorry, the model is down" line leaking onto the office floor. Empty means
 *    empty.
 * 3. THE KEY NEVER LEAVES THIS FUNCTION. It is read from main-process config,
 *    used once in the Authorization header, and `redact()` scrubs it out of any
 *    error string before that string can reach a log or the renderer. It is
 *    never logged, never returned, and never mirrored into the renderer (only
 *    its boolean PRESENCE is — see `chatter:status` in index.ts).
 *
 * TOKEN ACCOUNTING (`ChatterTokenLedger`). A budget you cannot measure is not a
 * budget, so every dispatched request is charged against a rolling-hour ceiling.
 * Endpoints that report `usage` are charged their real numbers; the many that do
 * not are charged an estimate — see `estimateTokens` for exactly how, and
 * `ChatterTokenLedger` for what happens when the hour is spent.
 */

import { readCappedText } from './httpBody';

/** Which engine writes the chatter. 'claude-hidden' is the historical route (a
 *  hidden `claude` CLI session, sharing the user's work subscription) and stays
 *  the default so no existing install changes behaviour. */
export type ChatterProvider = 'claude-hidden' | 'openai-compatible';

/** Chatter lines are one or two short sentences. Capping the completion bounds
 *  latency, bounds spend, and bounds how much text a hostile endpoint can push
 *  back at us in the happy path. */
export const CHATTER_MAX_OUTPUT_TOKENS = 220;

/** Refuse a response body larger than this. A chatter reply is a few hundred
 *  bytes; anything near a megabyte is either a misconfigured endpoint or an
 *  attempt to exhaust main-process memory.
 *
 *  Enforced on the bytes that ARRIVE (see `readCappedText`), not on the
 *  `content-length` the endpoint claims — that header is absent from every
 *  chunked response, and a ceiling a sender can skip by omitting a header is
 *  not a ceiling. The declared size is still checked first, because refusing
 *  before reading anything is cheaper than refusing part-way through. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** Rolling accounting window for the token budget. Deliberately the same shape
 *  (and the same hour) as the per-lane `maxPerHour` counter in brewSlot.ts. */
const HOUR_MS = 3_600_000;

/** Tokens/hour the chatter may spend when nothing is configured.
 *
 *  The lane limits already cap the chatter at 8 café brews + 6 aside brews per
 *  hour (officeChat.ts / officeVoice.ts). A café prompt is ~700 tokens in and at
 *  most CHATTER_MAX_OUTPUT_TOKENS out, so the worst hour the lanes ALLOW is
 *  roughly 14 × 900 ≈ 13k tokens. 60k is therefore ~4× headroom: it never binds
 *  in normal operation, and still stops a pathological loop (a retrying endpoint,
 *  a runaway prompt) from spending an unbounded amount overnight. */
export const DEFAULT_CHATTER_TOKEN_BUDGET_PER_HOUR = 60_000;

export interface ChatterHttpRequest {
  /** Endpoint root or full completions URL — see `chatCompletionsUrl`. */
  baseUrl: string;
  /** Bearer credential. Empty/absent ⇒ the request is not made at all. */
  apiKey: string;
  /** Model slug as the ENDPOINT spells it ('deepseek-chat', 'llama3.1', …). */
  model: string;
  prompt: string;
  /** Hard ceiling for the whole round trip. The slot passes its own brew
   *  timeout, so the HTTP route can never outlive the PTY route's budget. */
  timeoutMs: number;
  /** The slot's abort handle (app quit / home change). Aborting mid-flight
   *  resolves as a plain failure, never as a rejection. */
  signal?: AbortSignal;
}

export interface ChatterHttpResult {
  ok: boolean;
  /** The model's reply. Present only when `ok`. */
  text?: string;
  /** Human-readable cause, with the API key scrubbed out. Never logged by this
   *  module — it exists so the caller can decide, and today nobody prints it. */
  error?: string;
  /** What this call is CHARGED against the hourly budget. Non-zero whenever a
   *  request actually went out, including failures — see the note on
   *  `estimateTokens`. */
  tokens: number;
  /** False when `tokens` came from the endpoint's own `usage` block. */
  estimated: boolean;
}

/**
 * Rough token count for a string.
 *
 * HOW CONSUMPTION IS ESTIMATED WHEN THE RESPONSE CARRIES NO `usage`:
 * we charge `ceil(chars / 4)`. Four characters per token is the long-standing
 * rule of thumb for English/Latin-script BPE vocabularies and lands within a few
 * percent for the prose the chatter deals in; CJK and Arabic tokenize denser, so
 * for those the estimate UNDER-counts, which is the direction that matters least
 * here (the lane limits, not this ledger, are the primary rate control — the
 * ledger is the backstop).
 *
 * Which number is charged, per outcome:
 *   • endpoint reported `usage`          → its `total_tokens` verbatim
 *   • 2xx without `usage`                → estimate(prompt) + estimate(reply)
 *   • non-2xx, network error, or timeout → estimate(prompt) ALONE, because the
 *     request was dispatched and may well have been processed upstream even
 *     though we never saw a usable answer
 *   • never dispatched (no key, bad URL) → 0
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/**
 * Turn whatever the user typed into Settings into a completions URL.
 *
 * Accepts the three spellings people actually paste:
 *   https://api.deepseek.com                      → …/v1/chat/completions
 *   https://api.deepseek.com/v1                   → …/v1/chat/completions
 *   http://localhost:11434/v1/chat/completions    → used verbatim
 *
 * Returns null for anything that is not an http(s) URL. Refusing other schemes
 * is deliberate: `file:` and friends would turn a settings field into a local
 * read primitive.
 */
export function chatCompletionsUrl(baseUrl: string): string | null {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) return url.toString();
  // A bare host gets the conventional `/v1`; an explicit path (…/v1, …/openai/v1,
  // …/api) is taken as the user's word for where the API lives.
  url.pathname = `${path || '/v1'}/chat/completions`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Strip every occurrence of the credential from a message before it can be
 *  stored, surfaced or (in some future caller) logged. Belt and braces: nothing
 *  currently echoes the key, but an endpoint that quotes the Authorization
 *  header back in an error body would otherwise launder it into our strings. */
function redact(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join('[redacted]');
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Pull the provider's own error sentence out of a JSON error body. */
function extractError(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error.message === 'string') return j.error.message;
    if (typeof j.message === 'string') return j.message;
  } catch { /* not json — the status line is all we have */ }
  return '';
}

/**
 * One chatter completion over HTTP. Resolves — always. See the file header for
 * the three rules; the only contract a caller needs is that a falsy `ok` means
 * "there is no line", and `tokens` must be handed to the ledger either way.
 */
export async function chatterHttpComplete(req: ChatterHttpRequest): Promise<ChatterHttpResult> {
  const apiKey = (req.apiKey ?? '').trim();
  const prompt = req.prompt ?? '';
  const promptCost = estimateTokens(prompt);

  // Nothing dispatched ⇒ nothing charged. "No key configured" is a normal,
  // silent state (the user turned the chatter on before filling Settings in),
  // not an error worth a toast.
  if (!apiKey) return { ok: false, error: 'no chatter API key configured', tokens: 0, estimated: true };
  if (!prompt.trim()) return { ok: false, error: 'empty prompt', tokens: 0, estimated: true };
  const url = chatCompletionsUrl(req.baseUrl);
  if (!url) return { ok: false, error: 'chatter base URL is not a valid http(s) URL', tokens: 0, estimated: true };
  const model = (req.model ?? '').trim();
  if (!model) return { ok: false, error: 'no chatter model configured', tokens: 0, estimated: true };

  // Our own timeout AND the slot's abort handle, folded into one controller so
  // `stop()` (quit / home change) cuts the socket at once instead of waiting the
  // request out.
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();
  if (req.signal) {
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), Math.max(1, req.timeoutMs));

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        // Flavour text wants some spread; the parsers in officeChat/officeVoice
        // are defensive, so a stray shape costs a fallback, not a crash.
        temperature: 0.8,
        max_tokens: CHATTER_MAX_OUTPUT_TOKENS,
        stream: false
      }),
      signal: controller.signal
    });

    // Cheap refusal for an endpoint that is honest about its size…
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_RESPONSE_BYTES) {
      return { ok: false, error: 'chatter response too large', tokens: promptCost, estimated: true };
    }

    // …and the one that actually binds, for the chunked response that declares
    // nothing at all. Over the cap the socket is cut mid-body and we keep none
    // of it: a truncated body is not a smaller answer, it is a wrong one.
    const raw = await readCappedText(res, MAX_RESPONSE_BYTES);
    if (raw === null) {
      return { ok: false, error: 'chatter response too large', tokens: promptCost, estimated: true };
    }
    if (!res.ok) {
      const detail = extractError(raw) || res.statusText || '';
      return {
        ok: false,
        error: redact(`chatter endpoint ${res.status}${detail ? `: ${detail}` : ''}`, apiKey),
        tokens: promptCost,
        estimated: true
      };
    }

    let json: {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { total_tokens?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    try { json = JSON.parse(raw); } catch {
      return { ok: false, error: 'chatter response was not JSON', tokens: promptCost, estimated: true };
    }

    const content = json.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : '';
    const reported = usageTokens(json.usage);
    if (!text.trim()) {
      return {
        ok: false,
        error: 'empty chatter response',
        tokens: reported ?? promptCost,
        estimated: reported === null
      };
    }
    return {
      ok: true,
      text,
      tokens: reported ?? promptCost + estimateTokens(text),
      estimated: reported === null
    };
  } catch (e) {
    // AbortError covers BOTH our timeout and the slot's stop(); neither is worth
    // distinguishing downstream, because both mean "no line this time".
    const aborted = e instanceof Error && e.name === 'AbortError';
    return {
      ok: false,
      error: redact(aborted ? 'chatter request timed out or was cancelled' : errMsg(e), apiKey),
      tokens: promptCost,
      estimated: true
    };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Real token usage off an OpenAI-shaped `usage` block, or null when the
 *  endpoint reported none (most local servers, and several hosted ones). */
function usageTokens(usage?: {
  total_tokens?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown
}): number | null {
  if (!usage) return null;
  const total = usage.total_tokens;
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) return Math.round(total);
  const p = usage.prompt_tokens;
  const c = usage.completion_tokens;
  if (typeof p === 'number' && typeof c === 'number' && Number.isFinite(p) && Number.isFinite(c)) {
    return Math.max(0, Math.round(p + c));
  }
  return null;
}

/**
 * The chatter's rolling-hour token ceiling.
 *
 * WHAT IT GUARANTEES: once the tokens spent in the last hour reach the limit,
 * `allows()` is false and the brew slot refuses to cook anything at all — no
 * request is dispatched, on EITHER route — until enough of that spend ages past
 * the hour and the window reopens. Nothing queues up; a refused brew is simply a
 * brew that never happened, exactly like a lane's `maxPerHour` refusal.
 *
 * WHAT IT DOES NOT GUARANTEE: that the hour's total never exceeds the limit. The
 * check happens BEFORE a brew, and a brew's true cost is only known after, so the
 * ceiling can be overshot by at most one brew (bounded in turn by the prompt plus
 * CHATTER_MAX_OUTPUT_TOKENS). Pre-charging the estimate instead would make the
 * budget bind early and unpredictably on every prompt-size change, which is worse
 * for a decoration.
 *
 * A limit of 0 (or negative, or NaN) means UNLIMITED — the escape hatch for a
 * local model where tokens cost nothing.
 */
export class ChatterTokenLedger {
  /** (when, how many) for every charged brew inside the window. Pruned on read
   *  and on write, so it stays proportional to one hour of brews. */
  private spends: { at: number; tokens: number }[] = [];

  /** `getLimit` is read live (not captured) so a Settings change takes effect on
   *  the very next brew, without a restart. */
  constructor(private getLimit: () => number) {}

  /** The configured ceiling, or 0 for "unlimited". Defensive against a hand-
   *  edited config.json carrying a string or a negative. */
  limit(): number {
    const raw = this.getLimit();
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /** Tokens charged inside the rolling hour ending now. */
  spent(now: number = Date.now()): number {
    this.prune(now);
    return this.spends.reduce((n, s) => n + s.tokens, 0);
  }

  /** Tokens still available this window; Infinity when unlimited. */
  remaining(now: number = Date.now()): number {
    const limit = this.limit();
    if (limit <= 0) return Infinity;
    return Math.max(0, limit - this.spent(now));
  }

  /** May another brew start? Read-only — asking never consumes budget. */
  allows(now: number = Date.now()): boolean {
    return this.remaining(now) > 0;
  }

  /** Charge a completed (or attempted) brew. Zero and negative are ignored so a
   *  never-dispatched request cannot pollute the window with empty entries. */
  note(tokens: number, now: number = Date.now()): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.prune(now);
    this.spends.push({ at: now, tokens: Math.round(tokens) });
  }

  /** Forget everything charged so far. Used when the office is reset. */
  reset(): void {
    this.spends = [];
  }

  private prune(now: number): void {
    if (this.spends.length && now - this.spends[0].at >= HOUR_MS) {
      this.spends = this.spends.filter((s) => now - s.at < HOUR_MS);
    }
  }
}
