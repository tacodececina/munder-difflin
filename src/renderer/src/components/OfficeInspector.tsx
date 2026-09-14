import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRtl } from '@/i18n/useDirection';
import { useStore } from '@/store/store';
import { PixelButton } from './PixelButton';
import { PixelPanel } from './PixelPanel';
import type {
  FloorInspectionEventDetail,
  FloorInspectionHandoff,
  FloorInspectionTarget,
} from '@/scene/office/floorInteractions';

const EVENT_NAME = 'cth:floor-inspection';

function isHttpUrl(value: string | null): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function agentIdForTarget(target: FloorInspectionTarget): string | null {
  if (target.kind === 'agent') return target.agentId;
  if (target.kind === 'desk' || target.kind === 'screen') return target.agentId ?? null;
  return null;
}

function targetTitle(target: FloorInspectionTarget, t: (key: string) => string): string {
  if (target.kind === 'agent') return t('floorInspector.agent');
  if (target.kind === 'desk') return t('floorInspector.desk');
  if (target.kind === 'screen') return t('floorInspector.screen');
  if (target.kind === 'room') return t(`floorInspector.rooms.${target.room}`);
  return t('floorInspector.title');
}

function ReadingMeta({
  info,
  label,
  t,
}: {
  info: { source: string; scope: string; availability: 'available' | 'unavailable'; lastValidAt: number | null };
  label: string;
  t: (key: string) => string;
}) {
  return (
    <div style={{ fontSize: 10, lineHeight: '14px', color: 'var(--cth-ink-500)', marginTop: 8 }}>
      <div>{label}: {info.availability === 'available' ? t('floorInspector.available') : t('floorInspector.noData')}</div>
      <div>{info.source} · {info.scope}</div>
      {info.lastValidAt !== null && <div>{t('floorInspector.lastRead')}: {new Date(info.lastValidAt).toLocaleString()}</div>}
    </div>
  );
}

function HandoffRow({ item, t }: { item: FloorInspectionHandoff; t: (key: string) => string }) {
  return (
    <div style={{ borderTop: '1px solid var(--cth-ink-200)', padding: '8px 0', fontSize: 12 }}>
      <div style={{ color: 'var(--cth-ink-900)' }}>{item.from ?? t('floorInspector.noData')} → {item.to ?? t('floorInspector.noData')}</div>
      <div style={{ color: 'var(--cth-ink-500)', fontSize: 11 }}>{item.act ?? t('floorInspector.noData')}</div>
      {item.id && <div dir="auto" style={{ fontSize: 10 }}>{item.id}</div>}
    </div>
  );
}

