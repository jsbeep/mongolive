// Monitor › Collections › Time spent (9-6c) — 서버가 컬렉션마다 쓴 시간(admin top, 서버가 10초마다 읽어 1시간 메모리에 둔다)
//   서버/DB 범위: 시간이 많은 컬렉션 순 — 읽기·쓰기 막대, 읽기·쓰기 횟수, 작업당 평균. 행을 누르면 그 컬렉션으로 좁힌다
//   컬렉션 범위: 작업 종류별(find·getMore·insert·update·delete·commands) 횟수·시간·평균
//   5m·1h만 숫자를 보여 준다(긴 기간은 안내 한 줄). 10초마다 묻는다(탭이 안 보이면 쉼). top이 없거나(mongos) 권한이 없으면 카드를 숨긴다
import { useCachedReport } from '../../hooks/useCachedReport';
import { RefreshSpinner } from '../common/Skeleton';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, Loader2 } from 'lucide-react';
import type { CollectionTopRow, MonitorRange, TopOp, TopReport, TopUsage } from '../../types/explorer';
import { LIVE_RANGES } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { fmtClock, fmtDateTime, fmtDuration, fmtMs, fmtNumber, memoryRange, rangePhrase } from './format';
import type { MonitorScope } from './ScopeBar';

const POLL_MS = 10_000;
const FIRST_ROWS = 10;
const READ_COLOR = 'var(--chart-1)';
const WRITE_COLOR = 'var(--chart-2)';

const OP_LABEL: { op: TopOp; label: string; tip: string }[] = [
  { op: 'queries', label: 'Find', tip: 'find commands' },
  { op: 'getmore', label: 'Get more', tip: 'Fetching the next batch of a cursor' },
  { op: 'insert', label: 'Insert', tip: 'insert commands — one per command, however many documents' },
  { op: 'update', label: 'Update', tip: 'update commands' },
  { op: 'remove', label: 'Delete', tip: 'delete commands' },
  { op: 'commands', label: 'Commands', tip: 'aggregate, count, distinct, findAndModify, index builds, collStats …' },
];

const styles = {
  card: 'flex min-w-0 flex-col gap-2 rounded-xl border border-slate-200/70 bg-white px-3.5 pb-3 pt-3',
  title: 'text-[13px] font-semibold text-slate-800',
  sub: 'text-[11px] text-slate-500',
  legend: 'flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-slate-500',
  note: 'flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-slate-500',
  table: 'w-full border-collapse text-[12px]',
  th: 'px-2 py-1.5 text-left text-[11px] font-medium text-slate-500',
  tr: 'cursor-pointer border-t border-slate-100 transition-colors hover:bg-slate-50',
  td: 'px-2 py-1.5 align-middle text-slate-700',
  num: 'text-right tabular-nums',
  muted: 'text-slate-400',
  more: 'self-start rounded-md px-1.5 py-0.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800',
} as const;

// µs → 850 µs / 12 ms / 4.2 s / 1h 5m
export const fmtMicros = (us: number): string => {
  if (us < 1000) return `${Math.round(us)} µs`;
  const ms = us / 1000;
  return ms < 600_000 ? fmtMs(ms) : fmtDuration(ms);
};
const avgOf = (u: TopUsage) => (u.count > 0 ? fmtMicros(u.time / u.count) : '—');

function useTop(range: MonitorRange, scope: MonitorScope) {
  const [failed, setFailed] = useState<string | null>(null);
  // 긴 기간이면 1h로 물어 상태(지원·권한)만 본다 — 서버 메모리라 MongoDB에는 묻지 않는다
  const live = LIVE_RANGES.includes(range);
  const query = useRef({ range: memoryRange(range), scope });
  query.current = { range: memoryRange(range), scope };
  const key = `${query.current.range}\u0000${scope.database ?? ''}\u0000${scope.collection ?? ''}`;
  const { report, refreshing, setReport } = useCachedReport<TopReport>('top', key);

  useEffect(() => {
    setFailed(null);
  }, [key]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.hidden) return; // 다시 보일 때 visibilitychange가 이어 간다
      try {
        const q = query.current;
        const next = await api.getTop({ database: q.scope.database, collection: q.scope.collection, range: q.range });
        if (!alive) return;
        setFailed(null);
        setReport(next);
      } catch (e) {
        if (alive) setFailed(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
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
  }, [key, setReport]);

  return { report, failed, refreshing };
}

