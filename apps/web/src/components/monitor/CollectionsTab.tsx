// Monitor › Collections (9-2) — changeStream으로 본 쓰기를 컬렉션별로.
//   범위 = 서버 전체 / DB:  분당 쓰기 차트 + 컬렉션 표(쓰기 수 · 작업 비율 · 추세 · 마지막 쓰기). 행을 누르면 그 컬렉션으로 좁힌다
//   범위 = 컬렉션:        분당 쓰기 차트 + 자주 바뀐 필드 · 자주 바뀐 문서(누르면 Explorer에서 연다)
// 서버가 피드를 연 뒤부터 센 것이라 그 전은 모른다 — 'since'를 늘 보여 준다. 10초마다 다시 받는다.
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, CircleAlert, Loader2 } from 'lucide-react';
import type { ActivityCollection, ActivityOps, ActivityRange, CollectionSummary } from '../../types/explorer';
import { api } from '../../services/api';
import { useActivity } from '../../hooks/useActivity';
import { cn } from '../../utils/cn';
import { TimeChart, Sparkline, type ChartSeries } from './charts';
import { chartWindow, fmtAgo, fmtClock, fmtNumber } from './format';
import type { MonitorScope } from './ScopeBar';

const MINUTE = 60_000;
const OPS: { key: keyof ActivityOps; label: string; color: string }[] = [
  { key: 'insert', label: 'Insert', color: 'var(--chart-1)' },
  { key: 'update', label: 'Update', color: 'var(--chart-2)' },
  { key: 'replace', label: 'Replace', color: 'var(--chart-3)' },
  { key: 'delete', label: 'Delete', color: 'var(--chart-4)' },
];

const styles = {
  body: 'flex flex-col gap-4 px-4 pb-5 pt-3',
  toolbar: 'flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-slate-500',
  segmented: 'inline-flex rounded-lg bg-slate-100 p-0.5',
  segment: 'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
  segmentOn: 'bg-white text-slate-800 shadow-soft',
  segmentOff: 'text-slate-500 hover:text-slate-700',
  card: 'flex min-w-0 flex-col gap-2 rounded-xl border border-slate-200/70 bg-white px-3.5 pb-3 pt-3',
  cardTitle: 'text-[13px] font-semibold text-slate-800',
  cardSub: 'text-[11px] text-slate-500',
  legend: 'flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-slate-500',
  table: 'w-full border-collapse text-[12px]',
  th: 'px-2 py-1.5 text-left text-[11px] font-medium text-slate-500',
  sortBtn: 'inline-flex items-center gap-1 hover:text-slate-800',
  tr: 'cursor-pointer border-t border-slate-100 transition-colors hover:bg-slate-50',
  td: 'px-2 py-1.5 align-middle text-slate-700',
  num: 'text-right tabular-nums',
  muted: 'text-slate-400',
  note: 'flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-slate-500',
  waiting: 'flex items-center gap-2 px-1 py-10 text-[13px] text-slate-400',
  grid: 'grid grid-cols-1 gap-3 lg:grid-cols-2',
  rankRow: 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-slate-100 py-1.5 first:border-t-0',
  rankLabel: 'min-w-0 truncate font-mono text-[12px] text-slate-700',
  rankValue: 'text-right text-[12px] font-medium tabular-nums text-slate-700',
  openBtn: 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800',
} as const;

const sumOps = (ops: ActivityOps) => ops.insert + ops.update + ops.replace + ops.delete;

// 작업 비율 — 얇은 막대(글자 없이, 숫자는 옆 칸·툴팁). 0인 작업은 그리지 않는다, 사이는 2px 틈
function MixBar({ ops }: { ops: ActivityOps }) {
  const total = sumOps(ops);
  if (total === 0) return <span className={styles.muted}>—</span>;
  return (
    <div className="flex h-2 w-full min-w-[80px] gap-[2px]" role="img" aria-label={OPS.map((o) => `${o.label} ${ops[o.key]}`).join(', ')}>
      {OPS.filter((o) => ops[o.key] > 0).map((o) => (
        <span
          key={o.key}
          className="h-2 rounded-full"
          style={{ width: `${(ops[o.key] / total) * 100}%`, background: o.color, minWidth: 2 }}
          data-tt={`${o.label} ${ops[o.key].toLocaleString()} (${Math.round((ops[o.key] / total) * 100)}%)`}
        />
      ))}
    </div>
  );
}

function OpsLegend({ swatch }: { swatch: 'line' | 'bar' }) {
  return (
    <div className={styles.legend}>
      {OPS.map((o) => (
        <span key={o.key} className="inline-flex items-center gap-1.5">
          {swatch === 'bar'
            ? <span className="h-2 w-3 rounded-full" style={{ background: o.color }} aria-hidden="true" />
            : <span className="h-[2px] w-3 rounded-full" style={{ background: o.color }} aria-hidden="true" />}
          {o.label}
        </span>
      ))}
    </div>
  );
}