export function OfficeInspector() {
  const { t } = useTranslation();
  const rtl = useRtl();
  const enabled = useStore((s) => s.floorInspectionEnabled);
  const visitorMode = useStore((s) => s.visitorMode);
  const agents = useStore((s) => s.agents);
  const [detail, setDetail] = useState<FloorInspectionEventDetail | null>(null);
  const [targets, setTargets] = useState<FloorInspectionTarget[]>([]);
  const dialogRef = useRef<HTMLElement | null>(null);
  const pickerRef = useRef<HTMLSelectElement | null>(null);
  const close = () => { setDetail(null); pickerRef.current?.focus(); };

  useEffect(() => {
    if (!enabled || visitorMode) {
      setDetail(null);
      setTargets([]);
      return;
    }
    const onInspection = (event: Event) => {
      const next = (event as CustomEvent<FloorInspectionEventDetail>).detail;
      if (!next?.target || !next.snapshot) return;
      setDetail(next);
    };
    const onReset = () => { setDetail(null); setTargets([]); };
    const onTargets = (event: Event) => {
      setTargets((event as CustomEvent<FloorInspectionTarget[]>).detail ?? []);
    };
    window.addEventListener(EVENT_NAME, onInspection);
    window.addEventListener('cth:floor-inspection-reset', onReset);
    window.addEventListener('cth:floor-inspection-targets', onTargets);
    window.dispatchEvent(new CustomEvent('cth:floor-inspection-targets-request'));
    return () => {
      window.removeEventListener(EVENT_NAME, onInspection);
      window.removeEventListener('cth:floor-inspection-reset', onReset);
      window.removeEventListener('cth:floor-inspection-targets', onTargets);
    };
  }, [enabled, visitorMode]);

  useEffect(() => {
    if (!detail) return;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

  if (!enabled || visitorMode) return null;

  const picker = (
    <select
      ref={pickerRef}
      aria-label={t('floorInspector.chooseTarget')}
      dir={rtl ? 'rtl' : 'ltr'}
      value=""
      onFocus={() => window.dispatchEvent(new CustomEvent('cth:floor-inspection-targets-request'))}
      onChange={(event) => {
        const target = targets[Number(event.target.value)];
        if (target) window.dispatchEvent(new CustomEvent<FloorInspectionTarget>('cth:floor-inspection-request', { detail: target }));
      }}
      style={{ position: 'absolute', bottom: 16, insetInlineEnd: 16, zIndex: 20, maxWidth: 'calc(100% - 32px)', pointerEvents: 'auto' }}
    >
      <option value="" disabled>{t('floorInspector.chooseTarget')}</option>
      {targets.map((target, index) => <option key={index} value={index}>
        {targetTitle(target, t)}{target.kind === 'agent'
          ? `: ${agents.find((agent) => agent.id === target.agentId)?.name ?? target.agentId}`
          : target.kind === 'desk' || target.kind === 'screen' ? `: ${target.seatId}` : ''}
      </option>)}
    </select>
  );
  if (!detail) return picker;

  const { target, snapshot } = detail;
  const agentId = agentIdForTarget(target);
  const agent = agentId ? agents.find((candidate) => candidate.id === agentId) : undefined;
  const selectedTasks = agentId ? snapshot.tasks?.filter((task) => task.assignee === agentId) ?? null : null;
  const title = target.kind === 'room'
    ? t(`floorInspector.rooms.${target.room}`)
    : targetTitle(target, t);

  return (
    <>
    {picker}
    <aside
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-label={t('floorInspector.title')}
      dir={rtl ? 'rtl' : 'ltr'}
      style={{
        position: 'absolute', top: 16, right: rtl ? 'auto' : 16, left: rtl ? 16 : 'auto',
        width: 'min(360px, calc(100% - 32px))', maxHeight: 'calc(100% - 32px)', overflow: 'auto',
        zIndex: 20, pointerEvents: 'auto',
      }}
    >
      <PixelPanel variant="dialog" title={title} noPadding>
        <div style={{ padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
            <PixelButton variant="ghost" size="sm" onClick={close} aria-label={t('common.close')}>
              ×
            </PixelButton>
          </div>
          <p style={{ fontSize: 11 }}>{t('floorInspector.snapshotNotice')} {new Date(snapshot.capturedAt).toLocaleString()}</p>

          {target.kind === 'room' && target.room === 'operations' && (
            <>
              <h3 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('floorInspector.breaker')}</h3>
              {snapshot.breaker.readings?.length ? snapshot.breaker.readings.map((reading) => (
                <div key={reading.agentId} style={{ fontSize: 12, padding: '3px 0' }}>
                  {agents.find((candidate) => candidate.id === reading.agentId)?.name ?? reading.agentId}: {reading.level}
                </div>
              )) : <div style={{ fontSize: 12 }}>{t('floorInspector.noData')}</div>}
              <ReadingMeta info={snapshot.breaker.info} label={t('floorInspector.reading')} t={t} />
            </>
          )}

          {target.kind === 'room' && target.room === 'engineering' && (
            <>
              <h3 style={{ margin: '0 0 5px', fontSize: 13 }}>{t('floorInspector.agent')}</h3>
              {agents.length ? agents.map((candidate) => {
                const assigned = snapshot.tasks?.filter((task) => task.assignee === candidate.id) ?? [];
                return (
                  <div key={candidate.id} style={{ borderTop: '1px solid var(--cth-ink-200)', padding: '8px 0', fontSize: 12 }}>
                    <div style={{ fontWeight: 700 }}>{candidate.name}</div>
                    <div>{t('floorInspector.activity')}: {candidate.action || t('floorInspector.noData')}</div>
                    <div style={{ color: 'var(--cth-ink-500)', fontSize: 11 }}>{t('floorInspector.tasks')}: {snapshot.tasks === null ? t('floorInspector.noData') : assigned.length}</div>
                  </div>
                );
              }) : <div style={{ fontSize: 12 }}>{t('floorInspector.noData')}</div>}
              <ReadingMeta info={snapshot.taskReading} label={t('floorInspector.reading')} t={t} />
            </>
          )}

          {(target.kind === 'agent' || target.kind === 'desk' || target.kind === 'screen') && (
            <>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{agent?.name ?? t('floorInspector.noData')}</div>
              <div style={{ fontSize: 12, marginTop: 5 }}>{t('floorInspector.activity')}: {agent?.action || t('floorInspector.noData')}</div>
              <h3 style={{ margin: '14px 0 5px', fontSize: 13 }}>{t('floorInspector.tasks')}</h3>
              {selectedTasks?.length ? selectedTasks.map((task) => (
                <div key={task.id} style={{ fontSize: 12, padding: '3px 0' }}>
                  {task.title ?? task.id}: {task.status ?? t('floorInspector.noData')}
                </div>
              )) : <div style={{ fontSize: 12 }}>{t('floorInspector.noData')}</div>}
              <ReadingMeta info={snapshot.taskReading} label={t('floorInspector.reading')} t={t} />
            </>
          )}

          {target.kind === 'room' && target.room === 'briefing' && (
            <>
              <h3 style={{ margin: '0 0 5px', fontSize: 13 }}>{t('floorInspector.handoffs')}</h3>
              {snapshot.handoffs.items?.length ? snapshot.handoffs.items.slice(-8).reverse().map((item, index) => (
                <HandoffRow key={item.id ?? index} item={item} t={t} />
              )) : <div style={{ fontSize: 12 }}>{t('floorInspector.noData')}</div>}
              <ReadingMeta info={snapshot.handoffs.info} label={t('floorInspector.reading')} t={t} />
            </>
          )}

          {target.kind === 'room' && target.room === 'deployments' && (
            <>
              <h3 style={{ margin: '0 0 5px', fontSize: 13 }}>{t('floorInspector.ci')}</h3>
              <div style={{ fontSize: 12 }}>{snapshot.ci.repo ?? t('floorInspector.noData')}</div>
              {snapshot.ci.runs?.length ? snapshot.ci.runs.map((run, index) => (
                <div key={`${run.name ?? 'run'}-${index}`} style={{ borderTop: '1px solid var(--cth-ink-200)', padding: '7px 0', fontSize: 12 }}>
                  <div>{run.name ?? t('floorInspector.noData')}: {run.conclusion ?? run.status ?? t('floorInspector.noData')}</div>
                  {isHttpUrl(run.url) && <PixelButton variant="ghost" size="sm" onClick={() => void window.cth.openExternal(run.url!)}>{t('floorInspector.openRun')}</PixelButton>}
                </div>
              )) : <div style={{ fontSize: 12 }}>{t('floorInspector.noData')}</div>}
              <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 6 }}>{t('floorInspector.ciDisclaimer')}</div>
              <ReadingMeta info={snapshot.ci.info} label={t('floorInspector.reading')} t={t} />
            </>
          )}

          {target.kind === 'room' && target.room === 'rest' && (
            <>
              <div style={{ fontSize: 12 }}>{t('floorInspector.noConversation')}</div>
            </>
          )}
        </div>
      </PixelPanel>
    </aside>
    </>
  );
}
