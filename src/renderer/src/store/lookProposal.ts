/**
 * "CAN I CHANGE HOW I LOOK?" — proposals, never applications.
 *
 * ─── THE RULE THIS MODULE EXISTS TO ENFORCE ─────────────────────────────────
 * An agent may PROPOSE a change to its own appearance. The proposal shows up in
 * the conversation tab. A HUMAN approves or rejects it with one click. NOTHING
 * IS EVER APPLIED WITHOUT THAT CLICK — not on a timer, not on app start, not
 * when the evidence gets strong enough, not ever.
 *
 * The reason is not caution for its own sake. The office floor's cast is the
 * user's: they built it, they named it, they picked the faces, and
 * `customCast.ts` persists it. A personality derived from statistics can be
 * wrong (a quiet week, a burst of check-ins during one incident), and a future
 * version of this feature could well have a MODEL write the proposal instead of
 * the rules below. Either way the floor reconfiguring itself out from under the
 * person who built it is the outcome to design out — so the approval gate lives
 * here, in the data model, rather than in whatever produced the suggestion.
 *
 * Two properties follow, and both are tested:
 *   • REJECTION LEAVES NO TRACE. `rejectLookProposal` deletes the row. No
 *     "declined" tombstone, no cooldown record, nothing the agent can read back.
 *   • APPROVAL IS REVERSIBLE. Applying records the character the agent had
 *     BEFORE, so one click puts it back. A cosmetic change you cannot undo is
 *     not cosmetic.
 *
 * ─── WHY THE PROPOSAL IS RULE-DERIVED ──────────────────────────────────────
 * Same decision as the rest of this tab: zero tokens. A proposal here is a
 * lookup — strongest earned trait → one small recipe patch — which means it is
 * explainable ("you ask more questions than anyone, so: glasses") and it is
 * deterministic, which is what lets a test assert that generating one changes
 * nothing. The approval gate is deliberately NOT justified by "a model might
 * hallucinate": it is justified by the state being the user's, and it would
 * stand unchanged if a model wrote the patch tomorrow.
 *
 * ─── WHAT IT MAY TOUCH ─────────────────────────────────────────────────────
 * Exactly two things, and only through injected sinks (see `LookSinks`): the
 * custom-character registry (`customCast.saveCustomCharacter`, ADD only — no
 * existing character is ever mutated or deleted) and the agent's `character`
 * field. It cannot reach a task, an assignment, an agent's status, the hive, or
 * anything else operational. That boundary is inherited from Phase 6 and is not
 * negotiable: conversation may READ the work and never write it. Appearance,
 * after an explicit human click, is the single exception.
 */

import type { Recipe } from '@/scene/office/portraitArt';

/** Trait ids, mirroring `TraitId` in src/main/officeTraits.ts. Restated rather
 *  than imported so this renderer module pulls in nothing from main. */
export type LookTraitId =
  | 'curious' | 'terse' | 'expansive' | 'opener' | 'listener' | 'social'
  | 'loyal' | 'caretaker' | 'contrarian' | 'beloved' | 'abrasive' | 'veteran';

/** One earned trait — the subset of `TraitReading` this module needs. */
export interface LookTrait {
  id: LookTraitId;
  strength: number;
}

/** A trait must be at least this strong before it is allowed to ask for a new
 *  face. Above the derivation's own threshold on purpose: a trait that barely
 *  registers is a fine thing to LIST and a poor reason to redraw someone. */
export const MIN_STRENGTH_TO_PROPOSE = 0.35;

/** The patch a trait asks for. Every one is a single field: a proposal the user
 *  cannot hold in their head at approval time is a proposal they cannot
 *  meaningfully approve. */
type LookPatch = Partial<Recipe>;

/**
 * Trait → the one cosmetic change it argues for.
 *
 * Every entry is a legible piece of reasoning, not a random dress-up: the one
 * who is always asking gets something to peer through; the one who never opens
 * a conversation gets headphones; the one who checks on people gets the scarf.
 * The panel shows the trait beside the patch, so the user approves an ARGUMENT,
 * not a diff.
 */
const TRAIT_LOOKS: Record<LookTraitId, LookPatch> = {
  curious: { glasses: 'round' },
  terse: { mouth: 'neutral' },
  expansive: { mouth: 'smile' },
  opener: { accessory: 'cap' },
  listener: { accessory: 'headphones' },
  social: { accessory: 'lanyard' },
  loyal: { accessory: 'earrings' },
  caretaker: { accessory: 'scarf' },
  contrarian: { brow: 'angry' },
  beloved: { blush: true },
  abrasive: { brow: 'angry' },
  veteran: { accessory: 'watch' }
};

/** A pending suggestion. Inert by construction: it holds a patch, not a change. */
export interface LookProposal {
  /** Stable id — the React key and the handle for approve/reject. */
  id: string;
  agentId: string;
  /** The character the agent was wearing when this was proposed. Approval is
   *  refused if it has since changed, so a stale proposal can never silently
   *  overwrite a look the user picked by hand in the meantime. */
  basedOn: string;
  trait: LookTraitId;
  /** The single-field change being asked for. */
  patch: LookPatch;
  createdAt: number;
}

