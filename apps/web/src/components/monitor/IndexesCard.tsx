// Monitor › Collections › Indexes (9-6b) — 컬렉션 하나로 좁혔을 때. 인덱스마다 키·쓰인 횟수·언제부터 셌나·크기
//   열 때와 새로고침 버튼을 누를 때만 묻는다(기록 없음). 쓰인 횟수는 연결된 멤버(보통 primary)의 카운터 — 재시작하면 0부터
//   0회인 인덱스는 Unused로 표시(_id·unique·TTL·숨김·만드는 중은 빼고 — 쿼리 말고도 하는 일이 있거나 일부러 안 쓰는 것)
import { useCachedReport } from '../../hooks/useCachedReport';
import { useEffect, useState } from 'react';
import { CircleAlert, Loader2, RefreshCw } from 'lucide-react';
import type { IndexesReport, IndexUsageRow } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { fmtBytes, fmtClock, fmtDateTime, fmtDuration, fmtNumber } from './format';

const styles = {
  card: 'flex min-w-0 flex-col gap-2 rounded-xl border border-slate-200/70 bg-white px-3.5 pb-3 pt-3',
  title: 'text-[13px] font-semibold text-slate-800',
  sub: 'text-[11px] text-slate-500',
  iconBtn: 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50',
  note: 'flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-slate-500',
  table: 'w-full border-collapse text-[12px]',
  th: 'px-2 py-1.5 text-left text-[11px] font-medium text-slate-500',
  td: 'px-2 py-1.5 align-middle text-slate-700',
  num: 'text-right tabular-nums',
  muted: 'text-slate-400',
  badge: 'rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-500',
  unused: 'rounded bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-700',
} as const;

// 쿼리가 안 썼어도 하는 일이 있거나(unique·TTL) 일부러 안 쓰는(숨김) 것은 Unused로 안 친다
export const isUnused = (row: IndexUsageRow) =>
  row.ops === 0 && row.name !== '_id_' && !row.unique && row.ttl === null && !row.hidden && !row.building;

const fmtKey = (key: IndexUsageRow['key']) =>
  `{ ${Object.entries(key).map(([field, v]) => `${field}: ${typeof v === 'string' ? `'${v}'` : v}`).join(', ')} }`;

// 86400 → 1d, 5400 → 90m — 나누어떨어지는 가장 큰 단위
const fmtTtl = (sec: number) => {
  if (sec === 0) return 'TTL at date';
  const [n, unit] = sec % 86400 === 0 ? [sec / 86400, 'd'] : sec % 3600 === 0 ? [sec / 3600, 'h'] : sec % 60 === 0 ? [sec / 60, 'm'] : [sec, 's'];
  return `TTL ${fmtNumber(n)}${unit}`;
};

export function IndexesCard({ database, collection }: { database: string; collection: string }) {
  // 지난 응답을 기억해 둔다 — 탭을 바꿔 다시 와도 바로 그린다(새로 받는 동안 ⟳ 버튼이 돈다)
  const { report, setReport } = useCachedReport<IndexesReport>('indexes', `${database}\u0000${collection}`);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [kick, setKick] = useState(0);

  useEffect(() => {
    setFailed(null);
  }, [database, collection]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getIndexes(database, collection)
      .then(
        (next) => {
          if (!alive) return;
          setReport(next);
          setFailed(null);
        },
        (e: unknown) => alive && setFailed(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [database, collection, kick, setReport]);

  if (!report) {
    return failed ? <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Could not load indexes: {failed}</p> : null;
  }

  const { rows } = report;
  const unused = rows.filter(isUnused);
  // 모두가 안 쓰인 게 확실한 구간 = 가장 늦게 세기 시작한 것부터
  const unusedSince = unused.reduce<number | null>((latest, r) => (r.since === null ? latest : latest === null ? r.since : Math.max(latest, r.since)), null);
  const totalSize = rows.reduce((sum, r) => sum + (r.size ?? 0), 0);

  return (
    <section className={styles.card} aria-label="Indexes">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className={styles.title}>Indexes</h3>
          <p className={styles.sub}>
            {rows.length === 1 ? '1 index' : `${rows.length} indexes`}
            {totalSize > 0 && <> · {fmtBytes(totalSize)} on disk</>} · checked <span data-tt={fmtDateTime(report.at)}>{fmtClock(report.at)}</span>
          </p>
        </div>
        <button type="button" className={styles.iconBtn} onClick={() => setKick((k) => k + 1)} disabled={loading} aria-label="Refresh indexes" data-tt="Check again (listIndexes, $indexStats, collStats)">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {report.error && <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> {report.error}</p>}
      {report.usageError && <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> {report.usageError}</p>}
      {unused.length > 0 && (
        <p className={styles.note}>
          <CircleAlert size={14} className="mt-0.5 shrink-0 text-amber-600" />
          <span>
            {unused.length === 1 ? '1 index has' : `${unused.length} indexes have`} not been used
            {unusedSince !== null && <> in the last {fmtDuration(Date.now() - unusedSince)} (since {fmtDateTime(unusedSince)})</>}. An unused index still takes disk space and adds
            work to every write. Counts cover only the member mongolive reads from and restart with the server — check the other members and a full business cycle before dropping one.
          </span>
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Index</th>
                <th className={styles.th}>Key</th>
                <th className={cn(styles.th, 'text-right')} data-tt="Times a query used the index, counted on the member mongolive reads from (usually the primary)">Uses</th>
                <th className={styles.th} data-tt="When counting started — the server's last start or the index's creation">Since</th>
                <th className={cn(styles.th, 'text-right')}>Size</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name} className="border-t border-slate-100">
                  <td className={styles.td}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-slate-800">{row.name}</span>
                      {row.unique && <span className={styles.badge}>unique</span>}
                      {row.sparse && <span className={styles.badge}>sparse</span>}
                      {row.ttl !== null && <span className={styles.badge} data-tt={row.ttl === 0 ? 'Documents expire at the date in the field' : `Documents expire ${fmtNumber(row.ttl)} s after the date in the field`}>{fmtTtl(row.ttl)}</span>}
                      {row.partial !== null && <span className={styles.badge} data-tt={`Only documents matching ${row.partial}`}>partial</span>}
                      {row.hidden && <span className={styles.badge} data-tt="Hidden from the query planner — kept up to date but not used">hidden</span>}
                      {row.building && <span className={cn(styles.badge, 'bg-sky-50 text-sky-700')}>building</span>}
                    </div>
                  </td>
                  <td className={cn(styles.td, 'font-mono text-[11px] text-slate-500')}>{fmtKey(row.key)}</td>
                  <td className={cn(styles.td, styles.num)}>
                    <UsesCell row={row} />
                  </td>
                  <td className={cn(styles.td, 'whitespace-nowrap text-slate-500')}>{row.since !== null ? fmtDateTime(row.since) : <span className={styles.muted}>—</span>}</td>
                  <td className={cn(styles.td, styles.num)}>{row.size !== null ? fmtBytes(row.size) : <span className={styles.muted}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UsesCell({ row }: { row: IndexUsageRow }) {
  if (row.ops === null) return <span className={styles.muted}>—</span>;
  if (isUnused(row)) return <span className={styles.unused}>Unused</span>;
  if (row.ops === 0) {
    const why = row.unique ? 'still enforces uniqueness' : row.ttl !== null ? 'still removes expired documents' : row.hidden ? 'is hidden from the planner' : null;
    return <span className={styles.muted} data-tt={why ? `No query used it, but it ${why}` : undefined}>0</span>;
  }
  return <>{fmtNumber(row.ops)}</>;
}
