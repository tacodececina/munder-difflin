import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelModal } from './PixelModal';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { Icon } from './Icon';
import { ProviderLogo } from './ProviderLogo';
import { useStore, type Agent } from '@/store/store';
import { OFFICE_CAST, DEFAULT_CHARACTER, type OfficeCharacterName } from '@/scene/office/cast';
import { useCustomCharacters, type CustomCharacter } from '@/scene/office/customCast';
import { CharacterBuilderModal } from './CharacterBuilderModal';
import { accentByName, hex as hexColor, type AccentColorName } from '@/design/tokens';
import { HIRE_SPEC_V1, type HireManifest } from '@shared/hire';
import type { RemoteEnvironment } from '@shared/remoteEnvironment';
import { hireQueueProgress } from '@shared/hireQueue';
import { MCP_CATALOG } from '@shared/mcpCatalog';
import {
  OSS_LOCAL_PICKS,
  OSS_PROVIDER_PICKS,
  localSlugFor,
  hasOssQuickPicks,
  OSS_BLOG_LINKS
} from '@shared/ossModels';
import {
  type AgentProvider,
  type HarnessConfig,
  AGENT_PROVIDER_PRESETS,
  buildSpawnCommand,
  tokenizeCommand,
  modelsForProvider,
  inferAgentProvider,
  providerPreset,
  isClaudeProvider
} from '@/store/config';
import { useRtl } from '@/i18n/useDirection';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

// OSS quick-pick chip styling (ondev-c) — mirrors the model-picker chips.
const ossChip = (active: boolean, accent: AccentColorName): CSSProperties => ({
  padding: '3px 8px 1px',
  background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
  boxShadow: active ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12,
  color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
});
const ossGroupHead: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 4
};
const ossLink: CSSProperties = { color: 'var(--cth-ink-900)', textDecoration: 'underline', cursor: 'pointer' };

// One-click briefing templates — fill Description + Goal with a sharp, ready-to-run
// role so a user isn't staring at a blank field (item 7). The template BRIEFINGS
// stay English (they become agent prompts — see the i18n report); only the
// picker labels are translated.
const DESCRIPTION_TEMPLATES: { labelKey: string; description: string; goal: string }[] = [
  {
    labelKey: 'addAgent.templatesHint.repoJanitor.label',
    description: 'keeps the codebase tidy and healthy',
    goal: 'Continuously hunt for dead code, lint errors, flaky tests, and small safe refactors. Fix the safe ones and leave a note for anything risky. Never change behavior without flagging it.'
  },
  {
    labelKey: 'addAgent.templatesHint.docsWriter.label',
    description: 'keeps docs in sync with the code',
    goal: 'Watch for code changes that outdate the README and docs, then update them. Write for newcomers and prefer concrete examples over prose.'
  },
  {
    labelKey: 'addAgent.templatesHint.bugTriager.label',
    description: 'investigates and root-causes bugs',
    goal: 'For each reported issue: reproduce it, find the root cause, then propose a minimal fix with evidence. No fixes without a confirmed root cause.'
  },
  {
    labelKey: 'addAgent.templatesHint.researchAssistant.label',
    description: 'gathers and summarizes information',
    goal: 'Research the questions you are given across multiple sources, verify the key claims, and return a concise, cited summary.'
  },
  {
    labelKey: 'addAgent.templatesHint.releaseManager.label',
    description: 'prepares and ships releases',
    goal: 'Track what has shipped since the last release, update the changelog and version, and draft clear release notes.'
  }
];

// Copy-paste prompt the user hands to any AI to generate a hire manifest. It pins
// the exact JSON shape the importer accepts and ends with a fill-in section so the
// user adds their own details (item 7). Kept in sync with the HireManifest schema
// (src/shared/hire.ts) — provider allowlist is claude | codex | antigravity | cursor.
const HIRE_PROMPT = `You are designing a "hire" — a ready-to-spawn AI agent for The Hive, an app that runs a team of CLI coding agents. Output ONE JSON object (a hire manifest) and nothing else.

Make the agent genuinely useful: give it a sharp role, a concrete standing goal, and a description that makes it behave like an expert operator of its CLI engine (Claude Code, Codex, or Antigravity/Gemini). It should know how to use the terminal, read and edit files, run and inspect commands, lean on available skills and MCP tools, keep notes in memory, and work autonomously toward its goal without hand-holding.

Return EXACTLY this shape (omit optional fields you don't need; keep the spec string verbatim):

{
  "spec": "munder-difflin/hire@1",
  "name": "Jim",
  "description": "one-line role — what this agent is for",
  "goal": "standing directive injected on every prompt — specific and outcome-oriented",
  "provider": "claude",
  "model": "claude-opus-4-8[1m]",
  "capabilities": ["code-review", "docs"],
  "isolate": false,
  "tokenCap": 2000000,
  "author": "your name"
}

Rules:
- "provider" MUST be one of: cursor | claude | codex | antigravity. "model" must be a real model id for that provider (e.g. gpt-5.6-luna-high, claude-opus-4-8[1m], gpt-5-codex, "Gemini 3.1 Pro (High)").
- Do NOT include shell commands or any flags beyond these fields.
- Make "description" + "goal" concrete enough that the agent knows exactly what to do on its first turn.

--- ADD YOUR DETAILS BELOW (the AI should use these) ---
Role / what I want this agent to do:
Preferred engine (claude / codex / antigravity), if any:
Repos, tools, style, or constraints to respect:
`;

// Hiring TEMPLATES (item 5): pre-wire a small, typical team in one click by
// enqueueing several HireManifests at once into the SAME human-review queue
// "Import hire" already drives (enqueuePendingHires / hireQueue below) — each
// teammate still goes through the normal one-at-a-time review-then-Spawn-or-
// Skip flow, exactly like a multi-file import. Nothing here can auto-spawn:
// queueing only pre-fills the form, same security model as an imported
// manifest (see hire.ts's doc comment). Provider/model are left unset so each
// teammate spawns on the user's own default engine rather than a hardcoded
// one. Briefings stay English for the same reason DESCRIPTION_TEMPLATES'
// do — they become agent prompts, not UI copy.
interface TeamTemplate {
  labelKey: string;
  descriptionKey: string;
  manifests: HireManifest[];
}

