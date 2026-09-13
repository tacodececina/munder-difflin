/**
 * OfficeVoiceDirector — persona flavour on the REAL work messages, not just the
 * café gossip.
 *
 * THE IDEA. `officeChat.ts` proved that an agent's "soul" — the character
 * fronting it on the floor, its hire role, its live status — can be handed to a
 * cheap model and come back as writing that sounds like that specific agent.
 * That only ever touched break-room small talk, which is decoration on top of
 * decoration. The messages agents actually send each other through the hive
 * (`hive:inbox`, rendered as threads in the sidebar) are the place where the
 * floor's cast is currently invisible: every handoff reads like every other
 * handoff, whoever wrote it.
 *
 * So this director writes ONE short in-character ASIDE per work message — the
 * thing that agent would mutter while sending it — and the UI renders it BESIDE
 * the message, in its own muted style.
 *
 * THE RULE THAT MAKES THIS SAFE: the message itself is never touched. Not the
 * subject, not the body, not the act, not on disk and not on screen. The stored
 * message is exactly the bytes the sending agent wrote, the recipient agent
 * reads exactly those bytes, and the thread view still renders them verbatim.
 * The aside is a separate string, keyed by message id, held only in memory in
 * this process, and it disappears entirely when the flag is off. If the aside
 * is wrong, missing, or nonsense, nothing about the work changes — which is the
 * only basis on which a model-written garnish belongs anywhere near real work.
 *
 * WHAT THE MODEL SEES: the sender's soul (name, character, role, status), the
 * speech act, and the SUBJECT line. Never the body. Subjects are short,
 * human-authored headers; bodies routinely carry code, paths and credentials,
 * and there is no version of "flavour text" worth feeding those to a background
 * session for.
 *
 * LATENCY: same brew-ahead shape as the café, adapted to a panel instead of a
 * scene. `request()` returns instantly with whatever asides are already written
 * and — budget permitting — starts ONE brew in the background. The threads panel
 * re-polls every few seconds, so a flavour that lands 20s later simply appears.
 * Nothing ever waits on the model.
 *
 * BUDGET: its own lane on the SHARED BrewSlot, so it can never run a hidden
 * session at the same time as the café director:
 *   • ≥ 90s between brews in this lane
 *   • ≤ 6 brews per rolling hour
 *   • ≥ 10 min between brews for the SAME agent (so one chatty agent cannot
 *     take the whole lane)
 *   • one attempt per message, ever — a message that fails to brew is marked
 *     and never retried, because there will always be a newer message worth the
 *     slot more
 * The first message from an agent we have never flavoured gets the milestone
 * model (it establishes that agent's voice and everything after copies it);
 * everything else is routine. A milestone brew that comes back empty hands the
 * claim back — nothing was established, so the agent's first real aside still
 * gets the good model instead of being quietly demoted for the session.
 *
 * Inert while `officeChatterEnabled` is off: `request()` returns an empty map
 * before it reads or writes anything.
 */
import { BrewSlot, type LaneLimits } from './brewSlot';
import { chatterLanguageDirective } from './chatterLanguage';
import type { ChatPersona, ChatTier } from './officeChat';

const VOICE_LANE = 'voice';
const VOICE_LIMITS: LaneLimits = {
  minGapMs: 90_000,
  maxPerHour: 6,
  keyCooldownMs: 10 * 60_000
};

/** An aside describes a specific message, and messages are durable, so these can
 *  live a good while — but not forever, or a long session accumulates flavour
 *  for threads nobody has looked at since breakfast. */
const ASIDE_TTL_MS = 2 * 60 * 60_000;
/** Hard ceiling on remembered asides; the oldest are dropped first. */
const MAX_ASIDES = 200;
/** Short on purpose. This is a garnish in a dense thread list — a sentence would
 *  compete with the message it is decorating. */
const MAX_ASIDE_CHARS = 60;
/** How many messages one request may carry. The panel shows a handful of
 *  threads; anything past this is noise and would only bloat the IPC payload. */
const MAX_ITEMS = 40;

