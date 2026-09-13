import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import { disposeTerminal } from './terminalPool';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelModal } from './PixelModal';
import { Icon } from './Icon';
import type { ThemeId } from '@/scene/office/themeRegistry';
import { validateUserThemeBundle } from '@/scene/office/themeLoader';
import {
  useCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  type CustomThemeRecord,
} from '@/scene/office/customThemes';

// TV-show office themes (Phase 1 = the switch flow infra). Only `office` has a
// real map+cast today; the five shows render via the loader's office fallback
// until their content lands (Phase 2). `built: false` shows a "soon" tag and a
// fallback note on switch, but the destructive switch flow still runs so the
// whole pipeline (modal → delete cast → persist → re-seat) is exercisable now.
interface ThemeMeta { id: ThemeId; label: string; blurb: string; built: boolean; swatch: string; }
const THEME_META: ThemeMeta[] = [
  { id: 'office',        label: 'The Office',         blurb: 'Dunder Mifflin — the original floor', built: true,  swatch: '#6b5a4a' },
  { id: 'friends',       label: 'Friends',            blurb: 'Central Perk coffee house',           built: true,  swatch: '#9a5a32' },
  { id: 'brooklyn99',    label: 'Brooklyn Nine-Nine', blurb: 'The 99th precinct bullpen',           built: true,  swatch: '#3a5a7a' },
  { id: 'siliconvalley', label: 'Silicon Valley',     blurb: 'The Hacker Hostel',                   built: true,  swatch: '#4a6a4a' },
  { id: 'got',           label: 'Game of Thrones',    blurb: 'The Red Keep throne room',            built: false, swatch: '#6a2630' },
  { id: 'hogwarts',      label: 'Harry Potter',       blurb: 'Hogwarts great hall',                 built: false, swatch: '#39305a' },
  // Not a show — a PROJECTION, offered here so it can be compared against the
  // four above with one click. `built: true` is honest: it renders its own real
  // map and seats the real cast. It is a small prototype room with most of the
  // office's systems switched off (see themeRegistry's ISOMETRIC_THEME), which
  // the blurb says out loud rather than hiding behind the "soon" tag that means
  // "renders the office instead".
  { id: 'isometric',     label: 'Isometric (proto)',  blurb: '2:1 diamond grid — a look test',      built: true,  swatch: '#b0946e' },
];

/** Settings "Office Theme" section: an experimental flag toggle + a 6-card
 *  theme picker with the destructive switch flow (report §E). Self-contained so
 *  it stays out of SettingsModal's bulk. */