/** The record of an approval — kept so it can be undone. */
export interface AppliedLook {
  id: string;
  agentId: string;
  trait: LookTraitId;
  /** The character id the agent wore BEFORE. One click restores it. */
  previousCharacter: string;
  /** The character id minted by the approval. */
  appliedCharacter: string;
  appliedAt: number;
}

/** True when `recipe` already has everything `patch` asks for — in which case
 *  there is nothing to propose. Shallow by design: every patch is one scalar
 *  field (see TRAIT_LOOKS), so a deep compare would be machinery for a case
 *  that cannot arise. */
export function patchIsSatisfied(recipe: Recipe, patch: LookPatch): boolean {
  const fields = recipe as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (fields[k] !== v) return false;
  }
  return true;
}

/** Apply a patch to a recipe, returning a NEW recipe. Never mutates its input —
 *  the base is either a live custom character or one of the fifteen fixed cast
 *  recipes, and mutating either would corrupt the registry this feature is
 *  explicitly not allowed to damage. */
export function applyLookPatch(recipe: Recipe, patch: LookPatch): Recipe {
  return { ...recipe, ...patch };
}

/**
 * What, if anything, this agent would ask for. PURE — it reads and returns, and
 * touches no storage, no registry and no agent.
 *
 * Picks the strongest earned trait whose look the agent is not already wearing.
 * One proposal at a time, on purpose: a queue of six cosmetic suggestions is a
 * chore, and the strongest trait is the one with the best claim to be seen.
 *
 * @returns the patch and the trait that argued for it, or null when there is
 *          nothing worth asking (no trait strong enough, or already wearing it).
 */
export function proposeLook(
  traits: readonly LookTrait[],
  current: Recipe
): { trait: LookTraitId; patch: LookPatch } | null {
  const ranked = [...traits]
    .filter((t) => t && TRAIT_LOOKS[t.id] && t.strength >= MIN_STRENGTH_TO_PROPOSE)
    .sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  for (const t of ranked) {
    const patch = TRAIT_LOOKS[t.id];
    if (!patchIsSatisfied(current, patch)) return { trait: t.id, patch: { ...patch } };
  }
  return null;
}

// ─── The sinks: the only way anything here reaches persistent state ──────────

export interface LookSinks {
  /** Register a NEW custom character and return its id. Additive only — this is
   *  `customCast.saveCustomCharacter`, which appends; nothing here can edit or
   *  delete a character the user built. */
  saveCharacter: (displayName: string, accent: string, recipe: Recipe) => string;
  /** Point the agent at a character id (`store.updateAgent`). */
  setAgentCharacter: (agentId: string, characterId: string) => void;
  /** Drop the proposal from the pending queue. */
  forget: (proposalId: string) => void;
  /** Record the approval so it can be undone. */
  remember?: (applied: AppliedLook) => void;
}

// ─── "Rejectable without a trace", made precise ──────────────────────────────
// A rejected proposal must leave nothing persistent behind — no "declined"
// tombstone on disk, nothing the floor or a future model could read back as
// "the human said no to this". But the generator below re-derives proposals
// from traits on every refresh, so a purely stateless rejection would put the
// same card back on screen two seconds later, which makes the reject button a
// lie.
//
// The resolution is a SESSION-ONLY suppression: an in-memory set, never
// serialized, gone when the app closes. Nothing is written, nothing survives a
// restart, and the trait can legitimately ask again next session — while within
// this one, "no" means no.
const dismissedThisSession = new Set<string>();
const dismissKey = (agentId: string, trait: LookTraitId): string => `${agentId}|${trait}`;

/** Has this agent's request for this trait already been turned down in THIS
 *  session? The generator checks it so a rejected card does not come straight
 *  back. */
export function wasDismissed(agentId: string, trait: LookTraitId): boolean {
  return dismissedThisSession.has(dismissKey(agentId, trait));
}

/** Forget every session dismissal — tests only; the app never calls it, because
 *  quitting already does the same thing by construction. */
export function clearDismissals(): void {
  dismissedThisSession.clear();
}

/**
 * REJECT. Removes the proposal and does nothing else — no character is saved,
 * no agent is touched, and nothing is PERSISTED that the floor could later read
 * as "they said no" (the suppression above is memory-only). The signature takes
 * the full sink object deliberately: a test hands it the same spy object it
 * hands `approveLookProposal`, and asserts the two write sinks were never
 * called.
 */
export function rejectLookProposal(proposal: LookProposal, sinks: LookSinks): void {
  dismissedThisSession.add(dismissKey(proposal.agentId, proposal.trait));
  sinks.forget(proposal.id);
}