/** One real hive message, plus the soul of whoever SENT it. The renderer builds
 *  this — it is the side that knows which Office character fronts an agent. */
export interface VoiceFlavorItem {
  /** The hive message id. The aside is cached against this, so the same message
   *  is never brewed twice. */
  id: string;
  /** Hive speech act ('request' | 'inform' | …) — colours the tone a lot. */
  act: string;
  /** The message's SUBJECT line. The body is deliberately not accepted. */
  subject: string;
  /** The sender's soul. Same shape the café director uses. */
  soul: ChatPersona;
}

export interface VoiceFlavorRequest {
  /** Most-interesting-first: the director only ever brews for the first item it
   *  can, so the caller decides what deserves the slot (newest, usually). */
  items: VoiceFlavorItem[];
}

export interface VoiceFlavorResponse {
  /** message id → aside. Sparse: only messages already written appear, and an
   *  empty object is the normal answer for the first few polls. */
  asides: Record<string, string>;
}

/** The reading handed back when the feature is off or the request is malformed.
 *  Frozen: it is a shared constant, not a scratch object. */
export const EMPTY_FLAVOR: VoiceFlavorResponse = Object.freeze({ asides: Object.freeze({}) as Record<string, string> });

interface Aside { text: string; at: number }

interface Deps {
  getHome: () => string | null;
  getCommand: () => string;
  /** Same tiering contract as the café director. */
  getModel: (tier: ChatTier) => string;
  isEnabled: () => boolean;
  /** Same language contract as the café director (officeChat.ts's `getLanguage`):
   *  the UI language off the harness config, so an aside is muttered in the
   *  language the rest of the app is speaking. Optional — absent or English
   *  leaves the prompt exactly as it was. */
  getLanguage?: () => string | null | undefined;
  /** The process-wide brew slot. Optional only so tests can stand one up alone. */
  slot?: BrewSlot;
}

export class OfficeVoiceDirector {
  /** message id → the aside written for it. */
  private asides = new Map<string, Aside>();
  /** Messages whose one brew attempt came back empty. Never tried again — a
   *  newer message is always a better use of the slot than a stubborn old one. */
  private spent = new Set<string>();
  /** Agents we have already established a voice for. The FIRST message from an
   *  agent is the one worth the expensive model; the rest inherit that tone. */
  private voiced = new Set<string>();
  private slot: BrewSlot;

  constructor(private deps: Deps) {
    this.slot = deps.slot
      ?? new BrewSlot({ getHome: deps.getHome, getCommand: deps.getCommand });
  }

  /** Kill any in-flight brew. Called on quit / home change / reset alongside the
   *  café director's stop(); harmless when the shared slot is idle. */
  stop(): void {
    this.slot.stop();
  }

  /** Instant. Returns the asides already written for these messages and, budget
   *  permitting, starts ONE brew for the first message that has none. Never
   *  blocks on the model, never throws. */
  request(req: VoiceFlavorRequest): VoiceFlavorResponse {
    // Flag check FIRST: with the toggle off this feature must not read a
    // subject, keep a message id, or spawn anything.
    if (!this.deps.isEnabled()) return EMPTY_FLAVOR;
    const items = sanitizeItems(req?.items);
    if (items.length === 0) return EMPTY_FLAVOR;
    this.sweep();
    const asides: Record<string, string> = {};
    for (const it of items) {
      const hit = this.asides.get(it.id);
      if (hit) asides[it.id] = hit.text;
    }
    this.maybeBrew(items);
    return { asides };
  }

