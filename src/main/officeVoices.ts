/**
 * officeVoices — WHICH voice each agent speaks with, and how often the floor is
 * allowed to make a sound at all.
 *
 * Pure by construction: no `electron`, no `fetch`, no filesystem, no clock it
 * does not accept as an argument. The network half lives in `minimaxTts.ts` and
 * the playback half in the renderer; this module is only the two decisions that
 * have to be deterministic and testable — who sounds like what, and whether the
 * next line is allowed to be spoken.
 *
 * ── THE ASSIGNMENT ──────────────────────────────────────────────────────────
 * An agent already HAS an identity on the floor: `agent.character`, the Office
 * cast member fronting it (`dwight`, `pam`, …) or a `custom:<uuid>` from the
 * custom-character registry. That is the only identity worth deriving a voice
 * from, because it is the one the user already reads off the sprite: if two
 * avatars look like Dwight, they had better not sound like different people.
 *
 * So resolution is, in order:
 *   1. an EXPLICIT per-agent override (`officeVoiceOverrides[agentId]`) — the
 *      escape hatch, and the only thing that can ever beat the cast;
 *   2. the CAST MAP below, a hand-written voice per fixed Office character;
 *   3. a deterministic hash over a small fallback pool, seeded by the character
 *      id when there is one (so every agent wearing the same custom character
 *      shares its voice, exactly like rule 2) and by the agent id otherwise.
 *
 * Every branch is a pure function of stable strings, so the same agent sounds
 * the same across restarts, across re-hires with the same id, and across
 * machines. Nothing is stored, nothing is assigned lazily on first speech, and
 * there is no registry to keep in sync.
 *
 * THE IDS ARE DATA, NOT CONTRACT. They are MiniMax system-voice ids. If a voice
 * is renamed or retired upstream, that agent's clips fail exactly the way every
 * other failure fails here — silently, with the text dialogue untouched — and
 * the user can pin a working id per agent from Settings without a new build.
 *
 * ── THE RATE LIMIT ──────────────────────────────────────────────────────────
 * `VoicePlayLedger` is a rolling ONE-MINUTE window over synthesis requests.
 * It exists because the sound budget is not the same budget as the text budget:
 * the chatter's lane limits cap how many EXCHANGES get written (≤8/hour), but an
 * exchange is up to six lines that land seconds apart, and six overlapping
 * voices is not ambience, it is noise. The ledger is checked in MAIN, before a
 * request is dispatched, so a buggy or malicious renderer cannot spend the
 * user's MiniMax quota by asking in a loop.
 */

/** The default MiniMax TTS model: fast and cheap, which is the right trade for
 *  a one-line background mutter. `speech-2.6-hd` is the quality option and is
 *  accepted verbatim from config. */
export const DEFAULT_MINIMAX_MODEL = 'speech-2.6-turbo';

/** MiniMax's global text-to-audio endpoint. Overridable in config for the
 *  mainland host (`api.minimax.chat`) or a proxy. */
export const DEFAULT_MINIMAX_ENDPOINT = 'https://api.minimax.io/v1/t2a_v2';

/** Clips are single café beats — `officeChat.ts` already caps a line at 70
 *  characters. This is the defensive ceiling on whatever actually arrives, so a
 *  malformed line cannot turn into a paid-for minute of speech. */
export const MAX_SPEAK_CHARS = 140;

/** How many clips the floor may synthesise in any rolling minute, by default.
 *  A six-line exchange fits inside it whole (the point: an exchange should never
 *  be cut off half-spoken), while a runaway caller is stopped within seconds. */
export const DEFAULT_VOICE_PLAYS_PER_MINUTE = 8;

const MINUTE_MS = 60_000;

/**
 * One voice per fixed Office character.
 *
 * Chosen for the character, not for the actor: Dwight gets the debater, Michael
 * the comedian who thinks he is funnier than he is, Stanley the weary baritone,
 * Angela the severe one. Keys are the `OfficeCharacterName` union in the
 * renderer's `scene/office/cast.ts` — duplicated as plain strings because main
 * cannot import renderer code, and validated by the test that walks the cast.
 */
