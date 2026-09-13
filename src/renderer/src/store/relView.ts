/**
 * RELATIONSHIPS, SHOWN AS WHAT THEY ARE: DIRECTIONAL.
 *
 * `officeRel.ts` tracks a separate row for each ORDERED edge — what Dwight feels
 * about Jim is not what Jim feels about Dwight, and the whole reason that book
 * is built the way it is, is that one interaction lands differently on the two
 * people in it. Being refused stings more than refusing. Being checked on while
 * you are stuck bonds harder than doing the checking.
 *
 * The tempting thing to do in a UI is to average the two directions into one
 * "relationship strength" bar per pair. THAT IS THE ONE THING THIS MODULE MUST
 * NOT DO, and it is not a style preference: averaging destroys the only
 * information the directional model exists to produce. A pair where one is
 * quietly attached and the other is indifferent averages to exactly the same
 * number as a pair of mild acquaintances, and the interesting one of those two
 * — the unrequited one — becomes invisible at precisely the moment it starts
 * being interesting.
 *
 * So this module pairs the two edges WITHOUT COMBINING THEM, and its main
 * output is `asymmetry`: how far apart the two readings are. That number is what
 * the panel sorts by, so the most lopsided relationships on the floor are the
 * ones you see first.
 *
 * Pure data in, pure data out — no React, no store, no IPC.
 */

/** One DIRECTED edge — structurally `OfficeRelSummary` from the preload bridge
 *  (and `RelSummary` in src/main/officeRel.ts), restated so this module depends
 *  on no ambient type. */
export interface RelEdge {
  from: string;
  to: string;
  warmth: number;
  tension: number;
  familiarity: number;
  interactions: number;
  flavor: string;
}

/** How the two directions of one pair relate to each other. Descriptive labels
 *  over a continuum; the panel words them, nothing branches on them. */
export type Reciprocity =
  /** Both directions exist and read similarly — whatever they feel, they feel together. */
  | 'mutual'
  /** Both exist but one is markedly warmer than the other. The interesting case. */
  | 'lopsided'
  /** One direction has friction the other does not — a grudge only one is holding. */
  | 'oneSidedFriction'
  /** Only ONE direction has any history at all: they have interacted, but the
   *  book has only ever had cause to write one of the two rows. */
  | 'unanswered';

export interface RelPairView {
  /** Stable, order-independent key for React and for sorting. */
  key: string;
  /** The two agents, in the canonical (sorted) order `key` uses. */
  a: string;
  b: string;
  /** How `a` reads `b`, and how `b` reads `a`. Either can be null when the book
   *  has no row for that direction — and null is shown as "nothing recorded",
   *  never as zero, because "I feel neutral about you" and "we have no history"
   *  are different things. */
  ab: RelEdge | null;
  ba: RelEdge | null;
  reciprocity: Reciprocity;
  /** |warmth(ab) − warmth(ba)|, 0..2. The sort key: the bigger this is, the
   *  more the two of them disagree about what they are to each other. */
  asymmetry: number;
  /** The stronger of the two familiarities — how much history the pair has at
   *  all, used as the tiebreak so settled pairs outrank drive-by ones. */
  familiarity: number;
}

/** Warmth difference past which a pair reads as genuinely lopsided rather than
 *  as ordinary noise between two people who broadly agree. Chosen to match the
 *  width of one band in `flavorFor` (src/main/officeRel.ts): below it, both
 *  directions are usually described by the same sentence, so calling the pair
 *  lopsided would contradict the words on screen. */
export const LOPSIDED_WARMTH_GAP = 0.2;
/** Same idea for tension: a grudge one of them is holding and the other is not. */
export const ONE_SIDED_TENSION_GAP = 0.25;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Coerce one raw snapshot row into an edge, or null if it is not one. */
function toEdge(raw: unknown): RelEdge | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Partial<RelEdge>;
  if (typeof r.from !== 'string' || typeof r.to !== 'string') return null;
  if (!r.from || !r.to || r.from === r.to) return null;
  return {
    from: r.from,
    to: r.to,
    warmth: num(r.warmth),
    tension: num(r.tension),
    familiarity: num(r.familiarity),
    interactions: num(r.interactions),
    flavor: typeof r.flavor === 'string' ? r.flavor : ''
  };
}

/**
 * Pair up a directed snapshot without flattening it.
 *
 * @param snapshot payload from `window.cth.officeRelSnapshot()` — a flat list of
 *                 directed edges, where a settled pair appears twice.
 * @returns one entry per PAIR, holding both directions separately, most
 *          lopsided first.
 */
export function buildRelPairs(snapshot: unknown): RelPairView[] {
  const rows = Array.isArray(snapshot) ? snapshot : [];
  const byKey = new Map<string, { a: string; b: string; ab: RelEdge | null; ba: RelEdge | null }>();
  for (const raw of rows) {
    const edge = toEdge(raw);
    if (!edge) continue;
    const [a, b] = edge.from < edge.to ? [edge.from, edge.to] : [edge.to, edge.from];
    const key = `${a}|${b}`;
    const entry = byKey.get(key) ?? { a, b, ab: null, ba: null };
    // `ab` always means "how the alphabetically-first agent reads the other",
    // so the two slots mean the same thing for every pair no matter which
    // direction the snapshot happened to list first.
    if (edge.from === a) entry.ab = edge; else entry.ba = edge;
    byKey.set(key, entry);
  }

  const out: RelPairView[] = [];
  for (const [key, entry] of byKey) {
    const { ab, ba } = entry;
    const asymmetry = ab && ba ? Math.abs(ab.warmth - ba.warmth) : 0;
    const tensionGap = ab && ba ? Math.abs(ab.tension - ba.tension) : 0;
    const familiarity = Math.max(ab?.familiarity ?? 0, ba?.familiarity ?? 0);
    const reciprocity: Reciprocity =
      !ab || !ba ? 'unanswered'
        : tensionGap >= ONE_SIDED_TENSION_GAP ? 'oneSidedFriction'
          : asymmetry >= LOPSIDED_WARMTH_GAP ? 'lopsided'
            : 'mutual';
    out.push({ key, a: entry.a, b: entry.b, ab, ba, reciprocity, asymmetry, familiarity });
  }

  // Lopsided first — the asymmetry is the whole point of a directional model,
  // so it is what the top of the list should be about. Familiarity breaks ties
  // so two equally-symmetric pairs are ordered by how real they are, and the
  // key breaks the rest so the list never reshuffles between polls.
  out.sort((x, y) => y.asymmetry - x.asymmetry || y.familiarity - x.familiarity || x.key.localeCompare(y.key));
  return out;
}

/** Which i18n key words one direction's intensity. Mirrors the bands
 *  `flavorFor` branches on in src/main/officeRel.ts, so the badge and the
 *  sentence beside it can never contradict each other. */
export function edgeToneKey(edge: RelEdge | null): 'none' | 'warm' | 'fond' | 'prickly' | 'cold' | 'neutral' {
  if (!edge) return 'none';
  if (edge.familiarity < 0.12) return 'neutral';
  if (edge.warmth > 0.55 && edge.tension < 0.2) return 'fond';
  if (edge.tension > 0.35) return 'prickly';
  if (edge.warmth > 0.15) return 'warm';
  if (edge.warmth < -0.2) return 'cold';
  return 'neutral';
}