// 순위 막대(한 색) — 자주 바뀐 필드·문서
function RankList({ items, color, onOpen }: { items: { key: string; label: string; count: number }[]; color: string; onOpen?: (key: string) => void }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="flex flex-col">
      {items.map((item) => (
        <div key={item.key} className={styles.rankRow}>
          <span className="flex min-w-0 items-center gap-2">
            <span className={styles.rankLabel} data-tt={item.label}>{item.label}</span>
            {onOpen && (
              <button type="button" className={styles.openBtn} onClick={() => onOpen(item.key)} data-tt="Open this document in Explorer">
                Open <ArrowUpRight size={11} />
              </button>
            )}
          </span>
          <span className={styles.rankValue}>{item.count.toLocaleString()}</span>
          <span className="col-span-2 h-1 rounded-full bg-slate-100">
            <span className="block h-1 rounded-full" style={{ width: `${(item.count / max) * 100}%`, background: color }} />
          </span>
        </div>
      ))}
    </div>
  );
}

type SortKey = 'name' | 'writes' | 'last';

interface CollectionsTabProps {
  scope: MonitorScope;
  onScopeChange: (scope: MonitorScope) => void;
  explorerDatabase: string | null;
  explorerCollections: CollectionSummary[];
  onOpenDocument: (database: string, collection: string, documentId: string) => void;
}