export const CAST_VOICES: Readonly<Record<string, string>> = Object.freeze({
  michael:  'English_Comedian',
  jim:      'Casual_Guy',
  pam:      'Calm_Woman',
  dwight:   'English_Debator',
  kevin:    'Decent_Boy',
  angela:   'Abbess',
  oscar:    'Elegant_Man',
  stanley:  'Deep_Voice_Man',
  phyllis:  'Wise_Woman',
  andy:     'English_Jovialman',
  kelly:    'Exuberant_Girl',
  ryan:     'English_ReservedYoungMan',
  toby:     'Patient_Man',
  creed:    'English_CaptivatingStoryteller',
  meredith: 'Lively_Girl'
});

/**
 * Voices for everyone the cast map does not name: custom characters, and any
 * future cast member added to the renderer before this map catches up.
 *
 * Deliberately mixed and deliberately small. A big pool would make two adjacent
 * agents sound unrelated for no gain; nine voices is already far more than the
 * handful of avatars on screen at once, and keeping it small keeps the
 * distribution legible when someone reports "these two sound identical".
 */
export const FALLBACK_VOICES: readonly string[] = Object.freeze([
  'Casual_Guy',
  'Calm_Woman',
  'Deep_Voice_Man',
  'Lively_Girl',
  'Patient_Man',
  'Wise_Woman',
  'Elegant_Man',
  'Exuberant_Girl',
  'Friendly_Person'
]);

/** FNV-1a, 32-bit. Small, dependency-free, and — the only property that matters
 *  here — identical on every platform and every run for the same input. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // `Math.imul` keeps the multiply in 32-bit land; `>>> 0` keeps it unsigned.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface VoiceIdentity {
  /** The agent's hive id — stable for the life of the agent. */
  agentId: string;
  /** `agent.character`: a fixed cast key ('dwight') or `custom:<uuid>`. May be
   *  empty for an agent with no character on record. */
  character?: string | null;
}

/**
 * The MiniMax `voice_id` this agent speaks with. Total: every input resolves to
 * some voice, so there is no "unassigned" state to handle downstream.
 *
 * `overrides` is the user's per-agent pin, read straight off config. An entry
 * whose value is not a non-empty string is ignored rather than trusted — a
 * hand-edited config.json must not be able to send `null` upstream.
 */
export function voiceIdFor(
  who: VoiceIdentity,
  overrides?: Readonly<Record<string, string>> | null
): string {
  const agentId = (who?.agentId ?? '').trim();
  const character = (who?.character ?? '').trim();

  // 1. The user's explicit choice always wins — including over the cast map, and
  //    including for a fixed character. That is what makes it an override.
  const pinned = agentId ? overrides?.[agentId] : undefined;
  if (typeof pinned === 'string' && pinned.trim()) return pinned.trim();

  // 2. The cast. Lower-cased because the character key is a lower-case union in
  //    the renderer but travels here as a plain string.
  const cast = CAST_VOICES[character.toLowerCase()];
  if (cast) return cast;

  // 3. Deterministic fallback. Seeded by the CHARACTER when there is one, so two
  //    agents wearing the same custom character sound alike (rule 2's promise,
  //    extended to characters this file has never heard of); by the agent id
  //    otherwise, which is the only stable string left.
  const seed = character || agentId;
  if (!seed) return FALLBACK_VOICES[0];
  return FALLBACK_VOICES[hashString(seed) % FALLBACK_VOICES.length];
}

/**
 * The text as it may be sent for synthesis, or null when there is nothing worth
 * spending a request on.
 *
 * Café lines are already short, lower-case and clean by the time they reach the
 * floor. This is the boundary check, not a rewriter: it collapses whitespace,
 * caps the length, and refuses empties. It does NOT attempt to sanitise the
 * content — a TTS endpoint reads text, it does not execute it, and a filter that
 * silently mangled a line would make the audio disagree with the bubble the user
 * is reading, which is worse than saying it verbatim.
 */
export function speakableText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > MAX_SPEAK_CHARS ? clean.slice(0, MAX_SPEAK_CHARS) : clean;
}