const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    labelKey: 'addAgent.teamTemplates.shipIt.label',
    descriptionKey: 'addAgent.teamTemplates.shipIt.description',
    manifests: [
      {
        spec: HIRE_SPEC_V1, name: 'Architect', character: 'dwight', accent: 'mint',
        description: 'designs the technical approach before code is written',
        goal: 'Design the technical approach before any code is written: read the existing codebase, propose a plan (files to touch, key decisions, risks), and write it to a short design note the implementer can follow. Do not write feature code yourself — hand the plan to the implementer once it is solid.'
      },
      {
        spec: HIRE_SPEC_V1, name: 'Implementer', character: 'jim', accent: 'sky',
        description: 'builds the feature end-to-end',
        goal: 'Take the architect’s design note and build the feature end-to-end: write the code, keep commits small and reviewable, and flag any place where the design note turns out to be wrong so the architect can adjust it. Do not merge without the reviewer’s sign-off.'
      },
      {
        spec: HIRE_SPEC_V1, name: 'Reviewer', character: 'angela', accent: 'coral',
        description: 'reviews every change for correctness and quality',
        goal: 'Review the implementer’s changes for correctness, edge cases, and adherence to the architect’s design: read the diff critically, run the tests, and leave concrete, actionable feedback. Approve only when you would be comfortable shipping it yourself.'
      }
    ]
  },
  {
    labelKey: 'addAgent.teamTemplates.docsQa.label',
    descriptionKey: 'addAgent.teamTemplates.docsQa.description',
    manifests: [
      {
        spec: HIRE_SPEC_V1, name: 'Writer', character: 'pam', accent: 'lemon',
        description: 'keeps user-facing docs accurate',
        goal: 'Keep user-facing docs (README, changelog, in-app copy) accurate and in sync with what the team ships. Read recent changes, update the relevant docs, and flag any feature that shipped without documentation.'
      },
      {
        spec: HIRE_SPEC_V1, name: 'QA', character: 'toby', accent: 'peach',
        description: 'tries to break what the team ships',
        goal: 'Try to break what the team ships: exercise edge cases, verify the test suite actually covers the new behavior, and file clear, reproducible bug reports for anything that does not hold up. Sign off only once you would trust it in front of a real user.'
      }
    ]
  }
];

// The Add Agent form has 11+ fields, so it's grouped into sections the user jumps
// between via a left sidebar index (one section shown at a time). Engine carries
// Command (it's the spawn command assembled from provider+model+flags); Workspace
// clusters Folder + Git isolation + Resume (all "where/how it runs"). Capabilities
// isn't a field here — it rides an imported hire manifest (the pinned banner).
type SectionKey = 'identity' | 'workspace' | 'engine' | 'briefing';
const SECTIONS: { key: SectionKey; labelKey: string; hintKey: string }[] = [
  { key: 'identity',  labelKey: 'addAgent.sections.identity.label',  hintKey: 'addAgent.sections.identity.hint' },
  { key: 'workspace', labelKey: 'addAgent.sections.workspace.label', hintKey: 'addAgent.sections.workspace.hint' },
  { key: 'engine',    labelKey: 'addAgent.sections.engine.label',    hintKey: 'addAgent.sections.engine.hint' },
  { key: 'briefing',  labelKey: 'addAgent.sections.briefing.label',  hintKey: 'addAgent.sections.briefing.hint' }
];

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function uniqueId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
}

export interface AddAgentModalProps {
  onClose: () => void;
  config: HarnessConfig;
  /** Lift config changes (e.g. a project registered from this modal) back up to
   *  App so the rest of the UI — and the next time this modal opens — sees them. */
  onConfigChange?: (config: HarnessConfig) => void;
}

