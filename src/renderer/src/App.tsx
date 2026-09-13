import { useEffect, useState } from 'react';
import { useStore, selectedAgent } from '@/store/store';
import { startMockLoop, stopMockLoop } from '@/store/mockEvents';
import type { HarnessConfig } from '@/store/config';
import { DEFAULT_ORG_TRIGGER } from '@shared/triggers';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useHive } from '@/hooks/useHive';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';
import { useGodNameSync } from '@/i18n/useGodNameSync';
import { useDirectionSync } from '@/i18n/useDirection';
import { useArabicTerminalSync } from '@/terminal/useArabicTerminalSync';
import { AddAgentModal } from '@/components/AddAgentModal';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { HivePicker } from '@/components/HivePicker';
import { QuitWarningModal, type ClosingTimeState } from '@/components/QuitWarningModal';
import { DundiesModal } from '@/components/DundiesModal';
import { useAppTheme, toggleAppTheme } from '@/design/theme';
import { SettingsModal, type Section as SettingsSection } from '@/components/SettingsModal';
import { acquireTerminal, notifyThemeChangeAll } from '@/components/terminalPool';
import { FullscreenTerminal } from '@/components/FullscreenTerminal';
import { TaskDetailOverlay } from '@/components/TaskDetailOverlay';
import { IdePanel } from '@/ide/IdePanel';
import { useHoldOptionToTalk } from '@/freeflow/holdOption';
import { AppShell } from '@/AppShell';

// Injected at build time from package.json (see electron.vite.config.ts).
declare const __APP_VERSION__: string;

/**
 * Phase 0 hardening: the ROOT error boundary, the last resort behind every
 * more specific one below (office floor, per-agent terminals, agent detail
 * panel, each modal). Wrapping the OUTER `App` rather than putting the
 * boundary inside `AppInner` means it also covers the early-return states —
 * the loading blank, OnboardingWizard, HivePicker — not just the fully-booted
 * UI, without duplicating a boundary at each of those return sites.
 */
export function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