  /** Drop expired asides, then trim to the cap oldest-first. Called on every
   *  request, which is the only thing that can grow the map. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, a] of this.asides) if (now - a.at > ASIDE_TTL_MS) this.asides.delete(id);
    this.pruneSpent();
    if (this.asides.size <= MAX_ASIDES) return;
    const oldestFirst = [...this.asides.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [id] of oldestFirst.slice(0, this.asides.size - MAX_ASIDES)) this.asides.delete(id);
  }

  /** Keep `spent` from outliving the cache — OLDEST FIRST, never wholesale.
   *  Clearing the whole set would break the one invariant this feature promises
   *  ("one attempt per message, ever"): an old message that failed to brew and
   *  is still on screen would become a candidate again and could spend the lane
   *  and the budget a second time. A Set iterates in insertion order, so
   *  dropping from the front retires exactly the write-offs whose messages are
   *  long gone. */
  private pruneSpent(): void {
    const excess = this.spent.size - MAX_ASIDES * 2;
    if (excess <= 0) return;
    let dropped = 0;
    for (const id of this.spent) {
      if (dropped++ >= excess) break;
      this.spent.delete(id);
    }
  }

  /** Milestone for an agent's FIRST flavoured message, routine after that. Same
   *  reasoning as the café's first-encounter rule: the establishing take is
   *  where the good model earns its price. CLAIMS the milestone at call time so
   *  a second brew cannot also read it as a first — and `maybeBrew` RELEASES the
   *  claim when that brew comes back empty, because an attempt that produced no
   *  aside established no voice, and consuming the milestone on it would demote
   *  every future message from that agent to routine forever. */
  private tierFor(soulId: string): ChatTier {
    if (this.voiced.has(soulId)) return 'routine';
    this.voiced.add(soulId);
    return 'milestone';
  }

  private maybeBrew(items: VoiceFlavorItem[]): void {
    const target = items.find((it) => !this.asides.has(it.id) && !this.spent.has(it.id));
    if (!target) return;
    // Keyed on the SENDER, not the message: the cooldown exists so one busy
    // agent cannot spend the whole lane flavouring its own outbox.
    const key = target.soul.id;
    if (!this.slot.allows(VOICE_LANE, VOICE_LIMITS, key)) return;
    // Whether THIS brew is the one that took the agent's milestone, so only it
    // can hand it back. (The shared slot runs one brew at a time, so no other
    // attempt can be holding the same claim.)
    const claimedVoice = !this.voiced.has(key);
    const model = this.deps.getModel(this.tierFor(key));
    const prompt = buildAsidePrompt(target, this.deps.getLanguage?.());
    const writeOff = (): void => {
      this.spent.add(target.id);
      if (claimedVoice) this.voiced.delete(key);
    };
    void this.slot
      .run({ lane: VOICE_LANE, limits: VOICE_LIMITS, key, prompt, model, parse: parseAside })
      .then((text) => {
        if (text) this.asides.set(target.id, { text, at: Date.now() });
        else writeOff();
      })
      .catch(writeOff);
  }
}

/** Defensive normalisation of whatever crossed the IPC boundary. Anything that
 *  is not a well-formed item is dropped rather than repaired — a malformed
 *  entry means the renderer is out of date, and a garnish is not worth guessing
 *  about. */
function sanitizeItems(items: unknown): VoiceFlavorItem[] {
  if (!Array.isArray(items)) return [];
  const out: VoiceFlavorItem[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (out.length >= MAX_ITEMS) break;
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as Partial<VoiceFlavorItem>;
    const soul = it.soul as Partial<ChatPersona> | undefined;
    if (typeof it.id !== 'string' || !it.id) continue;
    if (seen.has(it.id)) continue;
    if (!soul || typeof soul.id !== 'string' || !soul.id) continue;
    seen.add(it.id);
    out.push({
      id: it.id,
      act: typeof it.act === 'string' ? it.act : 'inform',
      // Subjects are short headers, but a pathological one must not become a
      // pathological prompt.
      subject: typeof it.subject === 'string' ? it.subject.slice(0, 200) : '',
      soul: {
        id: soul.id,
        name: typeof soul.name === 'string' ? soul.name : soul.id,
        character: typeof soul.character === 'string' ? soul.character : '',
        role: typeof soul.role === 'string' ? soul.role : '',
        status: typeof soul.status === 'string' ? soul.status : 'idle'
      }
    });
  }
  return out;
}

/** How each speech act feels from the SENDER's side — the aside is theirs, so
 *  the framing has to be theirs too. */