// 읽기·쓰기 시간 비율 — 0인 쪽은 그리지 않는다
function SplitBar({ row, wide = false }: { row: CollectionTopRow; wide?: boolean }) {
  const total = row.read.time + row.write.time;
  if (total === 0) return <span className={styles.muted}>—</span>;
  const parts = [
    { key: 'read', label: 'Reads', usage: row.read, color: READ_COLOR },
    { key: 'write', label: 'Writes', usage: row.write, color: WRITE_COLOR },
  ].filter((p) => p.usage.time > 0);
  return (
    <div className={cn('flex w-full gap-[2px]', wide ? 'h-2.5' : 'h-2 min-w-[80px]')} role="img" aria-label={parts.map((p) => `${p.label} ${fmtMicros(p.usage.time)}`).join(', ')}>
      {parts.map((p) => (
        <span
          key={p.key}
          className="h-full rounded-full"
          style={{ width: `${(p.usage.time / total) * 100}%`, background: p.color, minWidth: 2 }}
          data-tt={`${p.label} ${fmtMicros(p.usage.time)} (${Math.round((p.usage.time / total) * 100)}%) · ${fmtNumber(p.usage.count)} ops`}
        />
      ))}
    </div>
  );
}

function Legend() {
  return (
    <div className={styles.legend}>
      {[{ label: 'Reads', color: READ_COLOR }, { label: 'Writes', color: WRITE_COLOR }].map((l) => (
        <span key={l.label} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-full" style={{ background: l.color }} aria-hidden="true" />
          {l.label}
        </span>
      ))}
    </div>
  );
}

interface TopCardProps {
  scope: MonitorScope;
  range: MonitorRange;
  onScopeChange: (scope: MonitorScope) => void;
}

