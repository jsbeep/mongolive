// Monitor › Collections › Alerts (9-8a) — 서버가 changeStream 이벤트로 찾은 대량 삭제·쓰기 폭주·삭제·이름 바꾸기
//   범위(서버·DB·컬렉션)와 기간에 든 것, 최근 것부터. 행을 누르면 그 컬렉션(지워졌으면 DB)으로 좁힌다
//   없으면 한 줄만, 규칙이 다 꺼져 있으면 설정 안내, 피드가 없으면(closed) 숨긴다
//   5m·1h는 10초마다, 긴 기간은 60초마다 묻는다(탭이 안 보이면 쉼). 새 알림이 오면(소켓) 바로 다시 묻는다 — 서버 메모리·기록 파일만 읽는다
import { useCachedReport } from '../../hooks/useCachedReport';
import { RefreshSpinner, SkeletonLine } from '../common/Skeleton';
import { useEffect, useRef, useState } from 'react';
import { BellRing, CircleAlert, ShieldCheck } from 'lucide-react';
import type { AlertKind, AlertsReport, MonitorAlert, MonitorRange } from '../../types/explorer';
import { LIVE_RANGES } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { fmtClock, fmtDate, RANGE_LABEL } from './format';
import { ALERT_LABEL, alertFocus, alertTarget } from './alerts';
import type { MonitorScope } from './ScopeBar';

const LIVE_POLL_MS = 10_000;
const LONG_POLL_MS = 60_000;
const FIRST_ROWS = 5;

const PILL: Record<AlertKind, string> = {
  'mass-delete': 'bg-rose-50 text-rose-700 ring-rose-200/70',
  drop: 'bg-rose-50 text-rose-700 ring-rose-200/70',
  'drop-database': 'bg-rose-50 text-rose-700 ring-rose-200/70',
  burst: 'bg-amber-50 text-amber-700 ring-amber-200/70',
  rename: 'bg-amber-50 text-amber-700 ring-amber-200/70',
};

const styles = {
  card: 'flex min-w-0 flex-col gap-1.5 rounded-xl border border-slate-200/70 bg-white px-3.5 pb-2.5 pt-3',
  quiet: 'flex min-w-0 items-center gap-2 rounded-xl border border-slate-200/70 bg-white px-3.5 py-2 text-[12px] text-slate-500',
  title: 'text-[13px] font-semibold text-slate-800',
  sub: 'text-[11px] text-slate-500',
  row: 'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-md px-1.5 py-1.5 transition-colors hover:bg-slate-50',
  pill: 'rounded-full px-1.5 py-px text-[10.5px] font-medium ring-1',
  target: 'min-w-0 truncate font-mono text-[12px] text-slate-700',
  detail: 'col-start-2 col-end-4 truncate text-[11px] text-slate-500',
  time: 'flex items-center gap-1.5 text-right text-[11px] tabular-nums text-slate-500',
  badge: 'rounded px-1 py-px text-[10px] font-medium text-slate-500 ring-1 ring-slate-200',
  more: 'self-start rounded-md px-1.5 py-0.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800',
  muted: 'text-slate-400',
} as const;

const count = (n: number) => n.toLocaleString('en-US');
const short = (n: number) => (n >= 1000 ? `${n / 1000}K` : String(n));