/**
 * Rolling one-minute ceiling on synthesis requests.
 *
 * Same read-only-`allows` / explicit-`note` shape as `ChatterTokenLedger` in
 * chatterOpenAI.ts, and for the same reason: asking whether a clip is allowed
 * must never itself consume the allowance, because the caller may still decide
 * not to speak (the scene went away, another clip is already playing).
 *
 * A limit of 0 or less means UNLIMITED — the escape hatch for someone who wants
 * every line voiced and is paying for it knowingly.
 */
export class VoicePlayLedger {
  private plays: number[] = [];

  /** `getLimit` is read live, not captured, so a Settings change binds on the
   *  very next line instead of after a restart. */
  constructor(private getLimit: () => number) {}

  limit(): number {
    const raw = this.getLimit();
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }

  /** Clips synthesised inside the minute ending now. */
  count(now: number = Date.now()): number {
    this.prune(now);
    return this.plays.length;
  }

  /** May another clip be synthesised? Read-only — asking costs nothing. */
  allows(now: number = Date.now()): boolean {
    const limit = this.limit();
    if (limit <= 0) return true;
    return this.count(now) < limit;
  }

  /** Record a dispatched request. Called when the request actually goes out, so
   *  a refusal (flag off, no key, nothing to say) never eats the budget. */
  note(now: number = Date.now()): void {
    this.prune(now);
    this.plays.push(now);
  }

  /** Forget the window — used when the office is reset or the home changes. */
  reset(): void {
    this.plays = [];
  }

  private prune(now: number): void {
    if (this.plays.length && now - this.plays[0] >= MINUTE_MS) {
      this.plays = this.plays.filter((t) => now - t < MINUTE_MS);
    }
  }
}

// ─── The gate ────────────────────────────────────────────────────────────────
// Every reason the office may NOT make a sound, in one pure function, so the
// order of the checks is a thing a test can pin rather than a thing buried in an
// ipc handler. The handler's only remaining job is to call this and, if it says
// yes, hand the plan to `synthesizeSpeech`.

/** The slice of config this decision reads. Nothing else is consulted — in
 *  particular, nothing that could make the flag-off path touch a credential. */
export interface VoiceGateConfig {
  officeVoicesEnabled?: boolean;
  minimaxApiKey?: string;
  officeVoiceOverrides?: Record<string, string>;
}

/** Why nothing will be said. All of them are ordinary states, not faults: the
 *  caller's response to every one of them is the same silence. */
export type VoiceRefusal =
  | 'disabled'        // the flag is off — checked FIRST, before anything is read
  | 'no-agent'        // malformed request
  | 'nothing-to-say'  // empty / unusable text
  | 'no-key'          // voices on, key not pasted yet
  | 'rate-limited';   // the rolling minute is spent

export type VoicePlan =
  | { ok: true; text: string; voiceId: string }
  | { ok: false; reason: VoiceRefusal };

/**
 * May this line be spoken, and as whom?
 *
 * READ-ONLY: it never charges the ledger. The caller charges it at the moment it
 * actually dispatches, so a plan that is computed and then dropped (the scene
 * went away between the two) costs nothing.
 *
 * THE ORDER IS THE CONTRACT. `disabled` is checked before the config's key is so
 * much as read, which is what makes "flag off ⇒ the credential is not touched"
 * true by construction rather than by review.
 */
export function planSpeech(
  cfg: VoiceGateConfig | null | undefined,
  req: { agentId?: unknown; character?: unknown; text?: unknown } | null | undefined,
  ledger: { allows: (now?: number) => boolean },
  now: number = Date.now()
): VoicePlan {
  if (cfg?.officeVoicesEnabled !== true) return { ok: false, reason: 'disabled' };
  const agentId = typeof req?.agentId === 'string' ? req.agentId.trim() : '';
  if (!agentId) return { ok: false, reason: 'no-agent' };
  const text = speakableText(req?.text);
  if (!text) return { ok: false, reason: 'nothing-to-say' };
  // No key is a normal state (voices switched on before Settings was filled in),
  // and refusing here means no budget is spent discovering it.
  if (!(cfg.minimaxApiKey ?? '').trim()) return { ok: false, reason: 'no-key' };
  if (!ledger.allows(now)) return { ok: false, reason: 'rate-limited' };
  const character = typeof req?.character === 'string' ? req.character : '';
  return { ok: true, text, voiceId: voiceIdFor({ agentId, character }, cfg.officeVoiceOverrides) };
}