export function TopCard({ scope, range, onScopeChange }: TopCardProps) {
  const { report, failed, refreshing } = useTop(range, scope);
  const [showAll, setShowAll] = useState(false);
  const live = LIVE_RANGES.includes(range);
  const atCollection = scope.database !== null && scope.collection !== null;

  if (!report) {
    return failed ? <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Could not load time spent: {failed}</p> : null;
  }
  // top이 없거나(mongos·일부 Atlas 등급) 권한이 없거나 피드가 없음 — 카드를 숨긴다
  if (report.status !== 'ok' && report.status !== 'error') return null;

  const header = (sub: ReactNode, legend: boolean) => (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="min-w-0">
        <h3 className={styles.title}>Time spent<RefreshSpinner show={refreshing} /></h3>
        <p className={styles.sub}>{sub}</p>
      </div>
      {legend && <Legend />}
    </div>
  );
  const source = (
    <span data-tt="From the server's top counters on the member mongolive is connected to (usually the primary) — reads on secondaries aren't counted. mongolive's own queries are included.">
      server time (top)
    </span>
  );

  if (!live) {
    return (
      <section className={styles.card} aria-label="Time spent">
        {header(<>Read and write {source} per collection</>, false)}
        <p className={cn(styles.muted, 'text-[12px]')}>Kept for the last hour only — switch the range to 5m, 30m or 1h to see it.</p>
      </section>
    );
  }

  const inRange = rangePhrase(memoryRange(range));
  const since = report.since;
  const sinceText = since === null ? null : <span data-tt={fmtDateTime(since)}>{fmtClock(since)}</span>;
  const errorNote = report.status === 'error' && (
    <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Could not read top just now: {report.error} — showing what was read before.</p>
  );
  const waiting = since === null && (
    <p className={cn(styles.muted, 'flex items-center gap-2 py-3 text-[12px]')}><Loader2 size={13} className="animate-spin" /> Waiting for the second reading (about 10 s)…</p>
  );
  const empty = since !== null && report.rows.length === 0 && (
    <p className={cn(styles.muted, 'py-4 text-center text-[12px]')}>No reads or writes {atCollection ? 'on this collection ' : ''}since {sinceText}.</p>
  );

  if (atCollection) {
    const row = report.rows[0];
    return (
      <section className={styles.card} aria-label="Time spent">
        {header(<>Read and write {source} on this collection since {sinceText ?? '…'}{since !== null && ` (${inRange})`}</>, Boolean(row))}
        {errorNote}
        {waiting}
        {empty}
        {row && (
          <>
            <p className="text-[12px] text-slate-600">
              <span className="font-medium text-slate-800">{fmtMicros(row.total.time)}</span> over {fmtNumber(row.total.count)} {row.total.count === 1 ? 'operation' : 'operations'} · avg {avgOf(row.total)}
              <span className={styles.muted}> · reads {fmtMicros(row.read.time)} ({fmtNumber(row.read.count)}) · writes {fmtMicros(row.write.time)} ({fmtNumber(row.write.count)})</span>
            </p>
            <SplitBar row={row} wide />
            <div className="overflow-x-auto">
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th}>Operation</th>
                    <th className={cn(styles.th, 'text-right')}>Count</th>
                    <th className={cn(styles.th, 'text-right')}>Time</th>
                    <th className={cn(styles.th, 'text-right')}>Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {OP_LABEL.map(({ op, label, tip }) => {
                    const u = row.ops[op];
                    return (
                      <tr key={op} className="border-t border-slate-100">
                        <td className={styles.td}><span data-tt={tip}>{label}</span></td>
                        <td className={cn(styles.td, styles.num, u.count === 0 && styles.muted)}>{fmtNumber(u.count)}</td>
                        <td className={cn(styles.td, styles.num, u.count === 0 && styles.muted)}>{u.count === 0 ? '—' : fmtMicros(u.time)}</td>
                        <td className={cn(styles.td, styles.num, u.count === 0 && styles.muted)}>{avgOf(u)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    );
  }

  const rows = showAll ? report.rows : report.rows.slice(0, FIRST_ROWS);
  const hiddenRows = report.rows.length - rows.length;
  return (
    <section className={styles.card} aria-label="Time spent">
      {header(<>Read and write {source} per collection since {sinceText ?? '…'}{since !== null && ` (${inRange})`} — click a row to focus on it</>, report.rows.length > 0)}
      {errorNote}
      {waiting}
      {empty}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Collection</th>
                <th className={cn(styles.th, 'text-right')}>Time</th>
                <th className={cn(styles.th, 'w-[28%]')}>Reads · writes</th>
                <th className={cn(styles.th, 'text-right')}>Reads</th>
                <th className={cn(styles.th, 'text-right')}>Writes</th>
                <th className={cn(styles.th, 'text-right')} data-tt="Time per operation">Avg</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const focus = () => onScopeChange({ database: row.database, collection: row.collection });
                return (
                  <tr key={`${row.database}.${row.collection}`} className={styles.tr} onClick={focus} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && focus()}>
                    <td className={cn(styles.td, 'font-medium')}>
                      {scope.database ? row.collection : <><span className={styles.muted}>{row.database}.</span>{row.collection}</>}
                    </td>
                    <td className={cn(styles.td, styles.num)}>{fmtMicros(row.total.time)}</td>
                    <td className={styles.td}><SplitBar row={row} /></td>
                    <td className={cn(styles.td, styles.num, row.read.count === 0 && styles.muted)}>{fmtNumber(row.read.count)}</td>
                    <td className={cn(styles.td, styles.num, row.write.count === 0 && styles.muted)}>{fmtNumber(row.write.count)}</td>
                    <td className={cn(styles.td, styles.num)}>{avgOf(row.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {report.rows.length > FIRST_ROWS && (
        <div className="flex items-center gap-2">
          <button type="button" className={styles.more} onClick={() => setShowAll((v) => !v)}>
            {hiddenRows > 0 ? `Show all ${report.rows.length}` : `Show top ${FIRST_ROWS}`}
          </button>
          {showAll && report.more > 0 && <span className={cn(styles.muted, 'text-[11px]')}>· {fmtNumber(report.more)} quieter collections not listed</span>}
        </div>
      )}
    </section>
  );
}
