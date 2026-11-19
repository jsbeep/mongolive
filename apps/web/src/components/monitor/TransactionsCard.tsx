// Monitor › Collections › Transactions (9-8b) — 서버가 changeStream 이벤트로 센 트랜잭션(최근 1시간 메모리만, DB에 묻지 않는다)
//   분당 개수 · 트랜잭션 하나의 쓰기 수(평균·최대) · 자주 같이 쓰인 컬렉션 · 큰 것
//   범위(DB·컬렉션) = 그 범위를 건드린 트랜잭션. 트랜잭션이 없거나 피드가 없으면 숨긴다
//   긴 기간이면 1h로 묻고 'last hour only'라고 적는다. 5m·1h는 10초마다, 긴 기간은 60초마다(탭이 안 보이면 쉼)
import { useCachedReport } from '../../hooks/useCachedReport';
import { RefreshSpinner } from '../common/Skeleton';
import { useEffect, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { MonitorPeriod, TransactionsReport, TransactionSample } from '../../types/explorer';
import { isLiveRange, isWindow } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { fmtClock, fmtNumber, memoryRange, rangePhrase } from './format';
import type { MonitorScope } from './ScopeBar';

const LIVE_POLL_MS = 10_000;
const LONG_POLL_MS = 60_000;

const styles = {
  card: 'flex min-w-0 flex-col gap-2 rounded-xl border border-slate-200/70 bg-white px-3.5 pb-3 pt-3',
  title: 'text-[13px] font-semibold text-slate-800',
  sub: 'text-[11px] text-slate-500',
  note: 'flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-slate-500',
  grid: 'grid min-w-0 gap-x-6 gap-y-3 md:grid-cols-2',
  heading: 'mb-1 text-[11px] font-medium text-slate-500',
  list: 'flex min-w-0 flex-col',
  row: 'grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 border-t border-slate-100 py-1.5 first:border-t-0',
  name: 'min-w-0 truncate font-mono text-[12px] text-slate-700',
  num: 'text-right text-[11px] tabular-nums text-slate-500',
  detail: 'col-span-2 truncate text-[11px] text-slate-500',
  muted: 'text-slate-400',
} as const;

const plural = (n: number, word: string) => `${fmtNumber(n)} ${word}${n === 1 ? '' : 's'}`;
// 0.7/min · 12/min
const rate = (n: number) => (n > 0 && n < 10 ? n.toFixed(1) : fmtNumber(Math.round(n)));

function useTransactions(range: MonitorPeriod, scope: MonitorScope) {
  const [failed, setFailed] = useState<string | null>(null);
  const live = isLiveRange(range);
  const asked = memoryRange(range);
  const query = useRef({ range: asked, scope });
  query.current = { range: asked, scope };
  const key = `${asked}\u0000${scope.database ?? ''}\u0000${scope.collection ?? ''}`;
  const { report, refreshing, setReport } = useCachedReport<TransactionsReport>('transactions', key);

  useEffect(() => {
    setFailed(null);
  }, [key]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const every = live ? LIVE_POLL_MS : LONG_POLL_MS;
    const tick = async () => {
      clearTimeout(timer);
      if (document.hidden) return; // 다시 보일 때 visibilitychange가 이어 간다
      try {
        const q = query.current;
        const next = await api.getTransactions({ database: q.scope.database, collection: q.scope.collection, range: q.range });
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
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, live, setReport]);

  return { report, failed, refreshing };
}

interface TransactionsCardProps {
  scope: MonitorScope;
  range: MonitorPeriod;
}

export function TransactionsCard({ scope, range }: TransactionsCardProps) {
  const { report, failed, refreshing } = useTransactions(range, scope);

  if (failed && !report) {
    return (
      <p className={styles.note}>
        <CircleAlert size={14} className="mt-0.5 shrink-0" /> Could not load transactions: {failed}
      </p>
    );
  }
  if (!report || report.status !== 'ok' || report.count === 0) return null;

  // 날짜로 찾기(C2) — 서버 메모리 1시간뿐이라 지난 구간은 없다
  if (isWindow(range)) {
    return (
      <section className={styles.card} aria-label="Transactions">
        <h3 className={styles.title}>Transactions</h3>
        <p className={cn(styles.muted, 'text-[12px]')}>Kept for the last hour only — switch the range to 5m, 30m or 1h to see them.</p>
      </section>
    );
  }

  const live = isLiveRange(range);
  const inRange = rangePhrase(memoryRange(range));
  // 범위의 DB 안이면 컬렉션 이름만
  const label = (ns: string) => (scope.database && ns.startsWith(`${scope.database}.`) ? ns.slice(scope.database.length + 1) : ns);
  const avg = report.writes / report.count;
  const opsOf = (s: TransactionSample) =>
    [s.ops.insert ? plural(s.ops.insert, 'insert') : '', s.ops.update ? plural(s.ops.update, 'update') : '', s.ops.delete ? plural(s.ops.delete, 'delete') : '']
      .filter(Boolean)
      .join(', ');

  return (
    <section className={styles.card} aria-label="Transactions">
      <div className="min-w-0">
        <h3 className={styles.title}>Transactions<RefreshSpinner show={refreshing} /></h3>
        <p className={styles.sub}>
          {fmtNumber(report.count)} in {inRange}
          {!live && <span className="font-medium text-slate-600"> (last hour only)</span>} · {rate(report.perMinute)}/min · {avg < 10 ? avg.toFixed(1) : fmtNumber(Math.round(avg))} writes on average, up to {fmtNumber(report.maxWrites)}
          <span className={styles.muted}> — from the change stream, kept in memory for an hour</span>
        </p>
      </div>
      {report.partial && (
        <p className={styles.note}>
          <CircleAlert size={14} className="mt-0.5 shrink-0" /> Some minutes had too many different collection sets to keep apart — numbers for this scope may be low.
        </p>
      )}
      <div className={styles.grid}>
        <div className="min-w-0">
          <h4 className={styles.heading}>Collections written together</h4>
          <div className={styles.list}>
            {report.combos.map((c) => {
              const name = c.namespaces.map(label).join(' + ') + (c.more ? ` +${c.more}` : '');
              return (
                <div key={c.namespaces.join('\u0001') + c.more} className={styles.row}>
                  <span className={styles.name} title={c.namespaces.join(' + ')}>{name}</span>
                  <span className={styles.num}>
                    {plural(c.count, 'transaction')} <span className={styles.muted}>· {plural(c.writes, 'write')}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="min-w-0">
          <h4 className={styles.heading}>Largest</h4>
          <div className={styles.list}>
            {report.largest.map((s, i) => {
              const where = s.namespaces.map((n) => `${label(n.ns)} ${fmtNumber(n.writes)}`).join(' · ') + (s.more ? ` · +${s.more} more` : '');
              return (
                <div key={`${s.at}:${i}`} className={styles.row}>
                  <span className={cn(styles.name, 'text-slate-800')}>{plural(s.writes, 'write')}</span>
                  <span className={styles.num}>{fmtClock(s.at, true)}</span>
                  <span className={styles.detail} title={where}>
                    {where}
                    <span className={styles.muted}> · {opsOf(s)}</span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