export function OfficeThemePicker({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(!!config.tvShowOffices);
  const [current, setCurrent] = useState<ThemeId>((config.officeTheme as ThemeId) ?? 'office');
  const [pending, setPending] = useState<ThemeId | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  // "Import theme…" flow (Phase 4: user-authored bundles). Kept local/simple —
  // it never shares state with the built-in switch flow above except by
  // calling the same `applyTheme` when a currently-active custom theme is
  // deleted (see onDeleteCustomTheme).
  const [importBusy, setImportBusy] = useState(false);
  const [importErrors, setImportErrors] = useState<string[] | null>(null);
  const customThemes = useCustomThemes();

  const archiveAgent = useStore((s) => s.archiveAgent);
  const setOfficeTheme = useStore((s) => s.setOfficeTheme);

  const toggleFlag = async () => {
    const next = !enabled;
    setEnabled(next);
    setNote('');
    try {
      await window.cth.updateConfig({ tvShowOffices: next });
      // Flag off → the office renders regardless of the saved theme; flag on →
      // restore the persisted theme.
      setOfficeTheme(next ? current : 'office');
    } catch {
      setEnabled(!next); // revert optimistic toggle on failure
    }
  };

  const nonGodAgents = () =>
    useStore.getState().agents.filter((a) => !a.isGod && !a.isAssistant);

  const onSelect = (id: ThemeId) => {
    setNote('');
    if (busy || id === current) return;                 // no-op on the current theme
    if (nonGodAgents().length === 0) { void applyTheme(id); return; } // god-only → instant
    setPending(id);                                     // workers exist → confirm modal
  };

  const applyTheme = async (id: ThemeId) => {
    setBusy(true);
    try {
      // Tear down every non-god agent through the EXISTING lifecycle (kill PTY →
      // dispose terminal → archive). god + the prep assistant carry over; god's
      // PTY is never touched. If a PTY won't die, abort the switch (surface the
      // error, don't persist the new theme) rather than leave a half-switched floor.
      const victims = nonGodAgents();
      for (const a of victims) {
        if (a.ptyId) {
          await window.cth.killPty(a.ptyId);
          disposeTerminal(a.ptyId);
        }
      }
      for (const a of victims) archiveAgent(a.id);
      await window.cth.updateConfig({ officeTheme: id });
      setCurrent(id);
      setOfficeTheme(id); // → OfficeFloor rebuilds the scene on the new map/cast
      const meta = THEME_META.find((t) => t.id === id);
      if (meta && !meta.built) setNote(t('officeTheme.notBuiltYet', { label: meta.label }));
    } catch (e) {
      setNote(t('officeTheme.switchAborted', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const pendingMeta = pending ? THEME_META.find((t) => t.id === pending) : null;

  /** "Import theme…" — reuses the SAME folder picker AddAgentModal already
   *  uses (window.cth.chooseFolder), validates the chosen bundle (never
   *  rendering anything unvalidated), and on success registers it via
   *  customThemes.ts — the theme then simply appears as another card below,
   *  switched to through the normal onSelect flow (no surprise auto-switch as
   *  a side effect of importing). */
  const onImportClick = async () => {
    setNote('');
    setImportErrors(null);
    const res = await window.cth.chooseFolder();
    if (!res.ok) {
      if (res.error !== 'cancelled') setImportErrors([res.error]);
      return;
    }
    setImportBusy(true);
    try {
      const validated = await validateUserThemeBundle(res.path);
      if (!validated.ok) { setImportErrors(validated.errors); return; }
      saveCustomTheme(validated.manifest.label, res.path);
      setNote(t('officeTheme.import.success', { label: validated.manifest.label }));
    } finally {
      setImportBusy(false);
    }
  };

  /** Deleting the CURRENTLY ACTIVE custom theme routes through the existing
   *  destructive `applyTheme('office')` first (archives non-god agents,
   *  persists, re-seats) — the same contract every other theme switch already
   *  has — WITHOUT a second confirm dialog: choosing "remove" on the theme the
   *  user is already looking at is itself the explicit destructive action: a
   *  second "are you sure" would just be friction. Deleting an inactive custom
   *  theme is a plain, non-destructive registry removal. */
  const onDeleteCustomTheme = async (ct: CustomThemeRecord) => {
    setNote('');
    if (ct.id === current) await applyTheme('office');
    deleteCustomTheme(ct.id);
  };

  return (
    <div>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
      }}>
        {t('officeTheme.title')}
      </div>

      {/* Experimental feature flag */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>
            {t('officeTheme.tvShow')} <span style={{ color: 'var(--cth-ink-500)' }}>({t('officeTheme.experimental')})</span>
          </span>
          <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            {t('officeTheme.desc')}
          </span>
        </div>
        <PixelButton variant={enabled ? 'primary' : 'secondary'} size="sm" onClick={toggleFlag}>
          {enabled ? t('common.on') : t('common.off')}
        </PixelButton>
      </div>

      {/* Theme picker grid (only when the flag is on) */}
      {enabled && (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {THEME_META.map((theme) => {
            const isCurrent = theme.id === current;
            return (
              <button
                key={theme.id}
                onClick={() => onSelect(theme.id)}
                disabled={busy}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                  padding: 8, cursor: busy ? 'default' : 'pointer',
                  background: isCurrent ? 'var(--cth-paper-100)' : 'transparent',
                  boxShadow: isCurrent
                    ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                    : 'inset 0 0 0 1px var(--cth-ink-300)',
                  opacity: busy && !isCurrent ? 0.6 : 1,
                }}
              >
                <span style={{
                  width: 28, height: 28, flexShrink: 0, background: theme.swatch,
                  boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {theme.label}
                    </span>
                    {isCurrent && (
                      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 7, color: 'var(--cth-mint)', textTransform: 'uppercase' }}>
                        {t('officeTheme.current')}
                      </span>
                    )}
                    {!theme.built && !isCurrent && (
                      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 7, color: 'var(--cth-ink-500)', textTransform: 'uppercase' }}>
                        {t('officeTheme.soon')}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 11, lineHeight: '14px', color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {theme.blurb}
                  </span>
                </span>
              </button>
            );
          })}

          {/* Imported custom bundles (Phase 4) — same card shape as the
             built-in themes, plus a remove ("x") corner button. */}
          {customThemes.map((ct) => {
            const isCurrent = ct.id === current;
            return (
              <div key={ct.id} style={{ position: 'relative' }}>
                <button
                  onClick={() => onSelect(ct.id)}
                  disabled={busy}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                    padding: 8, width: '100%', cursor: busy ? 'default' : 'pointer',
                    background: isCurrent ? 'var(--cth-paper-100)' : 'transparent',
                    boxShadow: isCurrent
                      ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                      : 'inset 0 0 0 1px var(--cth-ink-300)',
                    opacity: busy && !isCurrent ? 0.6 : 1,
                  }}
                >
                  <span style={{
                    width: 28, height: 28, flexShrink: 0, background: 'var(--cth-lilac, #8a6ab0)',
                    boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                  }} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {ct.label}
                      </span>
                      {isCurrent && (
                        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 7, color: 'var(--cth-mint)', textTransform: 'uppercase' }}>
                          {t('officeTheme.current')}
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 11, lineHeight: '14px', color: 'var(--cth-ink-500)' }}>
                      {t('officeTheme.import.badge')}
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => void onDeleteCustomTheme(ct)}
                  disabled={busy}
                  title={t('officeTheme.import.remove')}
                  aria-label={t('officeTheme.import.remove')}
                  style={{
                    position: 'absolute', top: 4, right: 4, width: 18, height: 18,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                    cursor: busy ? 'default' : 'pointer',
                  }}
                >
                  <Icon name="x" />
                </button>
              </div>
            );
          })}

          {/* "Import theme…" — folder picker + validation (Phase 4). */}
          <button
            onClick={() => void onImportClick()}
            disabled={busy || importBusy}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: 8, minHeight: 44, cursor: busy || importBusy ? 'default' : 'pointer',
              background: 'transparent', boxShadow: 'inset 0 0 0 1px dashed var(--cth-ink-300)',
              opacity: busy || importBusy ? 0.6 : 1,
              color: 'var(--cth-ink-500)', fontSize: 12,
            }}
          >
            <Icon name="plus" />
            {importBusy ? t('officeTheme.import.validating') : t('officeTheme.import.action')}
          </button>
        </div>
      )}

      {enabled && note && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</div>
      )}

      {pending && pendingMeta && (
        <ThemeSwitchConfirmModal
          label={pendingMeta.label}
          agents={nonGodAgents()}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void applyTheme(pending)}
        />
      )}

      {importErrors && (
        <PixelModal title={t('officeTheme.import.errorsTitle')} onClose={() => setImportErrors(null)} width={520}>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
              {t('officeTheme.import.errorsIntro')}
            </div>
            <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '40vh', overflowY: 'auto' }}>
              {importErrors.map((e, i) => (
                <li key={i} style={{ fontSize: 12, lineHeight: '18px', color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-mono)' }}>
                  {e}
                </li>
              ))}
            </ul>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <PixelButton variant="secondary" size="md" onClick={() => setImportErrors(null)}>
                {t('common.close')}
              </PixelButton>
            </div>
          </div>
        </PixelModal>
      )}
    </div>
  );
}

