import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { parseTasks } from './TasksKanban';
import { buildLegend, longestStreak, STREAK_MILESTONE, type LegendEntry } from '@/store/legend';

/**
 * THE LEGEND — the floor's self-written mythology, as a read-only wall.
 *
 * Deliberately a first pass and deliberately plain: a header, a list, an empty
 * state. What makes it worth having is not the layout, it is that every line is
 * a real closure the hive recorded — see `store/legend.ts` for how the list is
 * derived from `log.jsonl` + `tasks.json` with no new persistence.
 *
 * A READ surface, like the kanban it sits beside: nothing here writes.
 */

/** Same cadence as the kanban's own ledger poll — the two views of the same
 *  files should not disagree for longer than one tick. */
const POLL_MS = 5000;

/** How much of the event feed to read. The log carries every kind of hive event,
 *  so the closures are a thin slice of it; a generous window keeps a long floor
 *  history on the wall, and anything older falls back to the ledger's own done
 *  cards (undated, never invented). */
const LOG_WINDOW = 500;

export function LegendPanel() {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const restorableAgents = useStore((s) => s.restorableAgents);
  const [entries, setEntries] = useState<LegendEntry[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [log, tasks] = await Promise.all([
        window.cth.hiveLog(LOG_WINDOW),
        window.cth.hiveTasks()
      ]);
      setEntries(buildLegend(log, parseTasks(tasks)));
    } catch { /* keep the last good wall */ }
  }, []);

  useEffect(() => {
    void refresh();
    timer.current = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  /** Resolve a closer's agent id to a display name. Identical rule to the
   *  kanban's `nameFor`: the live floor first, then the restorable roster (so a
   *  legend keeps its author's name after that worker's terminal is gone), then
   *  the raw id rather than nothing. */
  const nameFor = (id?: string): string | undefined =>
    id
      ? (agents.find((a) => a.id === id)?.name
        ?? restorableAgents.find((a) => a.id === id)?.name
        ?? id)
      : undefined;

  const best = longestStreak(entries);

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--cth-paper-200)'
    }}>
      {/* Header — mirrors the kanban toolbar so the two tabs read as siblings. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)' }}>
          {t('legend.count', { count: entries.length })}
        </span>
        {best >= STREAK_MILESTONE && (
          <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)' }}>
            {t('legend.longest', { count: best })}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cth-ink-300)' }}>
          {t('legend.hint')}
        </span>
      </div>

      {/* The wall */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {entries.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            padding: '28px 16px', textAlign: 'center',
            background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
          }}>
            <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
              {t('legend.empty')}
            </span>
            <span style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-500)', maxWidth: 360 }}>
              {t('legend.emptyHint')}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {entries.map((entry) => (
              <LegendRow key={entry.id} entry={entry} closer={nameFor(entry.who)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── One line on the wall ────────────────────────────────────────────────────

function LegendRow({ entry, closer }: { entry: LegendEntry; closer?: string }) {
  const { t } = useTranslation();
  const first = entry.ordinal === 1;
  const streak = entry.streak >= STREAK_MILESTONE;
  const when = entry.at !== undefined ? new Date(entry.at) : null;
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', gap: 0,
      background: 'var(--cth-paper-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
    }}>
      {/* A mint edge, the kanban's own DONE colour — every line here is a done card. */}
      <span style={{ width: 4, flexShrink: 0, background: 'var(--cth-mint)', boxShadow: 'inset -1px 0 0 var(--cth-ink-700)' }} />
      <span style={{
        width: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--cth-font-display)', fontSize: 9,
        color: first ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
        background: first ? 'var(--cth-lemon)' : 'transparent'
      }}>
        {entry.ordinal !== undefined ? `#${entry.ordinal}` : '—'}
      </span>
      <span style={{ flex: 1, minWidth: 0, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
        }}>{entry.title}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
            {closer ? t('legend.by', { name: closer.toUpperCase() }) : t('legend.unassigned')}
          </span>
          <span style={{ fontSize: 10, color: 'var(--cth-ink-300)' }}>
            {when && !isNaN(when.getTime()) ? when.toLocaleString() : t('legend.undated')}
          </span>
          {first && (
            <span
              title={t('legend.firstTitle')}
              style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 8, padding: '2px 5px 1px',
                background: 'var(--cth-lemon)', color: 'var(--cth-ink-900)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}
            >{t('legend.first')}</span>
          )}
          {streak && (
            <span
              title={closer ? t('legend.streakTitle', { name: closer, count: entry.streak }) : undefined}
              style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 8, padding: '2px 5px 1px',
                background: 'var(--cth-lilac)', color: 'var(--cth-ink-900)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}
            >{t('legend.streak', { count: entry.streak })}</span>
          )}
        </span>
      </span>
    </div>
  );
}
