// Monitor › Collections의 크기 (9-6a) — 서버가 피드를 열 때와 1시간마다 $collStats로 잰 것
//   useSizes: 범위·기간이 바뀌면 바로, 그다음 1분마다(재는 중이면 2초마다) 묻는다. 표의 Docs·Size·Index·Growth 칸도 이걸 쓴다
//   StorageCard: 범위 합계(문서·데이터·디스크·인덱스) + 기간 첫 측정 대비 늘고 준 양 + 크기 추이 차트(24h 이상, 기록이 켜져 있을 때)
import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Loader2, RefreshCw } from 'lucide-react';
import type { MonitorRange, SizesReport, SizeStats } from '../../types/explorer';
import { LIVE_RANGES } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { TimeChart } from './charts';
import { fmtBytes, fmtBytesDelta, fmtClock, fmtDateTime, fmtNumber } from './format';
import type { MonitorScope } from './ScopeBar';

const POLL_MS = 60_000;
const MEASURING_POLL_MS = 2000;
const HOUR = 3_600_000;
const RANGE_SPAN: Partial<Record<MonitorRange, number>> = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR, '90d': 90 * 24 * HOUR };

export interface SizesState {
  report: SizesReport | null;
  failed: string | null;
  measure: () => void;
}

export function useSizes(range: MonitorRange, scope: MonitorScope): SizesState {
  const [report, setReport] = useState<SizesReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [kick, setKick] = useState(0);
  const query = useRef({ range, scope });
  query.current = { range, scope };
  const scopeKey = `${scope.database ?? ''}\u0000${scope.collection ?? ''}`;

  useEffect(() => {
    setReport(null);
  }, [scopeKey, range]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.hidden) return; // 다시 보일 때 visibilitychange가 이어 간다
      let measuring = false;
      try {
        const q = query.current;
        const next = await api.getSizes({ database: q.scope.database, collection: q.scope.collection, range: q.range });
        if (!alive) return;
        setFailed(null);
        setReport(next);
        measuring = next?.measuring ?? false;
      } catch (e) {
        if (alive) setFailed(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer = setTimeout(tick, measuring ? MEASURING_POLL_MS : POLL_MS);
    };
    const onVisible = () => {
      if (!document.hidden && alive) {
        clearTimeout(timer);
        void tick();
      }
    };
    void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [scopeKey, range, kick]);

  const measure = () => {
    void api
      .measureSizes()
      .catch(() => false)
      .then(() => setKick((k) => k + 1));
  };
  return { report, failed, measure };
}

const styles = {
  card: 'flex min-w-0 flex-col gap-3 rounded-xl border border-slate-200/70 bg-white px-3.5 pb-3 pt-3',
  title: 'text-[13px] font-semibold text-slate-800',
  sub: 'text-[11px] text-slate-500',
  iconBtn: 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50',
  stats: 'grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4',
  label: 'text-[11px] text-slate-500',
  value: 'text-[15px] font-semibold tabular-nums text-slate-800',
  delta: 'text-[11px] tabular-nums',
  note: 'flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-slate-500',
} as const;

const STATS: { key: keyof SizeStats; label: string; tip: string; format: (v: number) => string; delta: (v: number) => string }[] = [
  { key: 'count', label: 'Documents', tip: 'Document count from collection stats', format: fmtNumber, delta: (v) => (v > 0 ? `+${fmtNumber(v)}` : fmtNumber(v)) },
  { key: 'size', label: 'Data size', tip: 'Uncompressed size of the documents', format: fmtBytes, delta: fmtBytesDelta },
  { key: 'storage', label: 'On disk', tip: 'Disk space for the data — compressed, including free space MongoDB keeps for reuse', format: fmtBytes, delta: fmtBytesDelta },
  { key: 'index', label: 'Indexes', tip: 'Disk space for all indexes', format: fmtBytes, delta: fmtBytesDelta },
];

export function StorageCard({ sizes, range, scopeName }: { sizes: SizesState; range: MonitorRange; scopeName: string }) {
  const { report, failed } = sizes;
  const live = LIVE_RANGES.includes(range);
  if (!report) {
    return failed
      ? <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Could not load sizes: {failed}</p>
      : null;
  }
  if (report.status === 'closed') return null;

  const { at, measuring, total, baseAt, baseTotal } = report;
  const showDelta = baseTotal !== null && baseAt !== null && at !== null && baseAt < at;
  const collections = report.rows.length;
  const span = RANGE_SPAN[range] ?? (report.trend.length ? Math.max(HOUR, (report.trend[report.trend.length - 1].t - report.trend[0].t) * 1.05) : 24 * HOUR);
  const now = Date.now();

  return (
    <>
      <section className={styles.card} aria-label="Storage">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className={styles.title}>Storage</h3>
            <p className={styles.sub}>
              {at === null
                ? measuring ? 'Measuring collection sizes…' : 'Not measured yet'
                : <>
                    {scopeName} · {collections === 1 ? '1 collection' : `${collections.toLocaleString()} collections`} · measured{' '}
                    <span data-tt={fmtDateTime(at)}>{fmtClock(at)}</span>, then every hour while a tab uses this connection
                  </>}
            </p>
          </div>
          <button type="button" className={styles.iconBtn} onClick={sizes.measure} disabled={measuring} aria-label="Measure sizes now" data-tt="Measure now (collStats on every collection, one at a time)">
            {measuring ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        </div>

        {report.status === 'error' && (
          <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> {report.error}</p>
        )}

        {at !== null && (
          <div className={styles.stats}>
            {STATS.map((s) => {
              const diff = showDelta ? total[s.key] - (baseTotal as SizeStats)[s.key] : 0;
              return (
                <div key={s.key} className="flex min-w-0 flex-col">
                  <span className={styles.label} data-tt={s.tip}>{s.label}</span>
                  <span className={styles.value}>{s.format(total[s.key])}</span>
                  {showDelta && (
                    <span className={cn(styles.delta, diff > 0 ? 'text-amber-600' : diff < 0 ? 'text-emerald-600' : 'text-slate-400')} data-tt={`Since ${fmtDateTime(baseAt as number)} (the first measurement in this range)`}>
                      {s.delta(diff)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {at !== null && (live
          ? <p className={styles.sub}>Sizes are measured hourly — pick 24h or longer to see growth.</p>
          : !report.stored
            ? <p className={styles.sub}>History is off (Settings › Monitor) — only the latest measurement is kept, so there's no growth.</p>
            : !showDelta && <p className={styles.sub}>Only one measurement in this range so far — growth shows after the next one.</p>)}
      </section>

      {!live && report.stored && report.trend.length > 0 && (
        <TimeChart
          title="Size over time"
          subtitle={`${scopeName} · hourly while a tab used this connection`}
          times={report.trend.map((p) => p.t)}
          series={[
            { key: 'size', label: 'Data', color: 'var(--chart-1)', values: report.trend.map((p) => p.size) },
            { key: 'storage', label: 'On disk', color: 'var(--chart-2)', values: report.trend.map((p) => p.storage) },
            { key: 'index', label: 'Indexes', color: 'var(--chart-3)', values: report.trend.map((p) => p.index) },
          ]}
          format={fmtBytes}
          windowMs={span}
          now={now}
          gapMs={1.5 * HOUR}
          timeFormat="datetime"
          emptyText="No measurement in this range yet"
        />
      )}
    </>
  );
}