interface VictimAgent { id: string; status?: string; }

/** Destructive confirm for a theme switch with live workers (report §E copy). */
function ThemeSwitchConfirmModal({
  label, agents, busy, onCancel, onConfirm,
}: {
  label: string;
  agents: VictimAgent[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const n = agents.length;
  const working = agents.filter((a) => a.status && !['idle', 'success', 'error'].includes(a.status)).length;
  const godName = useStore.getState().agents.find((a) => a.isGod)?.name ?? 'the orchestrator';

  return (
    <div
      onClick={busy ? undefined : onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(26, 19, 32, 0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 400,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 480, maxWidth: '92vw' }}>
        <PixelPanel variant="dialog" title={t('officeTheme.confirmTitle', { label: label.toUpperCase() })} noPadding>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{
                width: 32, height: 32, flexShrink: 0,
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-500)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon name="bell" />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '20px',
                  color: 'var(--cth-ink-900)', marginBottom: 4,
                }}>
                  {t('officeTheme.startsFreshCast')}
                </div>
                <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cth-ink-700)' }}>
                  {n === 1
                    ? t('officeTheme.deleteCount', { count: n })
                    : t('officeTheme.deleteCountPlural', { count: n })}{' '}
                  {t('officeTheme.onlyCarries', { god: godName })}
                  {working > 0 && (
                    <span style={{ display: 'block', marginTop: 6, color: 'var(--cth-coral)' }}>
                      ⚠ {working === 1
                        ? t('officeTheme.stillWorking', { count: working })
                        : t('officeTheme.stillWorkingPlural', { count: working })}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', marginTop: 8 }}>
                  {t('officeTheme.cantUndo')}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <PixelButton variant="secondary" size="md" onClick={onCancel} disabled={busy}>
                {t('common.cancel')}
              </PixelButton>
              <PixelButton variant="destructive" size="md" onClick={onConfirm} disabled={busy}>
                {busy ? t('officeTheme.switching') : t('officeTheme.deleteSwitch', { count: n })}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