export function CollectionsTab({ scope, onScopeChange, explorerDatabase, explorerCollections, onOpenDocument }: CollectionsTabProps) {
  const [range, setRange] = useState<ActivityRange>('1h');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'writes', desc: true });
  const { report, loading, error, now } = useActivity(true, scope, range);
  const atCollection = scope.database !== null && scope.collection !== null;

  // DB 범위면 쓰기가 없던 컬렉션도 표에 넣는다(0, 마지막 쓰기 모름) — 그 DB의 목록이 필요하다
  const [dbCollections, setDbCollections] = useState<{ database: string; list: CollectionSummary[] } | null>(null);
  useEffect(() => {
    const database = scope.database;
    if (!database || atCollection || database === explorerDatabase) return;
    if (dbCollections?.database === database) return;
    let cancelled = false;
    void api.getCollections(database).then((list) => !cancelled && setDbCollections({ database, list })).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [scope.database, atCollection, explorerDatabase, dbCollections?.database]);

  const rows = useMemo((): ActivityCollection[] => {
    if (!report || atCollection) return [];
    const list = scope.database === null ? [] : scope.database === explorerDatabase ? explorerCollections : dbCollections?.database === scope.database ? dbCollections.list : [];
    const seen = new Set(report.collections.map((c) => c.collection));
    const minutes = report.timeline.length;
    const idle = list
      .filter((c) => !seen.has(c.name))
      .map((c): ActivityCollection => ({ database: scope.database as string, collection: c.name, total: 0, ops: { insert: 0, update: 0, replace: 0, delete: 0 }, trend: Array(minutes).fill(0), lastWrite: null }));
    const all = [...report.collections, ...idle];
    const dir = sort.desc ? -1 : 1;
    const nameOf = (c: ActivityCollection) => (scope.database ? c.collection : `${c.database}.${c.collection}`);
    return all.sort((a, b) => {
      if (sort.key === 'name') return dir * nameOf(a).localeCompare(nameOf(b));
      if (sort.key === 'last') return dir * ((a.lastWrite?.at ?? 0) - (b.lastWrite?.at ?? 0));
      return dir * (a.total - b.total) || (b.lastWrite?.at ?? 0) - (a.lastWrite?.at ?? 0);
    });
  }, [report, atCollection, scope.database, explorerDatabase, explorerCollections, dbCollections, sort]);

  // 분당 쓰기 차트 — 아직 안 끝난 지금 1분은 빼고(덜 센 값이 '뚝 떨어진' 것처럼 보이지 않게)
  const chart = useMemo(() => {
    if (!report) return null;
    const currentMinute = Math.floor(now / MINUTE) * MINUTE;
    const done = report.timeline.filter((t) => t.at < currentMinute);
    const series: ChartSeries[] = OPS.map((o) => ({ key: o.key, label: o.label, color: o.color, values: done.map((t) => t.ops[o.key]) }));
    return { times: done.map((t) => t.at), series };
  }, [report, now]);

  if (!report) {
    return error
      ? <p className={cn(styles.note, 'm-4')}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Could not load activity: {error}</p>
      : <p className={cn(styles.waiting, 'px-4')}><Loader2 size={15} className="animate-spin" /> {loading ? 'Loading activity…' : 'No data'}</p>;
  }

  const windowMs = range === '5m' ? 5 * MINUTE : chartWindow(report.since, now).ms;
  const sortHeader = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => {
    const on = sort.key === key;
    return (
      <th className={cn(styles.th, align === 'right' && 'text-right')} aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
        <button type="button" className={styles.sortBtn} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}>
          {label}
          {on && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
        </button>
      </th>
    );
  };
  const target = atCollection ? report.collections[0] ?? null : null;

  return (
    <div className={styles.body}>
      <div className={styles.toolbar}>
        <div className={styles.segmented} role="radiogroup" aria-label="Time range">
          {(['5m', '1h'] as const).map((r) => (
            <button key={r} type="button" role="radio" aria-checked={range === r} className={cn(styles.segment, range === r ? styles.segmentOn : styles.segmentOff)} onClick={() => setRange(r)}>
              {r === '5m' ? 'Last 5 min' : 'Last hour'}
            </button>
          ))}
        </div>
        <span data-tt="mongolive counts writes from its change stream while a tab uses this connection — earlier writes aren't known">
          Counting since <span className="font-medium text-slate-700">{fmtClock(report.since)}</span>
        </span>
        <span className={styles.muted}>· updates every 10s</span>
      </div>

      {chart && (
        <TimeChart
          title="Writes per minute"
          subtitle={`${scope.collection ?? scope.database ?? 'All databases'} · finished minutes only`}
          times={chart.times}
          series={chart.series}
          format={fmtNumber}
          windowMs={windowMs}
          now={now}
          gapMs={1.5 * MINUTE}
          emptyText="No finished minute yet"
        />
      )}

      {!atCollection ? (
        <section className={styles.card} aria-label="Collections by writes">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h3 className={styles.cardTitle}>{scope.database ? `Collections in ${scope.database}` : 'Collections written to'}</h3>
              <p className={styles.cardSub}>
                {scope.database
                  ? `Writes in the ${range === '5m' ? 'last 5 minutes' : 'last hour'} — click a row to focus on it`
                  : `Only collections written to since ${fmtClock(report.since)} are listed — click a row to focus on it`}
              </p>
            </div>
            <OpsLegend swatch="bar" />
          </div>
          {rows.length === 0 ? (
            <p className={cn(styles.muted, 'py-6 text-center text-[12px]')}>No writes seen since {fmtClock(report.since)}.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className={styles.table}>
                <thead>
                  <tr>
                    {sortHeader('name', 'Collection')}
                    {sortHeader('writes', 'Writes', 'right')}
                    <th className={cn(styles.th, 'w-[28%]')}>Mix</th>
                    <th className={cn(styles.th, 'w-[16%]')}>Trend</th>
                    {sortHeader('last', 'Last write', 'right')}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={`${row.database}.${row.collection}`}
                      className={styles.tr}
                      onClick={() => onScopeChange({ database: row.database, collection: row.collection })}
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && onScopeChange({ database: row.database, collection: row.collection })}
                    >
                      <td className={cn(styles.td, 'font-medium')}>
                        {scope.database ? row.collection : <><span className={styles.muted}>{row.database}.</span>{row.collection}</>}
                      </td>
                      <td className={cn(styles.td, styles.num)}>{row.total ? row.total.toLocaleString() : <span className={styles.muted}>0</span>}</td>
                      <td className={styles.td}><MixBar ops={row.ops} /></td>
                      <td className={styles.td}>{row.total > 0 ? <Sparkline values={row.trend} label={`${row.collection} writes per minute`} /> : <span className={styles.muted}>—</span>}</td>
                      <td className={cn(styles.td, styles.num)}>
                        {row.lastWrite
                          ? <span data-tt={`${row.lastWrite.op} at ${fmtClock(row.lastWrite.at, true)}`}>{fmtAgo(row.lastWrite.at, now)} <span className={styles.muted}>· {row.lastWrite.op}</span></span>
                          : <span className={styles.muted}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <>
          <p className={styles.toolbar}>
            {target?.lastWrite
              ? <>Last write <span className="font-medium text-slate-700">{fmtAgo(target.lastWrite.at, now)} ago</span> ({target.lastWrite.op}, {fmtClock(target.lastWrite.at, true)}) · {fmtNumber(target.total)} writes in the {range === '5m' ? 'last 5 minutes' : 'last hour'}</>
              : <>No writes seen since {fmtClock(report.since)}.</>}
          </p>
          {report.partial && (
            <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Too many different fields or documents — some weren't counted. The totals above are still complete.</p>
          )}
          <div className={styles.grid}>
            <section className={styles.card} aria-label="Most changed fields">
              <div>
                <h3 className={styles.cardTitle}>Most changed fields</h3>
                <p className={styles.cardSub}>Paths in updates — array positions grouped as [] · replace and insert have no paths</p>
              </div>
              {report.fields?.length ? (
                <RankList items={report.fields.map((f) => ({ key: f.path, label: f.path, count: f.count }))} color="var(--chart-2)" />
              ) : <p className={cn(styles.muted, 'py-4 text-center text-[12px]')}>No updates in this range.</p>}
            </section>
            <section className={styles.card} aria-label="Most written documents">
              <div>
                <h3 className={styles.cardTitle}>Most written documents</h3>
                <p className={styles.cardSub}>Inserts, updates, replaces and deletes per document</p>
              </div>
              {report.documents?.length ? (
                <RankList
                  items={report.documents.map((d) => ({ key: d.id, label: d.id, count: d.count }))}
                  color="var(--chart-1)"
                  onOpen={(id) => scope.database && scope.collection && onOpenDocument(scope.database, scope.collection, id)}
                />
              ) : <p className={cn(styles.muted, 'py-4 text-center text-[12px]')}>No writes in this range.</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