export function AddAgentModal({ onClose, config, onConfigChange }: AddAgentModalProps) {
  const { t: tr } = useTranslation();
  const rtl = useRtl();
  const addAgent = useStore(s => s.addAgent);
  // Deep links and file batches share one FIFO. The head alone seeds the form;
  // every item still requires an explicit spawn or skip.
  const hireQueue = useStore(s => s.hireQueue);
  const enqueuePendingHires = useStore(s => s.enqueuePendingHires);
  const finishPendingHire = useStore(s => s.finishPendingHire);
  const pendingHire = hireQueue.pending[0];
  const reviewProgress = hireQueueProgress(hireQueue);

  const knownCharacter = (c?: string): OfficeCharacterName =>
    (OFFICE_CAST.some(m => m.name === c) ? (c as OfficeCharacterName) : DEFAULT_CHARACTER);
  const knownAccent = (a?: string): AccentColorName =>
    (ACCENTS.includes(a as AccentColorName) ? (a as AccentColorName) : 'sky');
  /** The cast member a typed name refers to, if any.
   *
   *  The character tiles already set the name (clicking Meredith names the agent
   *  Meredith), but the coupling ran ONE WAY, so typing "Meredith" left the
   *  avatar on whatever was selected, in practice the Jim default. Same missing
   *  default as issue #191 from the other direction, where a manifest that omits
   *  `character` always lands on Jim.
   *
   *  Returns null on no match, and the caller leaves the avatar alone, so a
   *  deliberate pick is never overwritten by continuing to type. */
  const characterForName = (n: string): OfficeCharacterName | null => {
    const q = n.trim().toLowerCase();
    if (!q) return null;
    const hit = OFFICE_CAST.find(c => c.displayName.toLowerCase() === q || c.name === q);
    return hit ? hit.name : null;
  };
  /** The locally-built spawn command for a manifest: provider preset + model
   *  from the LOCAL config builder, with the manifest's validated flags
   *  appended. A manifest can never name the binary itself. */
  const hireCommand = (m: HireManifest): string => {
    const prov: AgentProvider = m.provider ?? inferAgentProvider(config.defaultCommand);
    const base = buildSpawnCommand(config, m.model, prov);
    return m.commandFlags?.length ? `${base} ${m.commandFlags.join(' ')}` : base;
  };

  // Default provider follows whatever the global default command is (claude
  // unless the user reconfigured it); the model only carries over for Claude.
  const initialProvider = inferAgentProvider(config.defaultCommand);
  const initialModel = isClaudeProvider(initialProvider) ? config.defaultModel : undefined;

  const [name, setName] = useState(pendingHire?.name ?? 'Jim');
  // Plain string: either a fixed OfficeCharacterName (the 15-tile grid below)
  // or a custom character id (custom:<uuid>) from the "+ Create character"
  // builder. A hire manifest only ever names a fixed character, so knownCharacter
  // (used to seed/validate this from a manifest) still returns the narrow type.
  const [character, setCharacter] = useState<string>(knownCharacter(pendingHire?.character));
  const [showCharacterBuilder, setShowCharacterBuilder] = useState(false);
  const customCharacters = useCustomCharacters();
  const [accent, setAccent] = useState<AccentColorName>(knownAccent(pendingHire?.accent));
  const [cwd, setCwd] = useState<string>(config.registeredRepos[0] ?? '');
  // Local mirror of the registered projects so one added from here shows as a
  // quick-pick immediately (the `config` prop is a snapshot taken at open time).
  const [repos, setRepos] = useState<string[]>(config.registeredRepos);
  // ── Where does this agent run? (Phase 3b) ──────────────────────────────────
  // '' = this machine, which is the default and preserves every existing
  // behaviour exactly. Anything else is a PAIRED REMOTE ENVIRONMENT: the agent's
  // PTY is spawned by the daemon on that machine, so `cwd` stops meaning "a
  // folder on this computer" and the local folder picker is withdrawn.
  const [remoteEnvs, setRemoteEnvs] = useState<RemoteEnvironment[]>([]);
  const [remoteEnvId, setRemoteEnvId] = useState<string>('');
  const remoteEnv = remoteEnvs.find((e) => e.id === remoteEnvId);
  const isRemote = !!remoteEnv;
  // The inline pairing form (shown only when the user asks for it).
  const [showPairForm, setShowPairForm] = useState(false);
  const [pairName, setPairName] = useState('');
  const [pairHost, setPairHost] = useState('');
  const [pairPort, setPairPort] = useState('8722');
  const [pairCode, setPairCode] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | undefined>();
  const [provider, setProvider] = useState<AgentProvider>(pendingHire?.provider ?? initialProvider);
  const [model, setModel] = useState<string | undefined>(
    pendingHire ? pendingHire.model : initialModel
  );
  const [command, setCommand] = useState(
    pendingHire ? hireCommand(pendingHire) : buildSpawnCommand(config, initialModel, initialProvider)
  );
  const [description, setDescription] = useState(pendingHire?.description ?? 'a fresh harness');
  const [hireMeta, setHireMeta] = useState<HireManifest | null>(pendingHire);

  // Picking a model rebuilds the command; the command field stays editable for
  // power users (it's the source of truth for the actual spawn).
  const pickModel = (id?: string) => {
    setModel(id);
    setCommand(buildSpawnCommand(config, id, provider));
  };
  // Switching provider resets the model to that CLI's default and rebuilds the
  // command from the provider's preset binary (so Antigravity spawns `agy` and
  // Codex spawns `codex`, not the configured `claude`). For 'custom' we keep the
  // user's typed command rather than blanking it.
  const pickProvider = (id: AgentProvider) => {
    setProvider(id);
    // Seed the model: Claude from the global defaultModel; other engines from the
    // per-engine default set in Settings → AI Engines (providerDefaultModels), else
    // the CLI default. This is what makes that Settings field live (Dwight NIT-1).
    const nextModel = isClaudeProvider(id) ? config.defaultModel : config.providerDefaultModels?.[id];
    setModel(nextModel);
    const nextPreset = providerPreset(id);
    if (!isClaudeProvider(id) && !nextPreset.resumeFlag && !nextPreset.resumeSubcommand) {
      setResumeSessionId('');
      setFolderNote(undefined);
    }
    if (id === 'custom') {
      setCommand(command.trim() || config.defaultCommand || '');
      return;
    }
    setCommand(buildSpawnCommand(config, nextModel, id));
  };
  const preset = providerPreset(provider);
  const [goal, setGoal] = useState(pendingHire?.goal ?? '');
  const [isolate, setIsolate] = useState(pendingHire?.isolate ?? false);
  // Opt out of this app's hive for an agent an EXTERNAL orchestrator (e.g. Hermes)
  // already manages: it owns that identity's memory, task assignment and message
  // routing, so provisioning our own memory.md + inbox/outbox for the same agent
  // would duplicate and fight it. Checked ⇒ `submit()` omits the `hive` key from
  // the spawn payload entirely (see there). Default OFF — unchanged for everyone
  // who never touches this.
  const [externalHive, setExternalHive] = useState(false);
  // #2 — optional Claude session id to continue. When set, the spawn seeds that
  // session's transcript into the cwd's project dir and launches `--resume`.
  const [resumeSessionId, setResumeSessionId] = useState('');
  const resuming = resumeSessionId.trim().length > 0;
  // Note shown when the folder was auto-filled from the pasted session id.
  const [folderNote, setFolderNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // Which config section the left sidebar index is showing.
  const [section, setSection] = useState<SectionKey>('identity');
  // "Generate a hire with AI" helper — reveals a copy-paste prompt (item 7).
  const [showHirePrompt, setShowHirePrompt] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [showTeamTemplates, setShowTeamTemplates] = useState(false);
  const copyHirePrompt = async () => {
    try {
      await navigator.clipboard.writeText(HIRE_PROMPT);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1500);
    } catch { /* clipboard blocked — the textarea below is selectable as a fallback */ }
  };

  // Close only the modal on Esc. Capture prevents the fullscreen terminal's
  // window-level handler from also closing the view underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Load the paired remote environments once, when the modal opens. A failure
  // (or a build with nothing paired) simply leaves the list empty, and the
  // "Where does this run?" picker degrades to the local-only default.
  useEffect(() => {
    let alive = true;
    void window.cth.remoteList()
      .then((envs) => { if (alive) setRemoteEnvs(Array.isArray(envs) ? envs : []); })
      .catch(() => { /* older main process / nothing paired — stay local */ });
    return () => { alive = false; };
  }, []);

  /** Run the one-time pairing handshake against a daemon the user just started.
   *  The secret never reaches this process: main stores it encrypted and hands
   *  back metadata only. On success the environment is selected immediately. */
  const pairRemote = async () => {
    setPairError(undefined);
    const host = pairHost.trim();
    const port = Number(pairPort.trim());
    const code = pairCode.trim();
    const name = pairName.trim() || host;
    if (!host || !code || !Number.isInteger(port) || port < 1 || port > 65535) {
      setPairError(tr('addAgent.errPairFields'));
      return;
    }
    setPairBusy(true);
    try {
      const res = await window.cth.remotePair({ host, port, code, name });
      if (!res.ok) { setPairError(res.error); return; }
      setRemoteEnvs((prev) => [...prev.filter((e) => e.id !== res.environment.id), res.environment]);
      setRemoteEnvId(res.environment.id);
      setShowPairForm(false);
      setPairCode('');
    } catch (e) {
      setPairError(e instanceof Error ? e.message : String(e));
    } finally {
      setPairBusy(false);
    }
  };

  /** Forget a paired machine (and its stored secret). Nothing on that machine is
   *  touched — this only drops our ability to talk to it. */
  const unpairRemote = async (id: string) => {
    try { await window.cth.remoteRemove(id); } catch { /* best-effort */ }
    setRemoteEnvs((prev) => prev.filter((e) => e.id !== id));
    if (remoteEnvId === id) setRemoteEnvId('');
  };

  // Zero-step resume: when a session id is entered, look up the cwd it originally
  // ran in (from the transcript) and pre-fill the Folder so the user doesn't have
  // to find the worktree. They can still override the folder afterwards. Runs on
  // blur so we don't hit the resolver on every keystroke.
  const resolveFolderFromSession = async () => {
    const sid = resumeSessionId.trim();
    if (!sid) { setFolderNote(undefined); return; }
    const resolved = await window.cth.resolveSessionCwd(sid);
    if (resolved) { setCwd(resolved); setFolderNote(tr('addAgent.folderFromSession', { path: resolved })); }
    else setFolderNote(undefined);
  };

  const pickFolder = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setCwd(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  /** Register `path` as a project (folder quick-pick) right now: dedupe-prepend,
   *  select it, persist to config, and lift the change up so it sticks. */
  const registerProject = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    const next = [p, ...repos.filter((r) => r !== p)];
    setRepos(next);
    setCwd(p);
    try {
      const updated = await window.cth.updateConfig({ registeredRepos: next });
      // Main expands `~` when it persists registeredRepos, so adopt the stored
      // (absolute) list — otherwise a typed "~/dev/foo" stays literal in this
      // modal's state and rides along into the spawn.
      const stored = updated.registeredRepos ?? next;
      setRepos(stored);
      if (stored[0]) setCwd(stored[0]);
      onConfigChange?.(updated);
    } catch { /* best-effort persist */ }
  };

  /** Drop `path` from the project quick-picks.
   *
   *  Removes it from the LISTING only. The folder on disk is never touched, which
   *  is the whole point: a project you are done with should stop cluttering the
   *  picker without anything being deleted. */
  const unregisterProject = async (path: string) => {
    const next = repos.filter((r) => r !== path);
    setRepos(next);
    try {
      const updated = await window.cth.updateConfig({ registeredRepos: next });
      setRepos(updated.registeredRepos ?? next);
      onConfigChange?.(updated);
    } catch { /* best-effort persist */ }
  };

  /** Pick a brand-new folder and register it as a project in one step. */
  const addProject = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) await registerProject(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  /** Apply an imported manifest to every form field (file import path). The
   *  command is rebuilt locally from the provider preset + validated flags — a
   *  manifest can never inject the spawn binary. Import never spawns. */
  const applyManifest = (m: HireManifest) => {
    setHireMeta(m);
    setName(m.name);
    // A manifest that names an agent but omits `character` should get the
    // matching avatar rather than the Jim default (issue #191).
    setCharacter(m.character ? knownCharacter(m.character) : (characterForName(m.name ?? '') ?? knownCharacter(undefined)));
    setAccent(knownAccent(m.accent));
    setProvider(m.provider ?? initialProvider);
    setModel(m.model);
    setCommand(hireCommand(m));
    setDescription(m.description ?? 'a fresh harness');
    setGoal(m.goal ?? '');
    setIsolate(m.isolate ?? false);
    // Not a manifest field — reset so a toggle flipped while reviewing one hire
    // in a batch cannot leak into the next one.
    setExternalHive(false);
    // Same reasoning: a hire manifest never names a machine, so each hire in a
    // batch starts back on "this machine".
    setRemoteEnvId('');
    setResumeSessionId('');
    setFolderNote(undefined);
    setSection('identity');
  };

  // Advancing a batch keeps this modal mounted. Re-seed every form field when
  // the queue head changes so edits made while reviewing one hire cannot leak
  // into the next.
  useLayoutEffect(() => {
    if (pendingHire) applyManifest(pendingHire);
  // applyManifest intentionally closes over the config snapshot used by this
  // open modal; queue advances do not replace that snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHire]);

  const advanceHireReview = () => {
    const next = hireQueue.pending[1];
    // The pendingHire effect re-seeds every form field from the new queue head.
    finishPendingHire();
    if (!next) onClose();
  };

  const importHire = async () => {
    setError(undefined);
    const res = await window.cth.importHireFiles();
    if (res.manifests.length > 0) enqueuePendingHires(res.manifests);
    if (res.errors.length > 0) {
      const noun = res.errors.length === 1 ? 'file' : 'files';
      setError(`Skipped ${res.errors.length} invalid ${noun}: ${res.errors.join(' · ')}`);
    } else if (!res.ok && res.error && res.error !== 'cancelled') {
      setError(res.error);
    }
  };

  const skipHire = () => {
    if (!pendingHire) return;
    setError(undefined);
    advanceHireReview();
  };

  /** Queue a whole team template at once — same queue, same one-at-a-time
   *  review below (applyManifest re-seeds the form from `pendingHire`); this
   *  just seeds several manifests instead of one imported file. */
  const hireTeam = (manifests: HireManifest[]) => {
    setError(undefined);
    enqueuePendingHires(manifests);
    setShowTeamTemplates(false);
  };

  const submit = async () => {
    setError(undefined);
    // A required field can live in a section the user hasn't opened, so jump to
    // the offending section as we surface the error — the field is never hidden.
    if (!name.trim()) { setError(tr('addAgent.errName')); setSection('identity'); return; }
    if (!cwd) { setError(tr('addAgent.errFolder')); setSection('workspace'); return; }
    if (!command.trim()) { setError(tr('addAgent.errCommand')); setSection('engine'); return; }

    setBusy(true);
    const id = uniqueId(name);
    const ptyId = `pty-${id}`;
    // Split the editable command field into argv-style pieces for node-pty.
    // Quote-aware so an agy model label like "Gemini 3.1 Pro (High)" — or any
    // auto-mode flags appended to the command — stays one argument.
    const [exe, ...args] = tokenizeCommand(command.trim());
    const spawnRes = await window.cth.spawnPty({
      id: ptyId,
      cwd,
      command: exe,
      provider,
      args,
      cols: 100,
      rows: 30,
      // Run this agent on a paired remote machine instead of here. Undefined for
      // the local default, so the payload is byte-identical to what it has
      // always been unless the user explicitly picked an environment.
      remoteEnvironmentId: remoteEnvId || undefined,
      // When set, the main process spawns this agent in its own git worktree.
      // Forced OFF when resuming a session — `--resume` needs the real cwd's
      // transcript, not a fresh worktree with a different (empty) project dir.
      // Also off for a remote agent: worktrees are a LOCAL git operation on a
      // LOCAL checkout, and there is neither on the other machine.
      isolate: (resuming || isRemote) ? false : isolate,
      // #2 — continue an existing Claude session in this agent's cwd.
      resumeSessionId: resuming ? resumeSessionId.trim() : undefined,
      // Provision this agent in the hive (memory + mailbox + identity/protocol).
      //
      // Externally managed agents opt out via a CONDITIONAL SPREAD, so the `hive`
      // key is genuinely absent from the payload rather than present-and-undefined.
      // Main gates provisioning on `if (opts.hive && hive.enabled())`, and its
      // router only ever walks agents that have a hive/agents/<id>/ folder — which
      // only ensureAgent() creates — so an agent spawned without `hive` is never
      // given local memory/mailbox and stays invisible to GOD routing.
      //
      // A REMOTE agent takes the same opt-out for a harder reason: the hive is
      // files on THIS disk (memory.md, inbox/outbox), and a CLI running on
      // another machine cannot read them, so provisioning one would create a
      // mailbox nobody ever reads. Cross-machine hive is out of scope for 3b.
      ...((externalHive || isRemote) ? {} : {
        hive: {
          id,
          name: name.trim(),
          provider,
          cwd,
          role: description.trim() || undefined,
          // A hire manifest may carry validated capability tags (routing hints).
          capabilities: hireMeta?.capabilities
        }
      })
    });
    if (!spawnRes.ok) {
      setBusy(false);
      setError(spawnRes.error ?? 'spawn failed');
      return;
    }
    // #2 — the requested resume session id wasn't found anywhere; main fell back
    // to a fresh session. Don't block the spawn, but make it visible.
    if (resuming && spawnRes.resumeNotFound) {
      console.warn(`[add-agent] resume session "${resumeSessionId.trim()}" not found — started a fresh session`);
    }

    // Main expands `~` at ingestion and echoes back the absolute path it actually
    // spawned into — record THAT, so this agent's cwd matches the hive registry
    // (and survives a restart, where nothing re-expands it).
    const spawnedCwd = spawnRes.cwd || cwd;
    // With git isolation the agent RUNS in its own worktree, but its PROJECT is
    // still the folder the user picked. Labelling the agent with the worktree's
    // name was the visible half; the damaging half was promoting that worktree
    // into registeredRepos below, which turned the project quick-picks into a
    // list of throwaway worktrees. Mirrors the `isolate` sent to main, which is
    // forced off while resuming.
    const projectCwd = (!resuming && isolate) ? cwd.trim() : spawnedCwd;
    const agent: Agent = {
      id,
      name: name.trim(),
      character,
      accent,
      description: description.trim() || 'a fresh harness',
      project: basename(projectCwd),
      tmuxTarget: '',
      cwd: spawnedCwd,
      goal: goal.trim() || undefined,
      status: 'idle',
      action: resuming && spawnRes.resumeNotFound ? 'session not found — fresh start' : 'starting up',
      progress: 0,
      currentStation: 'desk',
      ptyId,
      command: command.trim(),
      provider,
      model,
      // Persist the resolved worktree path (set only when isolation provisioned
      // one) so a restart can re-enter this exact worktree — see restoreTeam.
      worktreePath: spawnRes.worktreePath,
      // …and the machine it runs on, for the same reason: a restore must send it
      // back to the same daemon, not spawn it here against a path that is not here.
      remoteEnvironmentId: remoteEnvId || undefined,
      // Crush (seedDelivery:'type-into-tui') hands its hive protocol back here
      // instead of on argv; useHive types it into the TUI after boot. (ondev-b)
      seedPrompt: spawnRes.seedPrompt,
      recentTextTs: Date.now()
    };
    addAgent(agent);
    // Remember the folder for the next hire: promote it to the front of the
    // registeredRepos quick-picks (the modal's default cwd) so back-to-back
    // hires land in the same project without re-picking.
    // …but a REMOTE path is a folder on another computer. registeredRepos is the
    // local project quick-pick list (and main tilde-expands it against THIS
    // home), so promoting one there would poison the picker with paths that do
    // not exist here.
    if (!isRemote && projectCwd && repos[0] !== projectCwd) {
      const nextRepos = [projectCwd, ...repos.filter((r) => r !== projectCwd && r !== cwd)];
      try {
        const updated = await window.cth.updateConfig({ registeredRepos: nextRepos });
        onConfigChange?.(updated);
      } catch { /* best-effort */ }
    }
    // A hire manifest may carry a per-agent token budget — apply it to the
    // latest agentTokenCaps map in main. Await it before advancing a batch: the
    // next hire reuses this mounted modal and must not race a stale config write.
    if (hireMeta?.tokenCap) {
      try {
        const updated = await window.cth.setAgentTokenCap(id, hireMeta.tokenCap);
        onConfigChange?.(updated);
      } catch { /* best-effort */ }
    }
    setBusy(false);
    if (pendingHire) {
      advanceHireReview();
    } else {
      onClose();
    }
  };

  return (
    // Must sit above fullscreen terminal/file overlays (250/280) and their
    // hover popovers. The fullscreen Add Agent button uses this same modal.
    // zIndex/backdrop match the pre-migration hand-rolled wrapper exactly
    // (500 / 0.6 alpha) — same box as EditAgentModal (940 / 95vw / 86vh),
    // the two halves of one job.
    <PixelModal
      onClose={onClose}
      title={tr('addAgent.title')}
      width={940}
      maxWidth="95vw"
      zIndex={500}
      backdropColor="rgba(26, 19, 32, 0.6)"
      noPadding
      panelStyle={{ padding: 16 }}
    >
          {/* Sectioned config with a left sidebar index. The form has 11+ fields,
              so they're grouped into 4 sections (Identity / Workspace / Engine /
              Briefing) shown one at a time; the sidebar jumps between them. The
              hire-import review banner, the error, and the footer stay pinned
              around the section pane. maxHeight keeps the dialog within the
              viewport (title bar stays pinned). */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, maxHeight: '86vh', overflowY: 'auto' }}>
            {hireMeta && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-lemon-light, #fdf3cf)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontSize: 12,
                color: 'var(--cth-ink-900)',
                display: 'flex', flexDirection: 'column', gap: 2
              }}>
                <span>
                  📋 {tr('addAgent.hireImported')} <strong>{hireMeta.name}</strong>
                  {hireMeta.author ? <> · {tr('addAgent.byAuthor', { author: hireMeta.author })}</> : null}
                  {reviewProgress ? <> · {tr('addAgent.hireProgress', { current: reviewProgress.current, total: reviewProgress.total })}</> : null}
                </span>
                <span>{tr('addAgent.reviewFields')}</span>
                {hireMeta.commandFlags && hireMeta.commandFlags.length > 0 && (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ fontSize: 12 }}>{tr('addAgent.hireFlags')}</span>
                    {hireMeta.commandFlags.map((f, i) => (
                      <code
                        key={`${f}-${i}`}
                        style={{
                          fontFamily: 'var(--cth-font-mono)',
                          fontSize: 12,
                          padding: '0 4px',
                          background: 'var(--cth-paprika-light, #f6d3c4)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-paprika-700, #b3502e)',
                          color: 'var(--cth-ink-900)'
                        }}
                      >
                        {f}
                      </code>
                    ))}
                  </span>
                )}
                {hireMeta.skills && hireMeta.skills.length > 0 && (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ fontSize: 12 }}>{tr('addAgent.hireSkills')}</span>
                    {hireMeta.skills.map((s) => (
                      <code
                        key={s}
                        style={{
                          fontFamily: 'var(--cth-font-mono)',
                          fontSize: 12,
                          padding: '0 4px',
                          background: 'var(--cth-mint-light, #d0f0e0)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-mint-700, #1f7a4d)',
                          color: 'var(--cth-ink-900)'
                        }}
                      >
                        {s}
                      </code>
                    ))}
                  </span>
                )}
                {hireMeta.mcpServers && hireMeta.mcpServers.length > 0 && (() => {
                  const safe = hireMeta.mcpServers!.filter(
                    (id) => MCP_CATALOG.find((e) => e.id === id)?.tier === 'safe-readonly'
                  );
                  const consent = hireMeta.mcpServers!.filter(
                    (id) => MCP_CATALOG.find((e) => e.id === id)?.tier !== 'safe-readonly'
                  );
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
                      {safe.length > 0 && (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12 }}>{tr('addAgent.mcpSafe')}:</span>
                          {safe.map((id) => (
                            <code key={id} style={{
                              fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '0 4px',
                              background: 'var(--cth-sky-light, #d0e8f8)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-sky-700, #1f5a8a)',
                              color: 'var(--cth-ink-900)'
                            }}>{id}</code>
                          ))}
                        </span>
                      )}
                      {consent.length > 0 && (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12 }}>{tr('addAgent.mcpConsent')}:</span>
                          {consent.map((id) => (
                            <code key={id} style={{
                              fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '0 4px',
                              background: 'var(--cth-paprika-light, #f6d3c4)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-paprika-700, #b3502e)',
                              color: 'var(--cth-ink-900)'
                            }}>{id}</code>
                          ))}
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>
                            {tr('addAgent.mcpEnableInSettings')}
                          </span>
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* sidebar index + the active section's fields */}
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {/* LEFT — section index. Capabilities isn't a nav item: it isn't a
                  user field, it rides the imported hire manifest (banner above). */}
              <nav style={{ width: 168, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {SECTIONS.map((s, i) => {
                  const active = section === s.key;
                  return (
                    <button
                      key={s.key}
                      onClick={() => setSection(s.key)}
                      style={{
                        textAlign: 'left', padding: '6px 9px 5px', border: 'none', cursor: 'pointer',
                        background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: active
                          ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                          : 'inset 0 0 0 1px var(--cth-ink-100)',
                        display: 'flex', flexDirection: 'column', gap: 1
                      }}
                    >
                      <span style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '13px',
                        color: 'var(--cth-ink-900)', textTransform: 'uppercase',
                        display: 'flex', alignItems: 'baseline', gap: 6
                      }}>
                        <span style={{ color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)' }}>{i + 1}</span>
                        {tr(s.labelKey)}
                      </span>
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                        {tr(s.hintKey)}
                      </span>
                    </button>
                  );
                })}
              </nav>

              {/* RIGHT — the active section's fields */}
              <div style={{ flex: 1, minWidth: 0, minHeight: 260, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {section === 'identity' && (
                  <>
                    <Row label={tr('addAgent.name')}>
                      <input
                        value={name}
                        onChange={(e) => {
                          const next = e.target.value;
                          setName(next);
                          const match = characterForName(next);
                          if (match) setCharacter(match);
                        }}
                        placeholder={tr('addAgent.namePlaceholder')}
                        style={inputStyle}
                      />
                    </Row>

                    <Row label={tr('addAgent.character')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {OFFICE_CAST.map(c => (
                          <button
                            key={c.name}
                            onClick={() => { setCharacter(c.name); setName(c.displayName); }}
                            title={c.blurb}
                            style={{
                              padding: 4,
                              background: character === c.name ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                              boxShadow: character === c.name
                                ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                : 'inset 0 0 0 1px var(--cth-ink-100)',
                              cursor: 'pointer',
                              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                              border: 'none', width: 56
                            }}
                          >
                            <div style={{ width: 44, height: 56, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden' }}>
                              <SpritePortrait character={c.name} scale={2} />
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{c.displayName}</span>
                          </button>
                        ))}
                        {customCharacters.map(c => (
                          <button
                            key={c.id}
                            onClick={() => { setCharacter(c.id); setName(c.displayName); }}
                            title={c.displayName}
                            style={{
                              padding: 4,
                              background: character === c.id ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                              boxShadow: character === c.id
                                ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                : 'inset 0 0 0 1px var(--cth-ink-100)',
                              cursor: 'pointer',
                              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                              border: 'none', width: 56
                            }}
                          >
                            <div style={{ width: 44, height: 56, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden' }}>
                              <SpritePortrait character={c.id} scale={2} />
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--cth-ink-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 56 }}>
                              {c.displayName}
                            </span>
                          </button>
                        ))}
                        <button
                          onClick={() => setShowCharacterBuilder(true)}
                          title={tr('addAgent.createCharacterTitle')}
                          style={{
                            padding: 4,
                            background: 'var(--cth-cream-100)',
                            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                            cursor: 'pointer',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
                            border: 'none', width: 56, height: 76
                          }}
                        >
                          <Icon name="plus" />
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-700)', textAlign: 'center', lineHeight: '13px' }}>
                            {tr('addAgent.createCharacter')}
                          </span>
                        </button>
                      </div>
                    </Row>

                    {showCharacterBuilder && (
                      <CharacterBuilderModal
                        onClose={() => setShowCharacterBuilder(false)}
                        onCreate={(custom) => {
                          setCharacter(custom.id);
                          setName(custom.displayName);
                          setShowCharacterBuilder(false);
                        }}
                        defaultAccentHex={hexColor(accentByName[accent])}
                      />
                    )}

                    <Row label={tr('addAgent.color')}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {ACCENTS.map(a => (
                          <button
                            key={a}
                            onClick={() => setAccent(a)}
                            style={{
                              width: 32, height: 32,
                              background: `var(--cth-${a})`,
                              boxShadow: accent === a
                                ? 'inset 0 0 0 1.5px var(--cth-ink-500), 0 0 0 2px var(--cth-ink-900)'
                                : 'inset 0 0 0 1px var(--cth-ink-300)',
                              cursor: 'pointer',
                              border: 'none'
                            }}
                            aria-label={a}
                          />
                        ))}
                      </div>
                    </Row>
                  </>
                )}

                {section === 'workspace' && (
                  <>
                    {/* WHERE DOES THIS RUN? — local (default) or a paired remote
                        machine running the remote PTY daemon. Picking a remote
                        environment changes what every path below MEANS, so it
                        sits above the folder field rather than beside it. */}
                    <Row label={tr('addAgent.runsOn')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                          onClick={() => { setRemoteEnvId(''); setShowPairForm(false); }}
                          style={ossChip(!isRemote, accent)}
                        >
                          {tr('addAgent.runsOnLocal')}
                        </button>
                        {remoteEnvs.map((e) => (
                          <span
                            key={e.id}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'stretch',
                              background: remoteEnvId === e.id ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                              boxShadow: remoteEnvId === e.id
                                ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                : 'inset 0 0 0 1px var(--cth-ink-100)'
                            }}
                          >
                            <button
                              onClick={() => {
                                setRemoteEnvId(e.id);
                                setShowPairForm(false);
                                // Resume is local-only; drop a half-typed id so it
                                // cannot ride along into a remote spawn payload.
                                setResumeSessionId('');
                                setFolderNote(undefined);
                              }}
                              title={`${e.host}:${e.port}`}
                              style={{
                                padding: '3px 4px 1px 8px', background: 'transparent', border: 'none',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 12, cursor: 'pointer',
                                color: 'var(--cth-ink-900)'
                              }}
                            >
                              {e.name}
                            </button>
                            <button
                              onClick={() => unpairRemote(e.id)}
                              title={tr('addAgent.unpairRemote', { name: e.name })}
                              aria-label={tr('addAgent.unpairRemote', { name: e.name })}
                              style={{
                                padding: '3px 6px 1px 2px', background: 'transparent', border: 'none',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: 1,
                                color: 'var(--cth-ink-500)', cursor: 'pointer'
                              }}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <button
                          onClick={() => { setShowPairForm((v) => !v); setPairError(undefined); }}
                          style={ossChip(showPairForm, accent)}
                        >
                          {tr('addAgent.pairRemote')}
                        </button>
                      </div>

                      {showPairForm && (
                        <div style={{
                          marginTop: 8, padding: '8px 10px',
                          background: 'var(--cth-cream-100)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                          display: 'flex', flexDirection: 'column', gap: 6
                        }}>
                          <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '16px' }}>
                            {tr('addAgent.pairHint')}
                          </span>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <input
                              value={pairName}
                              onChange={(ev) => setPairName(ev.target.value)}
                              placeholder={tr('addAgent.pairNamePlaceholder')}
                              aria-label={tr('addAgent.pairName')}
                              style={{ ...inputStyle, flex: '1 1 140px', fontSize: 13 }}
                            />
                            <input
                              value={pairHost}
                              onChange={(ev) => setPairHost(ev.target.value)}
                              placeholder={tr('addAgent.pairHostPlaceholder')}
                              aria-label={tr('addAgent.pairHost')}
                              style={{ ...inputStyle, flex: '2 1 180px', fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                            />
                            <input
                              value={pairPort}
                              onChange={(ev) => setPairPort(ev.target.value)}
                              placeholder="8722"
                              aria-label={tr('addAgent.pairPort')}
                              style={{ ...inputStyle, flex: '0 0 80px', fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                            />
                            <input
                              value={pairCode}
                              onChange={(ev) => setPairCode(ev.target.value.toUpperCase())}
                              placeholder={tr('addAgent.pairCodePlaceholder')}
                              aria-label={tr('addAgent.pairCode')}
                              style={{ ...inputStyle, flex: '0 0 110px', fontFamily: 'var(--cth-font-mono)', fontSize: 13, letterSpacing: 1 }}
                            />
                          </div>
                          {pairError && (
                            <span style={{ fontSize: 12, color: 'var(--cth-coral, var(--cth-ink-900))' }}>{pairError}</span>
                          )}
                          <div style={{ display: 'flex', gap: 6 }}>
                            <PixelButton variant="primary" size="sm" onClick={pairRemote} disabled={pairBusy}>
                              {pairBusy ? tr('addAgent.pairing') : tr('addAgent.pairSubmit')}
                            </PixelButton>
                            <PixelButton variant="ghost" size="sm" onClick={() => setShowPairForm(false)} disabled={pairBusy}>
                              {tr('common.cancel')}
                            </PixelButton>
                          </div>
                        </div>
                      )}

                      {remoteEnv && (
                        <span style={{ marginTop: 6, fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>
                          {tr('addAgent.runsOnRemoteHint', { name: remoteEnv.name, host: remoteEnv.host, port: remoteEnv.port })}
                        </span>
                      )}
                    </Row>

                    {/* A remote agent's folder is a path on THAT machine, so the
                        local project quick-picks and the folder dialog (which
                        browses this computer) are withdrawn — they would only
                        ever produce a path the daemon cannot open. */}
                    {isRemote ? (
                      <Row label={tr('addAgent.remotePath')}>
                        <input
                          value={cwd}
                          onChange={(e) => setCwd(e.target.value)}
                          placeholder={tr('addAgent.remotePathPlaceholder')}
                          style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                        />
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)' }}>
                          {tr('addAgent.remoteNoBrowse')}
                        </span>
                      </Row>
                    ) : (
                    <Row label={tr('addAgent.project')}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                          {repos.length > 0 ? tr('addAgent.pickProject') : tr('addAgent.noProjects')}
                        </span>
                        <button
                          onClick={addProject}
                          title={tr('addAgent.addProjectTitle')}
                          style={{
                            flexShrink: 0, padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                            background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                            display: 'inline-flex', alignItems: 'center', gap: 4
                          }}
                        >
                          <Icon name="plus" /> {tr('addAgent.addProject')}
                        </button>
                      </div>
                      {repos.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                          {repos.map((r) => (
                            /* Two buttons per chip: pick the project, or drop it
                               from this list. Nested in a span rather than one
                               button so the remove control is not a button inside
                               a button. */
                            <span
                              key={r}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'stretch',
                                background: cwd === r ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: cwd === r
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)'
                              }}
                            >
                              <button
                                onClick={() => setCwd(r)}
                                title={r}
                                style={{
                                  padding: '3px 4px 1px 8px',
                                  background: 'transparent',
                                  fontFamily: 'var(--cth-font-ui)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  border: 'none'
                                }}
                              >
                                {basename(r)}
                              </button>
                              <button
                                onClick={() => unregisterProject(r)}
                                title={`Remove ${basename(r)} from this list. The folder itself is left alone.`}
                                aria-label={`Remove ${basename(r)} from the project list`}
                                style={{
                                  padding: '3px 6px 1px 2px',
                                  background: 'transparent',
                                  fontFamily: 'var(--cth-font-ui)',
                                  fontSize: 12,
                                  lineHeight: 1,
                                  color: 'var(--cth-ink-500)',
                                  cursor: 'pointer',
                                  border: 'none'
                                }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          value={cwd}
                          onChange={(e) => setCwd(e.target.value)}
                          placeholder={tr('addAgent.projectPlaceholder')}
                          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                        />
                        <PixelButton variant="secondary" size="md" onClick={pickFolder}>
                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <Icon name="folder" /> {tr('addAgent.pick')}
                          </span>
                        </PixelButton>
                      </div>
                      {cwd.trim() && !repos.includes(cwd.trim()) && (
                        <button
                          onClick={() => registerProject(cwd)}
                          title={tr('addAgent.saveAsProjectTitle')}
                          style={{
                            alignSelf: 'flex-start', marginTop: 2,
                            padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                            background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                            display: 'inline-flex', alignItems: 'center', gap: 4
                          }}
                        >
                          <Icon name="plus" /> {tr('addAgent.saveAsProject')}
                        </button>
                      )}
                    </Row>
                    )}

                    {/* Git isolation and session resume are both operations on a
                        checkout that lives on THIS disk, so they are disabled
                        (not hidden — the reason should stay visible) while a
                        remote environment is selected. */}
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: (resuming || isRemote) ? 'not-allowed' : 'pointer', opacity: (resuming || isRemote) ? 0.5 : 1 }}>
                      <input
                        type="checkbox"
                        checked={(resuming || isRemote) ? false : isolate}
                        disabled={resuming || isRemote}
                        onChange={(e) => setIsolate(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: (resuming || isRemote) ? 'not-allowed' : 'pointer' }}
                      />
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)' }}>
                        {tr('addAgent.gitIsolation')}
                      </span>
                    </label>

                    {/* Hand memory + message routing to an external orchestrator
                        (Hermes and friends) instead of provisioning our own hive
                        for the same identity. The hover text spells out what it
                        turns off. */}
                    <label
                      title={tr('addAgent.externalHiveTitle')}
                      style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={externalHive}
                        onChange={(e) => setExternalHive(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: 'pointer' }}
                      />
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)' }}>
                        {tr('addAgent.externalHive')}
                      </span>
                    </label>

                    {/* Resume reads a transcript off THIS machine's disk and seeds
                        it into the target project dir, so it has no meaning for a
                        PTY on another computer. */}
                    {!isRemote && (
                    <Row label={tr('addAgent.resumeSession')}>
                      <input
                        value={resumeSessionId}
                        onChange={(e) => { setResumeSessionId(e.target.value); setFolderNote(undefined); }}
                        onBlur={resolveFolderFromSession}
                        placeholder={tr('addAgent.resumePlaceholder')}
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                      />
                      {folderNote && (
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-mint, var(--cth-ink-700))' }}>
                          {folderNote}
                        </span>
                      )}
                      {resuming && (
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>
                          {tr('addAgent.resumeNote')}
                        </span>
                      )}
                    </Row>
                    )}
                  </>
                )}

                {section === 'engine' && (
                  <>
                    <Row label={tr('addAgent.provider')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {AGENT_PROVIDER_PRESETS.map((p) => {
                          const active = provider === p.id;
                          return (
                            <button
                              key={p.id}
                              onClick={() => pickProvider(p.id)}
                              title={
                                p.id === 'antigravity'
                                  ? tr('addAgent.providerAntigravity')
                                  : p.id === 'codex'
                                    ? tr('addAgent.providerCodex')
                                    : p.id === 'custom'
                                      ? tr('addAgent.providerCustom')
                                      : p.label
                              }
                              style={{
                                padding: '3px 8px 1px',
                                background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: active
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none',
                                display: 'inline-flex', alignItems: 'center', gap: 6
                              }}
                            >
                              <ProviderLogo provider={p.id} size={14} />
                              {p.label}
                            </button>
                          );
                        })}
                      </div>
                    </Row>

                    {preset.supportsModel && <Row label={tr('addAgent.model')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(() => {
                          // An imported hire may name a model newer than this picker's
                          // hardcoded list (e.g. claude-fable-5). Surface it as a real,
                          // selected card instead of leaving the picker looking unset —
                          // the command field already carries it either way.
                          const known = modelsForProvider(provider);
                          return model && !known.some((m) => m.id === model)
                            ? [...known, { id: model, label: tr('addAgent.fromHire', { model }) }]
                            : known;
                        })().map((m) => {
                          const active = (model ?? '') === (m.id ?? '');
                          return (
                            <button
                              key={m.label}
                              onClick={() => pickModel(m.id)}
                              title={m.id ?? tr('addAgent.cliDefaultModel')}
                              style={{
                                padding: '3px 8px 1px',
                                background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: active
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                              }}
                            >
                              {m.label}
                            </button>
                          );
                        })}
                      </div>
                    </Row>}

                    {/* OSS-model quick-picks (ondev-c) — local + third-party-provider
                        shortlists from the verified catalog. Clicking sets the
                        engine-correct slug (OpenCode `local/<tag>`, Crush/pi
                        `ollama/<tag>`; provider slugs are identical across engines)
                        and rebuilds the command. */}
                    {hasOssQuickPicks(provider) && (
                      <Row label={tr('addAgent.ossModels')}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div>
                            <div style={ossGroupHead}>{tr('addAgent.ossLocal')}</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {OSS_LOCAL_PICKS.map((p) => {
                                const slug = localSlugFor(provider, p.tag);
                                const active = (model ?? '') === slug;
                                return (
                                  <button
                                    key={p.tag}
                                    onClick={() => pickModel(slug)}
                                    title={tr('addAgent.ossLocalTitle', { slug, ram: p.minRam, tag: p.tag })}
                                    style={ossChip(active, accent)}
                                  >
                                    {p.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div>
                            <div style={ossGroupHead}>{tr('addAgent.ossByok')}</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {OSS_PROVIDER_PICKS.map((p) => {
                                const active = (model ?? '') === p.slug;
                                return (
                                  <button
                                    key={p.slug}
                                    onClick={() => pickModel(p.slug)}
                                    title={tr('addAgent.ossByokTitle', { slug: p.slug, keyEnv: p.keyEnv })}
                                    style={ossChip(active, accent)}
                                  >
                                    {p.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </Row>
                    )}

                    {(provider === 'opencode' || provider === 'crush' || provider === 'pi' || provider === 'qwen') && (
                      <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px', margin: '2px 0 6px' }}>
                        {tr('addAgent.byokNote')}
                        {' '}
                        <a
                          href={OSS_BLOG_LINKS.openModels}
                          onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.openModels); }}
                          style={ossLink}
                        >{tr('addAgent.runOnOpenModels')}</a>
                        {' '}
                        <a
                          href={OSS_BLOG_LINKS.macMini}
                          onClick={(e) => { e.preventDefault(); void window.cth.openExternal(OSS_BLOG_LINKS.macMini); }}
                          style={ossLink}
                        >{tr('addAgent.setUpMacMini')}</a>.
                      </div>
                    )}

                    <Row label={config.autoMode && preset.autoFlag ? tr('addAgent.commandAuto') : tr('addAgent.command')}>
                      <input
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder={
                          provider === 'antigravity'
                            ? 'agy'
                            : provider === 'codex'
                              ? 'codex'
                              : provider === 'custom'
                                ? 'your-agent-cli'
                                : 'claude'
                        }
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
                      />
                    </Row>
                  </>
                )}

                {section === 'briefing' && (
                  <>
                    <Row label={tr('addAgent.templates')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {DESCRIPTION_TEMPLATES.map((t) => (
                          <button
                            key={t.labelKey}
                            onClick={() => { setDescription(t.description); setGoal(t.goal); }}
                            title={t.goal}
                            style={{
                              padding: '3px 8px 1px',
                              background: 'var(--cth-cream-100)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                              color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                            }}
                          >
                            {tr(t.labelKey)}
                          </button>
                        ))}
                      </div>
                    </Row>

                    <Row label={tr('addAgent.description')}>
                      <input
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder={tr('addAgent.descriptionPlaceholder')}
                        style={inputStyle}
                      />
                    </Row>

                    <Row label={tr('addAgent.goal')}>
                      <textarea
                        dir={rtl ? 'auto' : undefined}
                        value={goal}
                        onChange={(e) => setGoal(e.target.value)}
                        placeholder={tr('addAgent.goalPlaceholder')}
                        rows={2}
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-ui)', resize: 'none' }}
                      />
                    </Row>
                  </>
                )}
              </div>
            </div>

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 13,
                color: 'var(--cth-ink-900)'
              }}>
                {error}
              </div>
            )}

            {/* Hiring templates (item 5): pre-wire a small team in one step,
                reusing the exact human-review queue "Import hire" drives —
                each teammate still gets its own Spawn/Skip review below. */}
            <div style={{
              padding: '8px 10px',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              display: 'flex', flexDirection: 'column', gap: 6
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>
                  {tr('addAgent.teamTemplatesDesc')}
                </span>
                <button
                  onClick={() => setShowTeamTemplates((v) => !v)}
                  style={{
                    flexShrink: 0,
                    padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                    background: showTeamTemplates ? 'var(--cth-lemon-light)' : 'var(--cth-cream-200)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                  }}
                >
                  {showTeamTemplates ? tr('addAgent.hideTeamTemplates') : tr('addAgent.showTeamTemplates')}
                </button>
              </div>
              {showTeamTemplates && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {TEAM_TEMPLATES.map((tpl) => (
                    <div
                      key={tpl.labelKey}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                        padding: '6px 8px', background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 13, color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-display)' }}>
                          {tr(tpl.labelKey)}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>
                          {tr(tpl.descriptionKey)}
                        </div>
                      </div>
                      <PixelButton variant="secondary" size="sm" onClick={() => hireTeam(tpl.manifests)} disabled={busy}>
                        {tr('addAgent.useTeamTemplate')}
                      </PixelButton>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Import-hire explainer + AI prompt generator (item 7) */}
            <div style={{
              padding: '8px 10px',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              display: 'flex', flexDirection: 'column', gap: 6
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>
                  {tr('addAgent.importHireDesc')}
                </span>
                <button
                  onClick={() => setShowHirePrompt((v) => !v)}
                  style={{
                    flexShrink: 0,
                    padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                    background: showHirePrompt ? 'var(--cth-lemon-light)' : 'var(--cth-cream-200)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                  }}
                >
                  {showHirePrompt ? tr('addAgent.hideAIPrompt') : tr('addAgent.generateWithAI')}
                </button>
              </div>
              {showHirePrompt && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px' }}>
                    {tr('addAgent.aiPromptHint')}
                  </span>
                  <textarea
                    readOnly
                    value={HIRE_PROMPT}
                    onFocus={(e) => e.currentTarget.select()}
                    rows={10}
                    style={{
                      ...inputStyle,
                      width: '100%',
                      fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
                      resize: 'vertical', background: 'var(--cth-paper-100)'
                    }}
                  />
                  <div>
                    <PixelButton variant="secondary" size="sm" onClick={copyHirePrompt}>
                      {copiedPrompt ? tr('addAgent.copied') : tr('addAgent.copyPrompt')}
                    </PixelButton>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <PixelButton
                variant="secondary"
                size="md"
                onClick={importHire}
                disabled={busy}
                title={tr('addAgent.importHireBtnTitle')}
              >
                {tr('addAgent.importHireBtn')}
              </PixelButton>
              <div style={{ flex: 1 }} />
              {pendingHire && (
                <PixelButton variant="secondary" size="md" onClick={skipHire} disabled={busy}>{tr('addAgent.skipHire')}</PixelButton>
              )}
              <PixelButton variant="ghost" size="md" onClick={onClose} disabled={busy}>{tr('common.cancel')}</PixelButton>
              <PixelButton variant="primary" size="md" onClick={submit} disabled={busy}>
                {busy ? tr('addAgent.spawning') : tr('addAgent.spawn')}
              </PixelButton>
            </div>
          </div>
    </PixelModal>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 16,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)',
        fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </label>
  );
}
