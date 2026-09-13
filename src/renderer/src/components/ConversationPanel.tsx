import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { SpritePortrait } from './SpritePortrait';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import {
  buildConversations, pairVolumes, type ChatterConversation
} from '@/store/chatterSummary';
import { buildRelPairs, edgeToneKey, type RelEdge, type RelPairView } from '@/store/relView';
import {
  approveLookProposal, forgetApplied, listApplied, listProposals, proposeLook,
  rejectLookProposal, rememberProposal, storageSinks, wasDismissed,
  type AppliedLook, type LookProposal, type LookTraitId
} from '@/store/lookProposal';
import {
  getCustomCharacter, saveCustomCharacter, useCustomCharacters
} from '@/scene/office/customCast';
import {
  PORTRAIT_W, PORTRAIT_H, paintPortraitFromRecipe, recipeForFixedCharacter, type Recipe
} from '@/scene/office/portraitArt';

/**
 * CONVERSATION — what the floor talked about, who they became, and what they
 * would like to wear.
 *
 * A READ surface with exactly one write in it, and that write needs a click.
 * Three sections, in the order of how derived they are:
 *
 *   1. RECENT CONVERSATIONS. The durable break-room transcript, grouped back
 *      into exchanges, each with a summary computed BY RULES (store/
 *      chatterSummary.ts) — shape, length, who did the talking, whether it
 *      resumed an earlier thread. No model is asked to summarize anything: the
 *      decision that this tab costs zero tokens is the user's, and it is why
 *      the summaries describe SHAPE rather than claiming to know the topic.
 *   2. RELATIONSHIPS, SHOWN AS DIRECTIONAL. Every pair is two rows, never one
 *      averaged bar — see store/relView.ts for why averaging would destroy the
 *      only interesting thing the model produces. The most LOPSIDED pairs sort
 *      to the top, because an attachment one of them does not return is the
 *      thing worth looking at.
 *   3. PERSONALITY & LOOK. Traits earned from accumulated interaction (derived
 *      in src/main/officeTraits.ts), each shown with the arithmetic behind it,
 *      plus any appearance the agent has ASKED for. A proposal is inert until a
 *      human clicks approve, and can be undone afterwards.
 *
 * THE BOUNDARY, RESTATED WHERE IT IS ENFORCED: nothing on this tab can touch
 * the work. No task, no assignment, no agent status, no queue. The single new
 * write in the whole feature is `updateAgent({ character })` after an explicit
 * approval click, plus the custom character that approval mints — both cosmetic,
 * both reversible, neither reachable without the click.
 */

/** Same cadence as the legend and kanban polls — three views of the same floor
 *  should not disagree for longer than one tick. */
const POLL_MS = 5000;
/** How much transcript to read. Bounded on disk by retention anyway; this is
 *  the panel's own window. */
const HISTORY_LINES = 1200;
/** Conversations kept on screen. Enough to scroll through an afternoon. */
const MAX_CONVERSATIONS = 40;

