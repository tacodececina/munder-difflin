/**
 * SUMMARIES WITHOUT A MODEL — the break room's transcript, read back as shapes.
 *
 * The tab this feeds shows "recent conversations, with a summary". The obvious
 * way to summarize a conversation is to ask a model, and that is exactly what
 * this module refuses to do. The decision is explicit and it is the user's: the
 * conversation tab costs ZERO tokens. Every "summary" here is arithmetic over
 * rows that already exist on disk (`office-chatter.jsonl`, see
 * src/main/officeChatLog.ts) — grouping, counting, and comparing timestamps.
 *
 * WHAT A RULE-BASED SUMMARY CAN HONESTLY BE. It cannot be "they discussed the
 * deploy" — that is a claim about MEANING and only a reader of the words can
 * make it. It can be a claim about SHAPE, and shape is most of what you actually
 * want from a list of past chats: how long it ran, who did the talking, whether
 * it was a nod in the corridor or an argument neither would drop, whether it
 * picked up a thread from twenty minutes earlier. So this module returns
 * STRUCTURED FACTS, not sentences — the panel renders them through i18n, which
 * is also the only way a summary can exist in four languages without a
 * translator in the loop.
 *
 * The one piece of actual content it surfaces is a `highlight`: the pair's own
 * longest line, QUOTED. A quote is not a summary and is not presented as one;
 * it is the cheapest honest way to show what a conversation sounded like.
 *
 * Kept free of React and of the store — pure data in, pure data out — for the
 * same reason legend.ts and dundiesStats.ts are: the rules are the product here,
 * so they have to be testable as arithmetic.
 */

/** One recorded spoken line — structurally `OfficeChatterLine` from the preload
 *  bridge, restated so this module depends on no ambient type. */
export interface ChatterLine {
  ts: number;
  conv: string;
  from: string;
  to: string;
  by: string;
  text: string;
  gen?: boolean;
}

/** How recently the same pair must have spoken for the next conversation to
 *  read as a CONTINUATION rather than a fresh subject. Deliberately the same
 *  40 minutes as `RESUME_WINDOW_MS` in src/main/officeChat.ts, which is the
 *  window the dialogue model itself is told to resume inside — a summary that
 *  called a chat "new" while the prompt that produced it said "you were talking
 *  about this minutes ago" would be describing a different conversation. */
export const RESUME_WINDOW_MS = 40 * 60_000;

/** The shape a conversation took. Not a topic — see the header. */
export type ConversationShape =
  /** Two lines or fewer: a passing acknowledgement. */
  | 'nod'
  /** Mostly questions — one of them was digging. */
  | 'interrogation'
  /** One of them did almost all the talking. */
  | 'oneSided'
  /** Five or more lines, traded evenly. */
  | 'backAndForth'
  /** Everything else: an ordinary short exchange. */
  | 'exchange';

export interface ConversationSummary {
  shape: ConversationShape;
  lineCount: number;
  /** Agent id that spoke the most — only set when someone clearly did (a tie,
   *  or anything close to one, has no dominant speaker and says so). */
  dominant?: string;
  /** Lines that ended in a question mark. */
  questions: number;
  /** The longest line of the conversation, quoted verbatim, and who said it.
   *  The only content this module passes through. */
  highlight: string;
  highlightBy: string;
  /** True when this pair had already spoken within RESUME_WINDOW_MS — i.e. the
   *  model was told to pick the thread back up. */
  resumed: boolean;
  /** Gap since the pair's previous conversation, ms. Absent for their first. */
  sincePrevMs?: number;
}

export interface ChatterConversation {
  /** Exchange id from the log — the React key, and stable across polls. */
  conv: string;
  /** When the exchange was handed to the floor. */
  at: number;
  /** The pair in the order it was played: `from` opened. */
  from: string;
  to: string;
  /** Every line, in spoken order. */
  lines: { by: string; text: string }[];
  summary: ConversationSummary;
}

/** Unordered pair key — two agents have ONE conversational history whichever of
 *  them opened a given sitting. (The relationship between them is directional
 *  and is emphatically not collapsed like this; see relView.ts. Here the
 *  question is only "when did these two last speak", which has one answer.) */
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const isQuestion = (text: string): boolean => text.endsWith('?') || text.endsWith('؟');

/**
 * Group raw log rows back into the conversations they were spoken in, newest
 * first, each with its derived summary.
 *
 * Defensive throughout: the log is append-only JSONL that a crash can truncate
 * and a user can hand-edit, so a row missing a field is skipped rather than
 * repaired. A row with no `conv` (possible in principle from a pre-grouping
 * writer) gets a synthetic group key from its pair and timestamp instead of
 * being silently merged with every other unlabelled row.
 *
 * @param rows  payload from `window.cth.officeChatHistory()`, oldest line first
 * @param limit how many conversations to return (newest kept)
 */