function AppInner() {
  // Point every {{godName}} string at the orchestrator's real, renameable name.
  useGodNameSync();
  // Mirror the document only for a user who has picked an RTL app language.
  useDirectionSync();
  // Let terminals that are ALREADY open follow a language switch too.
  useArabicTerminalSync();
  const agent = useStore(selectedAgent);
  const agents = useStore(s => s.agents);
  const agentCount = agents.length;
  const bootingGodName = useResolvedGodName();
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const clearPendingHires = useStore(s => s.clearPendingHires);
  const godStatus = useStore(s => s.godStatus);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const appThemeNow = useAppTheme();
  const sidebarWidth = useStore(s => s.sidebarWidth);
  const setSidebarWidth = useStore(s => s.setSidebarWidth);
  const ideOpen = useStore(s => s.ideOpen);
  const setIdeOpen = useStore(s => s.setIdeOpen);
  const visitorMode = useStore(s => s.visitorMode);

  const [config, setConfig] = useState<HarnessConfig | null>(null);
  // Whether the user has passed the launch-time hive picker this session. Starts
  // true (skip the picker) right after a hive SWITCH — changeHome relaunches and
  // leaves a one-shot localStorage flag so we don't bounce back onto the picker for
  // the hive we just chose. Also set true on onboarding completion (below).
  const [hiveOpened, setHiveOpened] = useState<boolean>(() => {
    try {
      if (window.localStorage.getItem('cth.skipHivePickerOnce')) {
        window.localStorage.removeItem('cth.skipHivePickerOnce');
        return true;
      }
    } catch { /* localStorage unavailable — show the picker */ }
    return false;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Which tab Settings opens on. Set by a `cth:open-settings` deep link, reset
   *  to undefined (→ General) whenever the modal is opened the normal way. */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [quitWarn, setQuitWarn] = useState<{ ptyCount: number } | null>(null);
  const [closing, setClosing] = useState<ClosingTimeState | null>(null);
  // "Dundies" recap (Phase 9): shown as an interstitial the moment the human
  // clicks "closing time", BEFORE the real protocol below actually starts.
  const [showDundies, setShowDundies] = useState(false);
  // Phase 2: the width tracking itself now lives in useBreakpoint (one shared
  // `resize` listener for the whole app, see that hook) — this used to be its
  // own useState + resize effect here, duplicating what AppShell now also
  // needs for its band-driven layout decisions.
  const { width: vpWidth } = useBreakpoint();

  // Bug fix (post-redesign devtools audit): in the 'compact' band, AppShell
  // renders the detail column as a `position: fixed` overlay
  // (`.cth-detail-col--overlay`, design/layout.css) docked over the right
  // ~45% of the office scene. It had no way to ever be dismissed — permanently
  // covering part of the scene on any window narrower than `bp.compact`
  // (1100px), which reads as "the office is cropped" regardless of theme.
  // This flag is the missing "is the drawer open" bit AppShell's own docs
  // note it deliberately never grew; it stays here (not in AppShell) per that
  // component's "no state of its own" convention. Defaults open (matches the
  // old always-on behavior) and re-opens whenever the selected agent changes,
  // so picking someone from the strip reliably brings their panel back even
  // after the previous one was dismissed.
  const [compactOverlayOpen, setCompactOverlayOpen] = useState(true);
  useEffect(() => {
    setCompactOverlayOpen(true);
  }, [agent?.id]);

  // Deep link into Settings from anywhere in the tree. Settings' open state is
  // local to App, so a nested control (e.g. "set it now" beside a disabled Talk
  // button) has no path to it without threading a prop through every layer
  // between; a window event keeps that plumbing out of the components in
  // between, matching the existing `cth:` CustomEvent convention.
  useEffect(() => {
    const onOpenSettings = (e: Event): void => {
      const section = (e as CustomEvent<{ section?: SettingsSection }>).detail?.section;
      setSettingsSection(section);
      setSettingsOpen(true);
    };
    window.addEventListener('cth:open-settings', onOpenSettings);
    return () => window.removeEventListener('cth:open-settings', onOpenSettings);
  }, []);

  // Initial config load
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then(c => {
      if (cancelled) return;
      setConfig(c);
      // Mirror the Free Flow flag into the store so the composer mic button shows
      // only when enabled (Settings keeps this in sync on save).
      useStore.getState().setFreeflowEnabled(!!c.freeflowEnabled);
      // Mirror boolean key-presence ONLY (never the key value) so the composer can
      // show the voice button disabled-with-tooltip when Free Flow is on but no
      // Groq key is set (Settings keeps this in sync on save).
      useStore.getState().setHasGroqKey(!!c.groqApiKey);
      // Mirror the active office theme so OfficeFloor renders it (gated on the
      // tvShowOffices flag; off = always the office). Settings keeps this synced.
      useStore.getState().setOfficeTheme(c.tvShowOffices ? (c.officeTheme ?? 'office') : 'office');
      // Mirror the triggers so Settings → Connections and the Command Center's
      // Triggers tab read one list, not two copies that drift — whichever surface
      // saves calls these same setters and the other repaints. No extra IPC: main
      // deep-fills both fields on every config read (withTriggerDefaults), so
      // getConfig() already serves what listWebhooks()/getOrgTrigger() would.
      // `c` is typed as the PRELOAD's HarnessConfig, which hasn't picked the two
      // fields up yet (another lane's file); the renderer mirror type declares them.
      const withTriggers = c as HarnessConfig;
      useStore.getState().setWebhookTriggers(withTriggers.webhookTriggers ?? []);
      useStore.getState().setOrgTrigger(withTriggers.orgTrigger ?? DEFAULT_ORG_TRIGGER);
      // Visitor mode seals surfaces all over the tree, so it is mirrored into
      // the store rather than threaded through props. `=== true` on purpose: a
      // config that predates the field must read as OFF, never as sealed.
      useStore.getState().setVisitorMode(withTriggers.visitorMode === true);
    });
    // Mirror BYOK OpenAI key presence (boolean only; the key never leaves main) so the
    // Realtime Michael voice toggle can gate on it. Lives in the secret broker, not
    // config — so fetch it rather than derive from c.
    window.cth.realtimeHasOpenAiKey().then(has => {
      if (!cancelled) useStore.getState().setHasOpenAiKey(has);
    });
    return () => { cancelled = true; };
  }, []);

  // Free Flow entry point B — hold-Option (⌥) to talk. In-renderer push-to-talk
  // for whichever agent the user is viewing; gated on the flag, terminal-safe
  // (solo-hold threshold, aborts on any other key). See freeflow/holdOption.ts.
  useHoldOptionToTalk();

  // Config subscription — the copy loaded above would otherwise go stale the
  // moment anything saves a setting.
  useEffect(() => window.cth.onConfigChanged((c) => {
    setConfig(c);
    // The one mirror that MUST follow every broadcast rather than only the
    // Settings save path: visitor mode is a privacy control, and a second floor
    // window still showing terminals after the operator armed it in the first
    // would defeat the entire point.
    useStore.getState().setVisitorMode((c as HarnessConfig).visitorMode === true);
  }), []);

  // Quit warning subscription
  useEffect(() => window.cth.onCloseRequested((info) => setQuitWarn(info)), []);

  // Shareable hires: a validated manifest arriving via the munderdifflin://
  // deep link (or file import) pre-fills the Add-Agent modal. Never spawns by itself.
  const enqueuePendingHires = useStore(s => s.enqueuePendingHires);
  const closeAddAgentReview = () => {
    clearPendingHires();
    setAddAgentOpen(false);
  };
  useEffect(() => {
    const unsub = window.cth.onHireImport?.((m) => {
      enqueuePendingHires([m]);
      setAddAgentOpen(true);
    });
    // Pull anything that arrived before this subscription existed (cold-start
    // deep links; packaged renderers load too fast for push-on-load).
    void window.cth.drainPendingHires?.().then((queued) => {
      if (queued && queued.length > 0) {
        enqueuePendingHires(queued);
        setAddAgentOpen(true);
      }
    });
    return unsub;
  }, [enqueuePendingHires, setAddAgentOpen]);
  useEffect(() => window.cth.onHireError?.((info) => {
    console.error('[hire] import failed:', info.error);
  }), []);

  // Closing-time progress: drives the quit dialog's "wrapping up" view. The
  // dialog stays up through the whole protocol; on 'complete' the main process
  // tears down and quits by itself moments later.
  useEffect(() => window.cth.onClosingTime?.((ev) => {
    if (ev.phase === 'cancelled') { setClosing(null); return; }
    setClosing({ phase: ev.phase, acked: ev.acked, total: ev.total });
    if (ev.phase === 'started' || ev.phase === 'progress') setQuitWarn((w) => w ?? { ptyCount: 0 });
  }), []);

  const startClosingTime = async () => {
    const res = await window.cth.startClosingTime();
    if (!res.ok) setClosing({ phase: 'error', acked: 0, total: 0, error: res.error });
  };
  const cancelClosingTime = () => {
    void window.cth.cancelClosingTime();
    setClosing(null);
  };
  /** Shared by the modal's own Cancel button and its error boundary's Retry:
   *  a QuitWarningModal that crashed must back OUT of the quit flow, not sit
   *  there re-rendering into the same error. */
  const cancelQuit = () => {
    if (closing) cancelClosingTime();
    window.cth.cancelClose();
    setQuitWarn(null);
    setShowDundies(false);
  };

  // The hive: god-agent bootstrap, hook-driven avatars, idle-agent waking. Held
  // off until the user opens a hive in the launch picker (passing null no-ops the
  // hook) so Michael doesn't boot against the current home while the user may be
  // about to switch to a different one.
  useHive(hiveOpened ? config : null);

  // Pre-warm a persistent terminal for every live agent so its output is
  // buffered from spawn. Switching agents then re-attaches an already-rendered
  // terminal instantly (with full history) instead of building a blank one.
  useEffect(() => {
    for (const a of agents) if (a.ptyId) acquireTerminal(a.ptyId);
  }, [agents]);

  // Synthetic demo loop — CAGED (#5B). It must never animate alongside a live
  // hive (it would fire fake envelope handoffs and step seeded agents). Run it
  // only as an explicit showcase (VITE_CTH_DEMO=1 in dev) or on a genuinely
  // empty floor, and stop it the instant the first real PTY agent appears
  // (Michael always spawns, so in normal operation it effectively never runs).
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const DEMO = import.meta.env.DEV && import.meta.env.VITE_CTH_DEMO === '1';
    const evaluate = () => {
      const hasLive = useStore.getState().agents.some((a) => a.ptyId);
      if (DEMO || !hasLive) startMockLoop();
      else stopMockLoop();
    };
    evaluate();
    const unsub = useStore.subscribe(evaluate);
    return () => { unsub(); stopMockLoop(); };
  }, [config?.onboardingComplete]);

  // Reconcile restored agents against the PTYs still alive in the main process.
  // After a renderer reload (e.g. the laptop slept and Vite reloaded the page),
  // this keeps agents whose process survived and drops any that truly died.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    let cancelled = false;
    window.cth.listPtys().then((list) => {
      if (cancelled) return;
      useStore.getState().reconcileWithLivePtys(list.map((p) => p.id));
    }).catch(() => { /* ignore — keep restored agents as-is */ });
    return () => { cancelled = true; };
  }, [config?.onboardingComplete]);

  // Re-apply the persisted focus-mode preference as the roster fills in.
  //
  // Not a one-shot at store construction: at launch every restored agent still
  // carries the PREVIOUS session's PTY id, so the reconcile above prunes the lot
  // and correctly drops focus mode to null before god has respawned. The
  // preference therefore has to be re-checked once agents with live terminals
  // actually exist. `restoreFocusMode` is a no-op unless the preference is on and
  // focus mode is currently off, so re-running it on every roster change is safe
  // and pressing Esc stays sticky.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    useStore.getState().restoreFocusMode();
  }, [config?.onboardingComplete, agents]);

  if (!config) {
    return <div style={{ width: '100vw', height: '100vh', background: 'var(--cth-cream-100)' }} />;
  }

  if (!config.onboardingComplete) {
    // Just-onboarded users go straight into the hive they set up — skip the picker.
    return <OnboardingWizard onComplete={(next) => { setConfig(next); setHiveOpened(true); }} />;
  }

  // Launch-time hive picker: on reopen, let the user open their current hive,
  // switch to a recent one, or open/create another. Skipped right after onboarding
  // and right after a switch-relaunch (see hiveOpened init).
  if (!hiveOpened) {
    return <HivePicker config={config} onOpenCurrent={() => setHiveOpened(true)} />;
  }

  // Theme toggle handler — flips the app theme, tells every pooled terminal
  // (so a live TUI's truecolor palette follows without a restart), and
  // persists the choice so future agent spawns match. Owned here (not in
  // AppShell) because it is orchestration, not layout: AppShell only renders
  // the button and calls this back.
  const onToggleTheme = () => {
    const next = toggleAppTheme();
    notifyThemeChangeAll(next === 'dark' ? 'dark' : 'light');
    void window.cth.updateConfig({ terminalTheme: next });
  };

  const onOpenSettings = () => { setSettingsSection(undefined); setSettingsOpen(true); };

  const onToggleFullscreen = () => {
    if (fullscreenAgentId) { useStore.getState().setFullscreen(null); return; }
    const all = useStore.getState().agents;
    const target = all.find((x) => x.id === useStore.getState().selectedId && x.ptyId)
      ?? all.find((x) => x.isGod && x.ptyId)
      ?? all.find((x) => x.ptyId);
    if (target) useStore.getState().setFullscreen(target.id);
  };

  return (
    <AppShell
      config={config}
      agent={agent}
      agentCount={agentCount}
      godStatus={godStatus}
      bootingGodName={bootingGodName}
      fullscreenAgentId={fullscreenAgentId}
      appThemeNow={appThemeNow}
      sidebarWidth={sidebarWidth}
      onSidebarWidthChange={setSidebarWidth}
      vpWidth={vpWidth}
      onAddAgent={() => setAddAgentOpen(true)}
      onOpenSettings={onOpenSettings}
      onToggleTheme={onToggleTheme}
      onToggleFullscreen={onToggleFullscreen}
      compactOverlayOpen={compactOverlayOpen}
      onCloseCompactOverlay={() => setCompactOverlayOpen(false)}
      onOpenCompactOverlay={() => setCompactOverlayOpen(true)}
    >
      {/* Every modal's MOUNT POINT gets its own boundary, not its inner content —
          so a crash during the modal's own initial mount (not just later, once
          it's up) is caught too. `onReset` closes the modal instead of the
          default remount: re-opening the SAME modal into the SAME props would
          most likely throw again immediately. */}
      {addAgentOpen && (
        <ErrorBoundary onReset={closeAddAgentReview}>
          <AddAgentModal
            onClose={closeAddAgentReview}
            config={config}
            onConfigChange={setConfig}
          />
        </ErrorBoundary>
      )}

      {settingsOpen && (
        <ErrorBoundary onReset={() => { setSettingsOpen(false); setSettingsSection(undefined); }}>
          <SettingsModal
            config={config}
            initialSection={settingsSection}
            onClose={() => { setSettingsOpen(false); setSettingsSection(undefined); }}
          />
        </ErrorBoundary>
      )}

      {quitWarn && showDundies && (
        <ErrorBoundary onReset={() => setShowDundies(false)}>
          <DundiesModal
            onCancel={() => setShowDundies(false)}
            onConfirm={() => { setShowDundies(false); void startClosingTime(); }}
          />
        </ErrorBoundary>
      )}

      {quitWarn && !showDundies && (
        <ErrorBoundary onReset={cancelQuit}>
          <QuitWarningModal
            ptyCount={quitWarn.ptyCount}
            closing={closing}
            onCancel={cancelQuit}
            onConfirm={async () => { await window.cth.confirmClose(); }}
            onClosingTime={() => setShowDundies(true)}
          />
        </ErrorBoundary>
      )}

      {fullscreenAgentId && <FullscreenTerminal config={config} />}
      {/* VISITOR MODE — the IDE and the task detail are gated at their MOUNT,
          not sealed from the inside. Both are overlays that cover the office
          floor, so a placeholder in their place would hide the one thing the
          mode wants on screen; and gating here means the file tree, the Monaco
          buffers and the ledger poll are never even constructed, so nothing is
          read off disk to be hidden in the first place.

          `ideOpen` / `taskDetailId` are left set on purpose: this is a veil,
          not a close, and lifting the mode brings back exactly what was open.
          (FullscreenTerminal makes the same call for the same reason — see its
          own early return.) */}
      {ideOpen && !visitorMode && <IdePanel />}
      {!visitorMode && (
        <ErrorBoundary onReset={() => useStore.getState().closeTaskDetail()}>
          <TaskDetailOverlay />
        </ErrorBoundary>
      )}
    </AppShell>
  );
}