export function ConversationPanel() {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const restorableAgents = useStore((s) => s.restorableAgents);
  const archivedAgents = useStore((s) => s.archivedAgents);
  const updateAgent = useStore((s) => s.updateAgent);
  // Subscribed so an approval (which mints a character) re-renders the previews
  // that read the registry.
  useCustomCharacters();

  const [convs, setConvs] = useState<ChatterConversation[]>([]);
  const [pairs, setPairs] = useState<RelPairView[]>([]);
  const [traits, setTraits] = useState<AgentTraitsView[]>([]);
  const [proposals, setProposals] = useState<LookProposal[]>([]);
  const [applied, setApplied] = useState<AppliedLook[]>([]);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Display name for an agent id: the live floor first, then the restorable
   *  and archived rosters (so a conversation keeps its speakers' names after a
   *  terminal is gone), then the raw id rather than nothing. Same rule the
   *  legend and the kanban use. */
  const nameFor = useCallback((id: string): string =>
    agents.find((a) => a.id === id)?.name
    ?? restorableAgents.find((a) => a.id === id)?.name
    ?? archivedAgents.find((a) => a.id === id)?.name
    ?? id,
  [agents, restorableAgents, archivedAgents]);

  const characterFor = useCallback((id: string): string | undefined =>
    agents.find((a) => a.id === id)?.character
    ?? restorableAgents.find((a) => a.id === id)?.character,
  [agents, restorableAgents]);

  const readLocal = useCallback(() => {
    setProposals(listProposals());
    setApplied(listApplied());
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [history, rel, traitRows] = await Promise.all([
        window.cth.officeChatHistory(HISTORY_LINES),
        window.cth.officeRelSnapshot(),
        window.cth.officeTraitsSnapshot()
      ]);
      setConvs(buildConversations(history, MAX_CONVERSATIONS));
      setPairs(buildRelPairs(rel));
      setTraits((traitRows ?? []) as AgentTraitsView[]);
      setLoaded(true);
    } catch {
      // Keep the last good view — a failed poll is not a reason to blank a
      // panel the user is reading.
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    readLocal();
    void refresh();
    timer.current = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh, readLocal]);

  // ── Where proposals come from ────────────────────────────────────────────
  // Derived from the traits that just arrived, against each agent's CURRENT
  // recipe. This writes a pending row and NOTHING else: no character is saved,
  // no agent is touched. The proposal is a request sitting in a queue until a
  // human answers it — which is the entire design (see store/lookProposal.ts).
  useEffect(() => {
    if (traits.length === 0) return;
    let added = false;
    for (const reading of traits) {
      const agent = agents.find((a) => a.id === reading.id);
      if (!agent) continue;                       // no live agent ⇒ nothing to redress
      const base = baseRecipeFor(agent.character);
      if (!base) continue;
      const ask = proposeLook(reading.traits as { id: LookTraitId; strength: number }[], base);
      if (!ask) continue;
      if (wasDismissed(agent.id, ask.trait)) continue;  // told no already, this session
      if (rememberProposal(agent.id, agent.character, ask.trait, ask.patch)) added = true;
    }
    if (added) readLocal();
  }, [traits, agents, readLocal]);

  const approve = (proposal: LookProposal) => {
    const agent = agents.find((a) => a.id === proposal.agentId);
    if (!agent) return;
    const base = baseRecipeFor(agent.character);
    if (!base) return;
    const existing = getCustomCharacter(agent.character);
    approveLookProposal(
      proposal,
      base,
      agent.character,
      agent.name,
      existing?.accent ?? '#6fa8dc',
      storageSinks(
        (displayName, accent, recipe) => saveCustomCharacter(displayName, accent, recipe).id,
        (agentId, characterId) => updateAgent(agentId, { character: characterId })
      )
    );
    readLocal();
  };

  const reject = (proposal: LookProposal) => {
    rejectLookProposal(
      proposal,
      storageSinks(
        // Unreachable on this path by construction — rejection calls neither —
        // but passing real sinks rather than throwing stubs keeps the test and
        // the app driving the exact same function.
        (displayName, accent, recipe) => saveCustomCharacter(displayName, accent, recipe).id,
        (agentId, characterId) => updateAgent(agentId, { character: characterId })
      )
    );
    readLocal();
  };

  /** Put a look back. The minted character is deliberately LEFT in the
   *  registry: deleting it could pull the rug from another agent wearing it,
   *  and an undo that destroys something is not an undo. */
  const undo = (record: AppliedLook) => {
    updateAgent(record.agentId, { character: record.previousCharacter });
    forgetApplied(record.id);
    readLocal();
  };

  const volumes = useMemo(() => pairVolumes(convs).slice(0, 6), [convs]);
  const traitById = useMemo(() => {
    const map = new Map<string, AgentTraitsView>();
    for (const row of traits) map.set(row.id, row);
    return map;
  }, [traits]);
  const proposalFor = useCallback(
    (agentId: string) => proposals.find((p) => p.agentId === agentId),
    [proposals]
  );
  const appliedFor = useCallback(
    (agentId: string) => applied.find((a) => a.agentId === agentId),
    [applied]
  );

  const nothingYet = loaded && convs.length === 0 && pairs.length === 0 && traits.length === 0;

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--cth-paper-200)'
    }}>
      {/* Header — mirrors the legend/kanban toolbars so the tabs read as siblings. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)' }}>
          {t('conversation.count', { count: convs.length })}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cth-ink-300)' }}>
          {t('conversation.hint')}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {nothingYet ? (
          <Empty title={t('conversation.empty')} body={t('conversation.emptyHint')} />
        ) : (
          <>
            {/* ── 1. RECENT CONVERSATIONS ───────────────────────────────── */}
            <Section title={t('conversation.sections.recent')}>
              {convs.length === 0 ? (
                <Muted>{t('conversation.noConversations')}</Muted>
              ) : (
                <>
                  {volumes.length > 0 && (
                    <div style={{
                      display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, padding: '6px 8px',
                      background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                    }}>
                      {volumes.map((v) => (
                        <span key={`${v.a}|${v.b}`} style={{
                          fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-700)'
                        }}>
                          {t('conversation.volume', {
                            a: nameFor(v.a), b: nameFor(v.b), count: v.lines
                          })}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {convs.map((c) => (
                      <ConversationRow key={c.conv} conv={c} nameFor={nameFor} characterFor={characterFor} />
                    ))}
                  </div>
                </>
              )}
            </Section>

            {/* ── 2. RELATIONSHIPS ──────────────────────────────────────── */}
            <Section title={t('conversation.sections.relations')}>
              <Muted>{t('conversation.directionalNote')}</Muted>
              {pairs.length === 0 ? (
                <Muted>{t('conversation.noRelations')}</Muted>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                  {pairs.map((p) => <RelPairRow key={p.key} pair={p} nameFor={nameFor} />)}
                </div>
              )}
            </Section>

            {/* ── 3. PERSONALITY & LOOK ─────────────────────────────────── */}
            <Section title={t('conversation.sections.personality')}>
              <Muted>{t('conversation.personalityNote')}</Muted>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                {agents.map((a) => (
                  <PersonalityRow
                    key={a.id}
                    name={a.name}
                    character={a.character}
                    accent={a.accent}
                    reading={traitById.get(a.id)}
                    proposal={proposalFor(a.id)}
                    applied={appliedFor(a.id)}
                    onApprove={approve}
                    onReject={reject}
                    onUndo={undo}
                  />
                ))}
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Types mirrored from the preload bridge ─────────────────────────────────

interface TraitReadingView { id: string; strength: number; evidence: { a: number; b: number } }
interface AgentTraitsView {
  id: string;
  traits: TraitReadingView[];
  lines: number;
  exchanges: number;
  partners: number;
}

// ─── One conversation ───────────────────────────────────────────────────────

function ConversationRow({
  conv, nameFor, characterFor
}: {
  conv: ChatterConversation;
  nameFor: (id: string) => string;
  characterFor: (id: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const when = new Date(conv.at);
  const s = conv.summary;
  return (
    <div style={{
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', border: 'none', background: 'transparent', cursor: 'pointer',
          padding: '6px 8px', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>{open ? '▾' : '▸'}</span>
          <Portrait character={characterFor(conv.from)} />
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)' }}>
            {nameFor(conv.from)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>↔</span>
          <Portrait character={characterFor(conv.to)} />
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)' }}>
            {nameFor(conv.to)}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--cth-ink-300)' }}>
            {isNaN(when.getTime()) ? '' : when.toLocaleString()}
          </span>
        </span>
        {/* THE SUMMARY. Every clause is a count or a comparison — see the
            header note on why it describes shape and not topic. */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', paddingLeft: 16 }}>
          <Chip tone="shape">{t(`conversation.shape.${s.shape}`)}</Chip>
          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
            {t('conversation.lineCount', { count: s.lineCount })}
          </span>
          {s.dominant && (
            <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
              {t('conversation.dominant', { name: nameFor(s.dominant) })}
            </span>
          )}
          {s.questions > 0 && (
            <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
              {t('conversation.questions', { count: s.questions })}
            </span>
          )}
          {s.resumed && <Chip tone="resumed">{t('conversation.resumed')}</Chip>}
        </span>
        {/* A QUOTE, not a paraphrase: the longest line they actually said. */}
        {s.highlight && (
          <span style={{
            paddingLeft: 16, fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)',
            fontStyle: 'italic', display: '-webkit-box', WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical', overflow: 'hidden'
          }}>“{s.highlight}”</span>
        )}
      </button>
      {open && (
        <div style={{
          padding: '4px 8px 8px 24px', display: 'flex', flexDirection: 'column', gap: 3,
          borderTop: '1px solid var(--cth-ink-100)'
        }}>
          {conv.lines.map((l, i) => (
            <span key={i} style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)' }}>
              <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)', marginRight: 6 }}>
                {nameFor(l.by).toUpperCase()}
              </span>
              {l.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── One pair, both directions, never averaged ──────────────────────────────

function RelPairRow({ pair, nameFor }: { pair: RelPairView; nameFor: (id: string) => string }) {
  const { t } = useTranslation();
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4, padding: 6,
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-700)' }}>
          {nameFor(pair.a).toUpperCase()} · {nameFor(pair.b).toUpperCase()}
        </span>
        <Chip tone={pair.reciprocity === 'mutual' ? 'shape' : 'asym'}>
          {t(`conversation.recip.${pair.reciprocity}`)}
        </Chip>
      </div>
      {/* Two rows, ALWAYS. A missing direction is stated as missing rather than
          drawn as zero — "we have no history" is not "I feel nothing". */}
      <Direction edge={pair.ab} from={nameFor(pair.a)} to={nameFor(pair.b)} />
      <Direction edge={pair.ba} from={nameFor(pair.b)} to={nameFor(pair.a)} />
    </div>
  );
}

function Direction({ edge, from, to }: { edge: RelEdge | null; from: string; to: string }) {
  const { t } = useTranslation();
  const tone = edgeToneKey(edge);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}>
      <span style={{
        fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)',
        flexShrink: 0, width: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }}>{from} → {to}</span>
      {!edge ? (
        <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>{t('conversation.noDirection')}</span>
      ) : (
        <>
          <Chip tone={tone === 'prickly' || tone === 'cold' ? 'asym' : 'shape'}>
            {t(`conversation.tone.${tone}`)}
          </Chip>
          <Axis label={t('conversation.axes.warmth')} value={edge.warmth} signed />
          <Axis label={t('conversation.axes.tension')} value={edge.tension} />
          <Axis label={t('conversation.axes.familiarity')} value={edge.familiarity} />
          <span style={{ fontSize: 10, color: 'var(--cth-ink-300)' }}>
            {t('conversation.interactions', { count: Math.round(edge.interactions) })}
          </span>
        </>
      )}
    </div>
  );
}

/** One axis as a tiny bar. `signed` axes run −1..1 and are drawn from the
 *  centre, because a negative warmth is a real reading and a bar that starts at
 *  zero would render dislike as "no relationship". */
function Axis({ label, value, signed = false }: { label: string; value: number; signed?: boolean }) {
  const pct = signed ? Math.min(100, Math.abs(value) * 100) : Math.min(100, Math.max(0, value) * 100);
  const negative = signed && value < 0;
  const color = negative ? 'var(--cth-coral)' : signed ? 'var(--cth-mint)' : 'var(--cth-lemon)';
  return (
    <span
      title={`${label} ${value.toFixed(2)}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 7, color: 'var(--cth-ink-300)' }}>{label}</span>
      <span style={{
        width: 44, height: 6, background: 'var(--cth-cream-200)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', display: 'inline-flex',
        justifyContent: signed && negative ? 'flex-end' : 'flex-start'
      }}>
        <span style={{ width: `${pct}%`, height: '100%', background: color }} />
      </span>
    </span>
  );
}

// ─── One agent's personality, and what they would like to wear ──────────────

function PersonalityRow({
  name, character, accent, reading, proposal, applied, onApprove, onReject, onUndo
}: {
  name: string;
  character: string;
  accent: string;
  reading?: AgentTraitsView;
  proposal?: LookProposal;
  applied?: AppliedLook;
  onApprove: (p: LookProposal) => void;
  onReject: (p: LookProposal) => void;
  onUndo: (a: AppliedLook) => void;
}) {
  const { t } = useTranslation();
  const base = baseRecipeFor(character);
  const preview = proposal && base ? { ...base, ...proposal.patch } as Recipe : null;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 5, padding: 6,
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 24, height: 24, background: `var(--cth-${accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
        }}>
          <SpritePortrait character={character} scale={1} />
        </div>
        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)' }}>{name}</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-300)' }}>
          {t('conversation.sample', {
            lines: reading?.lines ?? 0,
            exchanges: reading?.exchanges ?? 0,
            partners: reading?.partners ?? 0
          })}
        </span>
      </div>

      {/* TRAITS, each with the arithmetic it came from. A trait you cannot
          audit is a horoscope — see src/main/officeTraits.ts. */}
      {!reading || reading.traits.length === 0 ? (
        <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>{t('conversation.noTraits')}</span>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {reading.traits.map((tr) => (
            <span
              key={tr.id}
              title={t(`conversation.evidence.${tr.id}`, { a: tr.evidence.a, b: tr.evidence.b })}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11, lineHeight: '16px', padding: '1px 6px',
                background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                color: 'var(--cth-ink-900)'
              }}
            >
              {t(`conversation.trait.${tr.id}`)}
              <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 9, color: 'var(--cth-ink-500)' }}>
                {tr.evidence.a}/{tr.evidence.b}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* THE ASK. Inert until the button is pressed. */}
      {proposal && preview && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: 6, flexWrap: 'wrap',
          background: 'var(--cth-lemon-light, var(--cth-cream-100))',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}>
          <RecipePreview recipe={preview} />
          <span style={{ flex: 1, minWidth: 140, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)' }}>
              {t('conversation.look.asks', {
                name,
                change: t(`conversation.look.change.${proposal.trait}`),
                trait: t(`conversation.trait.${proposal.trait}`)
              })}
            </span>
            <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>{t('conversation.look.neverAuto')}</span>
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <PixelButton variant="primary" size="sm" onClick={() => onApprove(proposal)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="check" /> {t('conversation.look.approve')}
              </span>
            </PixelButton>
            <PixelButton variant="secondary" size="sm" onClick={() => onReject(proposal)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="x" /> {t('conversation.look.reject')}
              </span>
            </PixelButton>
          </span>
        </div>
      )}

      {/* Reversible: the look the agent is wearing was approved, and one click
          puts the old one back. */}
      {applied && character === applied.appliedCharacter && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
            {t('conversation.look.applied', { trait: t(`conversation.trait.${applied.trait}`) })}
          </span>
          <PixelButton variant="secondary" size="sm" onClick={() => onUndo(applied)}>
            {t('conversation.look.undo')}
          </PixelButton>
        </div>
      )}
      {/* An agent with no proposal and nothing applied gets a quiet line rather
          than an empty row, so "nobody asked for anything" reads as a state. */}
      {!proposal && !applied && reading && reading.traits.length > 0 && (
        <span style={{ fontSize: 10, color: 'var(--cth-ink-300)' }}>{t('conversation.look.none')}</span>
      )}
    </div>
  );
}

/** The PROPOSED portrait, painted with the same engine the builder and the
 *  floor use. Approving a change you cannot see is not really approving it. */
function RecipePreview({ recipe }: { recipe: Recipe }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const scale = 2;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try { paintPortraitFromRecipe(ctx, recipe, scale); } catch { /* never break the panel over a preview */ }
  }, [recipe]);
  return (
    <canvas
      ref={ref}
      width={Math.round(PORTRAIT_W * scale)}
      height={Math.round(PORTRAIT_H * scale)}
      style={{
        imageRendering: 'pixelated', flexShrink: 0,
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', background: 'var(--cth-cream-100)'
      }}
    />
  );
}

/** The agent's current recipe — from the custom registry if it is a
 *  `custom:<uuid>`, otherwise the fixed cast table. Both are COPIES: this is
 *  the base a proposal derives from, and mutating either source would repaint a
 *  character the user built (or one of the fixed fifteen) for everyone wearing
 *  it. Undefined only for a character id that resolves to neither. */
function baseRecipeFor(character: string): Recipe | undefined {
  const custom = getCustomCharacter(character);
  if (custom) return { ...custom.recipe };
  return recipeForFixedCharacter(character);
}

// ─── small shared bits ──────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)',
        marginBottom: 6, letterSpacing: 0.5
      }}>{title}</div>
      {children}
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-300)' }}>{children}</div>;
}

function Chip({ tone, children }: { tone: 'shape' | 'asym' | 'resumed'; children: ReactNode }) {
  const bg = tone === 'asym' ? 'var(--cth-coral)' : tone === 'resumed' ? 'var(--cth-lilac)' : 'var(--cth-mint)';
  return (
    <span style={{
      fontFamily: 'var(--cth-font-display)', fontSize: 8, padding: '2px 5px 1px',
      background: bg, color: 'var(--cth-ink-900)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>{children}</span>
  );
}

function Portrait({ character }: { character?: string }) {
  if (!character) return null;
  return (
    <span style={{
      width: 16, height: 16, overflow: 'hidden', display: 'inline-flex',
      alignItems: 'flex-end', justifyContent: 'center', flexShrink: 0
    }}>
      <SpritePortrait character={character} scale={0.7} />
    </span>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      padding: '28px 16px', textAlign: 'center',
      background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>{title}</span>
      <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-500)', maxWidth: 380 }}>{body}</span>
    </div>
  );
}