export function buildConversations(rows: unknown, limit = 40): ChatterConversation[] {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map<string, { at: number; from: string; to: string; lines: { by: string; text: string }[] }>();
  const order: string[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const r = raw as Partial<ChatterLine>;
    const ts = Number(r.ts);
    if (!Number.isFinite(ts)) continue;
    if (typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.by !== 'string') continue;
    if (typeof r.text !== 'string' || !r.text.trim()) continue;
    if (!r.from || !r.to || !r.by) continue;
    const key = typeof r.conv === 'string' && r.conv ? r.conv : `${pairKey(r.from, r.to)}@${ts}`;
    let group = groups.get(key);
    if (!group) {
      group = { at: ts, from: r.from, to: r.to, lines: [] };
      groups.set(key, group);
      order.push(key);
    }
    // The group's timestamp is its FIRST line's — an exchange is stamped when it
    // was handed to the floor, not when its last beat happened to land.
    if (ts < group.at) group.at = ts;
    group.lines.push({ by: r.by, text: r.text });
  }

  // Oldest first while summarizing, because `resumed` is a statement about what
  // came BEFORE and cannot be computed backwards.
  const chronological = order
    .map((key) => ({ conv: key, ...groups.get(key)! }))
    .filter((g) => g.lines.length > 0)
    .sort((a, b) => a.at - b.at || a.conv.localeCompare(b.conv));

  const lastSpokeAt = new Map<string, number>();
  const out: ChatterConversation[] = [];
  for (const g of chronological) {
    const key = pairKey(g.from, g.to);
    const prev = lastSpokeAt.get(key);
    const sincePrevMs = prev === undefined ? undefined : Math.max(0, g.at - prev);
    lastSpokeAt.set(key, g.at);
    out.push({
      conv: g.conv,
      at: g.at,
      from: g.from,
      to: g.to,
      lines: g.lines,
      summary: summarizeConversation(g.lines, sincePrevMs)
    });
  }

  out.reverse(); // newest first for display
  return limit > 0 && out.length > limit ? out.slice(0, limit) : out;
}

/**
 * The rules, isolated. Given the lines of ONE exchange (and how long since this
 * pair last spoke), decide what shape it took.
 *
 * Ordered by specificity, and the order is the design: a two-line exchange is a
 * nod whatever else is true of it, and "one of them barely spoke" is a more
 * interesting fact about a long conversation than its length.
 */
export function summarizeConversation(
  lines: readonly { by: string; text: string }[],
  sincePrevMs?: number
): ConversationSummary {
  const lineCount = lines.length;
  let questions = 0;
  const spoken = new Map<string, number>();
  let highlight = '';
  let highlightBy = '';
  for (const l of lines) {
    const text = l.text.trim();
    if (isQuestion(text)) questions += 1;
    spoken.set(l.by, (spoken.get(l.by) ?? 0) + 1);
    if (text.length > highlight.length) { highlight = text; highlightBy = l.by; }
  }

  // "Dominant" needs a real gap, not a one-line edge — an odd-length exchange
  // always leaves someone one ahead, and calling that domination would label
  // literally every three-line chat.
  let dominant: string | undefined;
  let topShare = 0;
  const ranked = [...spoken.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (lineCount > 0 && ranked.length > 0) {
    topShare = ranked[0][1] / lineCount;
    if (ranked.length > 1 && ranked[0][1] - ranked[1][1] >= 2) dominant = ranked[0][0];
  }

  const shape: ConversationShape =
    lineCount <= 2 ? 'nod'
      : questions / lineCount >= 0.5 ? 'interrogation'
        : topShare >= 0.7 && dominant !== undefined ? 'oneSided'
          : lineCount >= 5 ? 'backAndForth'
            : 'exchange';

  return {
    shape,
    lineCount,
    dominant,
    questions,
    highlight,
    highlightBy,
    resumed: sincePrevMs !== undefined && sincePrevMs <= RESUME_WINDOW_MS,
    sincePrevMs
  };
}

/** One pair's conversational volume — the "who talks to whom" digest under the
 *  conversation list. Counts only; nothing here reads a word. */
export interface PairVolume {
  a: string;
  b: string;
  conversations: number;
  lines: number;
  lastAt: number;
}

/** Rank pairs by how much they actually talk. Unordered pairs on purpose: this
 *  is volume, and volume has no direction. */
export function pairVolumes(convs: readonly ChatterConversation[]): PairVolume[] {
  const map = new Map<string, PairVolume>();
  for (const c of convs) {
    const key = pairKey(c.from, c.to);
    const [a, b] = key.split('|');
    const entry = map.get(key) ?? { a, b, conversations: 0, lines: 0, lastAt: 0 };
    entry.conversations += 1;
    entry.lines += c.lines.length;
    if (c.at > entry.lastAt) entry.lastAt = c.at;
    map.set(key, entry);
  }
  return [...map.values()].sort((x, y) => y.lines - x.lines || y.lastAt - x.lastAt);
}