// 지켜보는 것 — 'mass deletes ≥ 1K/min · bursts ≥ 1K/min and 10× usual · drops and renames'
const rulesText = (rules: AlertsReport['rules']): string | null => {
  const parts = [
    rules.deletes > 0 ? `mass deletes ≥ ${short(rules.deletes)}/min` : null,
    rules.burst > 0 ? `bursts ≥ ${short(rules.burst)}/min and 10× usual` : null,
    rules.drops ? 'drops and renames' : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(' · ') : null;
};

const detailOf = (a: MonitorAlert): string => {
  switch (a.kind) {
    case 'mass-delete':
      return `${count(a.count)} deletes · up to ${count(a.peak)} in a minute`;
    case 'burst':
      return `${count(a.count)} writes · up to ${count(a.peak)} in a minute${a.usual !== null ? ` · usually ${count(a.usual)}/min` : ''}`;
    case 'drop':
      return a.count > 1 ? `${a.collections.slice(0, 4).join(', ')}${a.count > 4 ? ` +${count(a.count - 4)}` : ''}` : 'Collection dropped';
    case 'drop-database':
      return a.count > 0 ? `${count(a.count)} collection${a.count === 1 ? '' : 's'} dropped with it` : 'Database dropped';
    case 'rename':
      return 'Collection renamed';
  }
};

// 09:14 / 09:14–09:17 — 긴 기간이면 날짜도
const timeOf = (a: MonitorAlert, withDate: boolean): string => {
  const day = withDate ? `${fmtDate(a.start)} ` : '';
  const sameMinute = Math.floor(a.start / 60_000) === Math.floor(a.end / 60_000);
  if (sameMinute) return `${day}${fmtClock(a.start)}`;
  const endDay = withDate && fmtDate(a.end) !== fmtDate(a.start) ? `${fmtDate(a.end)} ` : '';
  return `${day}${fmtClock(a.start)}–${endDay}${fmtClock(a.end)}`;
};

function useAlerts(range: MonitorRange, scope: MonitorScope) {
  const key = `${range}\u0000${scope.database ?? ''}\u0000${scope.collection ?? ''}`;
  const { report, loaded, refreshing, setReport } = useCachedReport<AlertsReport>('alerts', key);
  const [failed, setFailed] = useState<string | null>(null);
  const query = useRef({ range, scope });
  query.current = { range, scope };

  useEffect(() => {
    setFailed(null);
  }, [key]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const every = LIVE_RANGES.includes(range) ? LIVE_POLL_MS : LONG_POLL_MS;
    const tick = async () => {
      clearTimeout(timer);
      if (document.hidden) return; // 다시 보일 때 visibilitychange가 이어 간다
      try {
        const q = query.current;
        const next = await api.getAlerts({ database: q.scope.database, collection: q.scope.collection, range: q.range });
        if (!alive) return;
        setFailed(null);
        setReport(next);
      } catch (e) {
        if (alive) setFailed(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer = setTimeout(tick, every);
    };
    const onVisible = () => {
      if (!document.hidden && alive) void tick();
    };
    void tick();
    document.addEventListener('visibilitychange', onVisible);
    // 새 알림 — 바로 다시(서버가 막 연 건을 보여 준다)
    const off = api.onAlert(() => {
      if (alive) void tick();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      off();
    };
  }, [key, range, setReport]);

  return { report, loaded, failed, refreshing };
}

interface AlertsCardProps {
  scope: MonitorScope;
  range: MonitorRange;
  onScopeChange: (scope: MonitorScope) => void;
}

export function AlertsCard({ scope, range, onScopeChange }: AlertsCardProps) {
  const { report, loaded, failed, refreshing } = useAlerts(range, scope);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [range, scope.database, scope.collection]);

  if (failed && !report) {
    return (
      <p className={styles.quiet}>
        <CircleAlert size={14} className="shrink-0 text-slate-400" /> Could not load alerts: {failed}
      </p>
    );
  }
  // 처음 한 번 — 한 줄 자리를 미리 잡아 아래가 밀리지 않게
  if (!loaded) {
    return (
      <p className={styles.quiet} aria-label="Alerts">
        <SkeletonLine className="h-3.5 w-3.5 shrink-0 rounded-full" />
        <SkeletonLine className="w-2/3" />
      </p>
    );
  }
  if (!report || report.status === 'closed') return null;

  const live = LIVE_RANGES.includes(range);
  const inRange = RANGE_LABEL[range].replace(/^Last /, 'the last ').replace('All history', 'all history');
  const rules = rulesText(report.rules);
  const memoryOnly = !report.stored && !live ? ' · history is off, so only the last hour is kept' : '';

  if (report.alerts.length === 0) {
    return (
      <p className={styles.quiet} aria-label="Alerts">
        {rules ? (
          <>
            <ShieldCheck size={14} className="shrink-0 text-emerald-500" />
            <span className="min-w-0 truncate" data-tt={`Watching for ${rules}`}>
              No alerts in {inRange}
              <span className={styles.muted}> · watching for {rules}{memoryOnly}</span>
            </span>
            <RefreshSpinner show={refreshing} />
          </>
        ) : (
          <>
            <BellRing size={14} className="shrink-0 text-slate-400" />
            <span>Alerts are off — turn them on in Settings › Monitor</span>
          </>
        )}
      </p>
    );
  }

  const rows = expanded ? report.alerts : report.alerts.slice(0, FIRST_ROWS);
  const hidden = report.alerts.length - rows.length;

  return (
    <section className={styles.card} aria-label="Alerts">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className={styles.title}>Alerts<RefreshSpinner show={refreshing} /></h3>
        <span className={styles.sub}>
          {count(report.alerts.length + report.more)} in {inRange}
          {rules ? ` · watching for ${rules}` : ' · new alerts are off'}
          {memoryOnly} — click one to focus on it
        </span>
      </div>
      <div className="flex flex-col">
        {rows.map((a) => {
          const focus = () => onScopeChange(alertFocus(a));
          return (
            <div key={a.id} className={styles.row} role="button" tabIndex={0} onClick={focus} onKeyDown={(e) => e.key === 'Enter' && focus()}>
              <span className={cn(styles.pill, PILL[a.kind])}>{ALERT_LABEL[a.kind]}</span>
              <span className={styles.target} data-tt={a.kind === 'drop' && a.count > 1 ? a.collections.join(', ') : undefined}>
                {alertTarget(a)}
              </span>
              <span className={styles.time}>
                {a.filled && (
                  <span className={styles.badge} data-tt="Found while loading writes made when no tab had this connection open">
                    while away
                  </span>
                )}
                {a.ongoing && (
                  <span className="inline-flex items-center gap-1 text-amber-600" data-tt="Still going — another crossing within 5 minutes joins this alert">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                    ongoing
                  </span>
                )}
                {timeOf(a, !live)}
              </span>
              <span className={styles.detail}>{detailOf(a)}</span>
            </div>
          );
        })}
      </div>
      {report.alerts.length > FIRST_ROWS && (
        <button type="button" className={styles.more} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show ${count(hidden)} more`}
          {expanded && report.more > 0 ? ` · ${count(report.more)} older not listed` : ''}
        </button>
      )}
    </section>
  );
}