const ACT_PROSE: Record<string, string> = {
  request: 'they are asking a colleague to do something',
  query: 'they are asking a colleague a question',
  propose: 'they are floating an idea past a colleague',
  inform: 'they are telling a colleague something',
  agree: 'they are agreeing to something',
  refuse: 'they are turning something down',
  done: 'they are reporting a finished piece of work'
};

function soulProse(p: ChatPersona): string {
  const bits = [`"${p.name}"`];
  if (p.character) bits.push(`presents as ${p.character} from The Office`);
  bits.push(`real job: ${p.role || 'software agent'}`);
  bits.push(`right now: ${statusProse(p.status)}`);
  return bits.join('; ');
}

function statusProse(status: string): string {
  switch (status) {
    case 'working': case 'thinking': return 'mid-task';
    case 'blocked': return 'blocked, waiting on the human';
    case 'looping': return 'just got throttled by the circuit breaker';
    case 'waiting': return 'waiting on another agent';
    case 'success': return 'just finished a task';
    case 'compacting': return 'tidying up its own context';
    default: return 'between tasks';
  }
}

/** `locale` is the UI language the user picked (harness config `language`).
 *  Omitted / English / unrecognised ⇒ the prompt is exactly what it was before
 *  the language directive existed. See chatterLanguage.ts. */
export function buildAsidePrompt(item: VoiceFlavorItem, locale?: string | null): string {
  const lang = chatterLanguageDirective(locale);
  return [
    'A pixel-art office sim shows AI coding agents as characters from The Office (US).',
    'One of them just sent a real work message to a colleague. The message itself is',
    'already written and will be displayed UNCHANGED — you are not rewriting it.',
    '',
    `THE SENDER: ${soulProse(item.soul)}.`,
    `WHAT THEY ARE DOING: ${ACT_PROSE[item.act] ?? 'they are messaging a colleague'}.`,
    `THE MESSAGE'S SUBJECT LINE: ${JSON.stringify(item.subject)}`,
    '',
    'Write the ASIDE this character would mutter while hitting send — the tone that',
    'never makes it into a work message. Rules:',
    `- ONE line, ≤ ${MAX_ASIDE_CHARS} characters, lowercase-casual, dry, in character.`,
    '- It is FLAVOUR shown next to the message, never a replacement for it. Do not',
    '  summarise the message, restate the subject, or add any new fact, name, number,',
    '  file path or instruction. If you have nothing in character to add, write a plain',
    '  in-character shrug.',
    '- No fourth-wall breaks about being an AI model. No quotes around the line.',
    // Last content rule, right before the output-shape line — same placement and
    // same reason as the café prompt's.
    lang,
    '- Output ONLY a JSON array containing that single string. No prose, no code fence.'
  ].filter(Boolean).join('\n');
}

/** Pull one clean aside out of the model's reply. Defensive on purpose: any
 *  shape problem returns null and the message simply shows without flavour.
 *  Accepts the requested `["…"]`, and falls back to a bare line, because a
 *  cheap model drops the brackets often enough to be worth handling. */
export function parseAside(text: string): string | null {
  const arr = extractArray(text);
  // When the reply DID parse as an array, its contents are the whole answer: an
  // empty one means the model had nothing, and falling back to the raw text here
  // is how a literal "[]" once ended up rendered as an agent's aside.
  const raw: string | null = arr
    ? arr.find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? null
    : text;
  if (raw === null) return null;
  const line = raw
    .replace(/\r/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const clean = line
    // Strip a code fence, list bullet or surrounding quotes the model may add.
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/^[-*>\s]+/, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  if (!clean) return null;
  return clean.length > MAX_ASIDE_CHARS
    ? clean.slice(0, MAX_ASIDE_CHARS - 1).trimEnd() + '…'
    : clean;
}

/** The JSON array inside `text`, or null when the reply is not array-shaped at
 *  all. An EMPTY array is a real answer ("nothing to say") and comes back as an
 *  empty array, not as null — the caller must not then fall back to raw text. */
function extractArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  return Array.isArray(parsed) ? parsed : null;
}