/**
 * APPROVE — the single new write in this whole feature, and it runs only from a
 * click.
 *
 * Mints a NEW custom character from `base + patch` rather than editing anything
 * that exists, then repoints the agent at it. Two consequences, both wanted:
 * the user's original character is untouched and still selectable, and the undo
 * is just "point the agent back", with no restoration step that could fail.
 *
 * @param base the agent's CURRENT recipe — resolved by the caller from either
 *             the custom registry or the fixed cast table.
 * @param currentCharacter the agent's character id right now. If it no longer
 *             matches `proposal.basedOn`, the proposal is STALE (the user
 *             changed the look by hand since) and is dropped rather than
 *             applied over their choice.
 * @returns the applied record, or null when nothing was applied.
 */
export function approveLookProposal(
  proposal: LookProposal,
  base: Recipe,
  currentCharacter: string,
  displayName: string,
  accent: string,
  sinks: LookSinks
): AppliedLook | null {
  if (currentCharacter !== proposal.basedOn) {
    // The user already made their own decision about this face. Theirs wins,
    // and the stale suggestion goes away silently.
    sinks.forget(proposal.id);
    return null;
  }
  const recipe = applyLookPatch(base, proposal.patch);
  const appliedCharacter = sinks.saveCharacter(displayName, accent, recipe);
  if (!appliedCharacter) return null;
  sinks.setAgentCharacter(proposal.agentId, appliedCharacter);
  const applied: AppliedLook = {
    id: proposal.id,
    agentId: proposal.agentId,
    trait: proposal.trait,
    previousCharacter: currentCharacter,
    appliedCharacter,
    appliedAt: Date.now()
  };
  sinks.remember?.(applied);
  sinks.forget(proposal.id);
  return applied;
}

// ─── Persistence — the pending queue and the undo log ────────────────────────
// Renderer-local localStorage, exactly like customCast.ts and for the same
// reasons argued at the top of that file: this is cosmetic, renderer-only data
// that no main-process code reads, and it lives beside the character registry
// it refers to. Both lists are small and bounded.

const PENDING_KEY = 'cth.lookProposals.v1';
const APPLIED_KEY = 'cth.lookApplied.v1';
/** Approvals kept for undo. Small: the undo that matters is the last one. */
const MAX_APPLIED = 20;

function readList<T>(key: string, valid: (v: unknown) => v is T): T[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(valid);
  } catch {
    // No window (a node test), private mode, quota, corrupt JSON — all the same
    // answer: there are no proposals. Never throw from a storage read.
    return [];
  }
}

function writeList(key: string, list: unknown[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch { /* best-effort persist, exactly like customCast.ts */ }
}

function isProposal(v: unknown): v is LookProposal {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<LookProposal>;
  return typeof p.id === 'string' && !!p.id
    && typeof p.agentId === 'string' && !!p.agentId
    && typeof p.basedOn === 'string'
    && typeof p.trait === 'string' && p.trait in TRAIT_LOOKS
    && !!p.patch && typeof p.patch === 'object';
}

function isApplied(v: unknown): v is AppliedLook {
  if (!v || typeof v !== 'object') return false;
  const a = v as Partial<AppliedLook>;
  return typeof a.id === 'string' && typeof a.agentId === 'string'
    && typeof a.previousCharacter === 'string' && typeof a.appliedCharacter === 'string';
}

export function listProposals(): LookProposal[] {
  return readList(PENDING_KEY, isProposal);
}

export function listApplied(): AppliedLook[] {
  return readList(APPLIED_KEY, isApplied);
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Record a proposal for an agent, unless one is already pending for them.
 *
 * ONE PER AGENT. The queue is a list of things a human has to read and decide
 * on; letting it grow to one row per trait per agent turns a small courtesy
 * into a backlog, and a backlog gets approved without reading.
 */
export function rememberProposal(
  agentId: string,
  basedOn: string,
  trait: LookTraitId,
  patch: LookPatch
): LookProposal | null {
  const pending = listProposals();
  if (pending.some((p) => p.agentId === agentId)) return null;
  const proposal: LookProposal = {
    id: newId(), agentId, basedOn, trait, patch, createdAt: Date.now()
  };
  writeList(PENDING_KEY, [...pending, proposal]);
  return proposal;
}

/** Drop a proposal. The rejection path — leaves nothing behind. */
export function forgetProposal(id: string): void {
  const next = listProposals().filter((p) => p.id !== id);
  writeList(PENDING_KEY, next);
}

/** Record an approval so the panel can offer an undo. */
export function rememberApplied(applied: AppliedLook): void {
  writeList(APPLIED_KEY, [applied, ...listApplied()].slice(0, MAX_APPLIED));
}

/** Drop an undo record once it has been used (or is no longer offerable). */
export function forgetApplied(id: string): void {
  writeList(APPLIED_KEY, listApplied().filter((a) => a.id !== id));
}

/** The storage-backed sink set used by the panel. Split out so the pure
 *  approve/reject functions above can be driven by spies in a test without any
 *  storage at all. */
export function storageSinks(
  saveCharacter: LookSinks['saveCharacter'],
  setAgentCharacter: LookSinks['setAgentCharacter']
): LookSinks {
  return { saveCharacter, setAgentCharacter, forget: forgetProposal, remember: rememberApplied };
}
