// Monitor › Operations › 느린 쿼리 (9-5b) — MongoDB가 스스로 로그에 남긴 "Slow query"를 서버가 10초마다 모은 것.
// 같은 모양의 쿼리끼리 묶어 합계·횟수·평균·최대를 보여 주고, 펼치면 분마다 가장 느린 실행과 그 명령을 본다.
// 범위 바의 기간과 스코프(DB/컬렉션)가 적용된다. 칩은 화면 필터 — 서버 기준(slowms)보다 낮게는 의미가 없어 막는다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Loader2 } from 'lucide-react';
import { LIVE_RANGES, SLOW_THRESHOLDS, type MonitorRange, type SlowGroup, type SlowQueriesReport, type SlowRun, type SlowThreshold } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { fmtAgo, fmtClock, fmtDateTime, fmtMs, fmtNumber, RANGE_LABEL } from './format';
import { durationTone, Fact, HiddenKinds, KindChips, opStyles as styles, PlanBadge, pretty, useKindFilter, type OpKind } from './opParts';
import type { MonitorScope } from './ScopeBar';

// 서버가 10초마다 로그를 읽는다 — 짧은 기간은 그 박자로, 긴 기간은 1분마다
const LIVE_POLL_MS = 10_000;
const FILE_POLL_MS = 60_000;
const DEFAULT_SLOWMS = 100;

type SortKey = 'total' | 'count' | 'avg' | 'max' | 'last';
const SORTS: Record<SortKey, (g: SlowGroup) => number> = {
  total: (g) => g.totalMs,
  count: (g) => g.count,
  avg: (g) => g.totalMs / g.count,
  max: (g) => g.maxMs,
  last: (g) => g.last,
};

const thresholdLabel = (t: number) => (t >= 1000 ? `${t / 1000}s` : `${t}ms`);

// 서버가 이보다 빠른 건 로그에 안 남긴다 — 그보다 낮은 칩은 다음 칩과 똑같이 보인다
const floorOf = (slowms: number | null): SlowThreshold =>
  [...SLOW_THRESHOLDS].reverse().find((t) => t <= (slowms ?? DEFAULT_SLOWMS)) ?? SLOW_THRESHOLDS[0];

// 실행당 평균 — 많이 뒤져서 조금 돌려주면 인덱스 후보
const perRun = (g: SlowGroup) => ({ examined: g.docsExamined / g.count, returned: g.returned / g.count });
const wasteful = (g: SlowGroup) => {
  const { examined, returned } = perRun(g);
  return examined >= 1000 && examined >= 100 * Math.max(returned, 1);
};

const KIND_LABEL = { user: 'Your apps', mongolive: 'mongolive', system: 'Internal' } as const;
// 종류 칩 툴팁 — 숫자는 느린 실행 횟수
const KIND_TIPS: Record<OpKind, string> = {
  user: 'Slow runs from other apps and shells',
  mongolive: 'Slow runs from mongolive itself — your Explorer queries and aggregations, and its own reads',
  system: 'MongoDB’s internal work — TTL deletes, replication',
};

function SlowDetail({ group }: { group: SlowGroup }) {
  // 처음엔 가장 느린 실행의 명령
  const slowest = useMemo(() => group.runs.reduce<SlowRun | null>((a, r) => (!a || r.ms > a.ms ? r : a), null), [group.runs]);
  // 고른 실행 — 10초마다 새 보고서가 와도 남게 시각·걸린 시간으로 기억한다
  const [picked, setPicked] = useState<string | null>(null);
  const idOf = (r: SlowRun) => `${r.at}|${r.ms}`;
  const run = group.runs.find((r) => idOf(r) === picked) ?? slowest;
  const scan = group.plan?.startsWith('COLLSCAN');

  return (
    <div className={styles.detail}>
      <div className={styles.facts}>
        <Fact label="Query hash" value={group.queryHash} />
        <Fact label="From" value={KIND_LABEL[group.kind]} />
        <Fact label="Docs examined" value={fmtNumber(group.docsExamined)} />
        <Fact label="Keys examined" value={fmtNumber(group.keysExamined)} />
        <Fact label="Returned" value={fmtNumber(group.returned)} />
        <Fact label="Plan" value={group.plan} />
      </div>
      {scan && (
        <p className="mt-2 text-[11.5px] text-amber-800">
          COLLSCAN reads every document in the collection — an index on the filtered or sorted fields usually fixes this.
        </p>
      )}
      <p className={styles.preLabel}>Runs · the slowest of each minute is kept</p>
      <div className="mt-1 max-h-48 overflow-auto rounded-lg bg-white ring-1 ring-slate-200/70">
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Finished</th>
              <th className={cn(styles.th, 'text-right')}>Took</th>
              <th className={styles.th}>Client</th>
              <th className={cn(styles.th, 'text-right')}>Examined</th>
              <th className={cn(styles.th, 'text-right')}>Returned</th>
            </tr>
          </thead>
          <tbody>
            {group.runs.map((r, i) => (
              <tr
                key={`${r.at}-${i}`}
                className={cn(styles.tr, r === run && 'bg-slate-100/70')}
                onClick={() => setPicked(idOf(r))}
                aria-selected={r === run}
              >
                <td className={cn(styles.td, 'whitespace-nowrap tabular-nums')}>{fmtDateTime(r.at)}</td>
                <td className={cn(styles.td, 'whitespace-nowrap text-right tabular-nums', durationTone(r.ms))}>{fmtMs(r.ms)}</td>
                <td className={cn(styles.td, 'max-w-[14rem] truncate')} data-tt={r.client ?? undefined}>
                  {r.app ?? r.client ?? <span className={styles.muted}>internal</span>}
                </td>
                <td className={cn(styles.td, 'text-right tabular-nums')}>{r.docsExamined !== null ? fmtNumber(r.docsExamined) : '—'}</td>
                <td className={cn(styles.td, 'text-right tabular-nums')}>{r.returned !== null ? fmtNumber(r.returned) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {run?.command && (
        <>
          <p className={styles.preLabel}>
            Command · {fmtDateTime(run.at)} · {fmtMs(run.ms)}
          </p>
          <pre className={styles.pre}>{pretty(run.command)}</pre>
        </>
      )}
    </div>
  );
}

export function SlowQueries({ scope, range }: { scope: MonitorScope; range: MonitorRange }) {
  const [report, setReport] = useState<SlowQueriesReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [min, setMin] = useState<SlowThreshold>(SLOW_THRESHOLDS[0]);
  const kindFilter = useKindFilter();
  const [sort, setSort] = useState<SortKey>('total');
  const [open, setOpen] = useState<string | null>(null);
  const scopeKey = `${scope.database ?? ''}\u0000${scope.collection ?? ''}`;
  const queryRef = useRef({ scope, range, min, open });
  queryRef.current = { scope, range, min, open };

  // 떠 있는 동안 서버가 로그를 10초마다 읽는다(9-10)
  useEffect(() => api.watchSlowCard(), []);

  useEffect(() => {
    setReport(null);
    setOpen(null);
  }, [scopeKey, range]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const every = LIVE_RANGES.includes(range) ? LIVE_POLL_MS : FILE_POLL_MS;
    const tick = async () => {
      if (document.hidden) return; // 다시 보일 때 visibilitychange가 이어 간다
      try {
        const q = queryRef.current;
        // 펼친 그룹에만 명령이 실려 온다 — 펼치면 바로 다시 받는다
        const next = await api.getSlowQueries({ database: q.scope.database, collection: q.scope.collection, range: q.range, min: q.min, expand: q.open });
        if (!alive) return;
        setFailed(null);
        if (next) {
          setReport(next);
          // 서버 기준보다 낮은 칩에 있으면 기준으로 올린다
          const floor = floorOf(next.slowms);
          if (q.min < floor) setMin(floor);
        }
      } catch (e) {
        if (alive) setFailed(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer = setTimeout(tick, every);
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
  }, [scopeKey, range, min, open]);

  const slowms = report?.slowms ?? null;
  const floor = floorOf(slowms);
  const groups = report?.groups ?? [];
  const kindCounts = { user: 0, mongolive: 0, system: 0 };
  for (const g of groups) kindCounts[g.kind] += g.count;
  const shown = groups
    .filter((g) => kindFilter.kinds.has(g.kind))
    .sort((a, b) => SORTS[sort](b) - SORTS[sort](a));
  const where = scope.collection ? `${scope.database}.${scope.collection}` : scope.database ? `the ${scope.database} database` : 'this server';
  const missedLines = report?.missed.reduce((n, m) => n + m.lines, 0) ?? 0;
  const status = report?.status;

  const sortHead = (key: SortKey, label: string, tip: string) => (
    <th className={cn(styles.th, 'text-right')}>
      <button type="button" className={cn('hover:text-slate-800', sort === key && 'text-slate-800')} onClick={() => setSort(key)} data-tt={tip} aria-pressed={sort === key}>
        {label}
        {sort === key ? ' ↓' : ''}
      </button>
    </th>
  );

  return (
    <div className={cn(styles.body, 'border-t border-slate-100 pt-4')}>
      <div className={styles.toolbar}>
        <div className="flex min-w-0 flex-col">
          <h2 className={styles.title}>Slow queries{report && status === 'ok' ? ` · ${shown.length} shape${shown.length === 1 ? '' : 's'}` : ''}</h2>
          <span className={styles.sub} data-tt="Read from MongoDB’s own log on the node mongolive is connected to (usually the primary) — every 10 s while this card is open, 30 s otherwise, 60 s when no tab is visible. mongolive never changes slowms.">
            Finished operations MongoDB logged as slower than {slowms ?? DEFAULT_SLOWMS} ms{slowms === null && report ? ' (default)' : ''} · {RANGE_LABEL[range]}
            {report ? ` · ${fmtClock(report.at, true)}` : ''}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1" role="group" aria-label="Hide faster than">
            {SLOW_THRESHOLDS.map((t) => {
              const below = t < floor;
              return (
                <button
                  key={t}
                  type="button"
                  disabled={below}
                  aria-pressed={min === t}
                  className={cn(styles.chip, min === t ? styles.chipOn : styles.chipOff, below && 'cursor-not-allowed opacity-40 hover:text-slate-400')}
                  onClick={() => setMin(t)}
                  data-tt={below ? `MongoDB only logs operations slower than ${slowms} ms (its slowms)` : t === floor ? 'Everything MongoDB logged' : `Hide runs faster than ${thresholdLabel(t)}`}
                >
                  ≥ {thresholdLabel(t)}
                </button>
              );
            })}
          </div>
          <KindChips filter={kindFilter} counts={kindCounts} tips={KIND_TIPS} />
        </div>
      </div>

      {failed && (
        <p className={styles.error}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {failed}
        </p>
      )}
      {status === 'denied' && (
        <p className={styles.error}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Can’t read MongoDB’s log — the user needs the getLog privilege (e.g. the clusterMonitor role).
        </p>
      )}
      {status === 'unsupported' && (
        <p className={styles.note}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
          This MongoDB writes its log as plain text (before 4.4) — slow queries can’t be read from it.
        </p>
      )}
      {status === 'error' && report?.error && (
        <p className={styles.error}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {report.error}
        </p>
      )}
      {status === 'closed' && <p className={styles.note}>Slow queries are read while this connection is open in a tab.</p>}
      {status === 'off' && <p className={styles.note}>Slow query collection is off (Settings › Monitor) — MongoDB’s log isn’t read. Earlier records are still shown.</p>}
      {missedLines > 0 && (
        <p className={styles.note} data-tt={report?.missed.map((m) => `${fmtDateTime(m.from)} – ${fmtClock(m.to)} · ${fmtNumber(m.lines)} lines`).join('\n')}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
          MongoDB’s log moved faster than mongolive reads it — about {fmtNumber(missedLines)} log lines went by unseen in {report?.missed.length === 1 ? 'one stretch' : `${report?.missed.length} stretches`}, so some slow queries may be missing.
        </p>
      )}
      {report && !report.stored && !LIVE_RANGES.includes(range) && (
        <p className={styles.note}>History is off (Settings › Monitor) — slow queries are kept for the last hour only.</p>
      )}

      {!report && !failed ? (
        <div className="flex items-center gap-2 px-1 py-6 text-[13px] text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading…
        </div>
      ) : report && (status === 'ok' || status === 'closed' || status === 'off') && (
        <div className={styles.card}>
          {shown.length === 0 ? (
            <div className={styles.empty}>
              <p>
                No slow queries on {where} — {RANGE_LABEL[range].toLowerCase()}.
                {report.hidden > 0 ? ` ${fmtNumber(report.hidden)} faster than ${thresholdLabel(min)} hidden.` : ' With small data they’re rare.'}
              </p>
              <HiddenKinds filter={kindFilter} counts={kindCounts} />
            </div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  {sortHead('total', 'Total', 'Time spent in all runs together')}
                  {sortHead('count', 'Runs', 'How many times it ran slow')}
                  {sortHead('avg', 'Avg', 'Average time per slow run')}
                  {sortHead('max', 'Max', 'The slowest run')}
                  <th className={styles.th}>Op</th>
                  <th className={styles.th}>Namespace</th>
                  <th className={styles.th}>Query</th>
                  <th className={styles.th}>Plan</th>
                  <th className={cn(styles.th, 'text-right')} data-tt="Documents examined → returned, per run on average (updates and deletes: matched)">Examined → returned</th>
                  {sortHead('last', 'Last', 'When it last ran slow')}
                </tr>
              </thead>
              <tbody>
                {shown.map((g) => {
                  const isOpen = open === g.key;
                  const { examined, returned } = perRun(g);
                  return (
                    <SlowRow key={g.key} group={g} isOpen={isOpen} now={report.at} onToggle={() => setOpen(isOpen ? null : g.key)} examined={examined} returned={returned} />
                  );
                })}
              </tbody>
            </table>
          )}
          {shown.length > 0 && report.hidden > 0 && (
            <p className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400">
              {fmtNumber(report.hidden)} run{report.hidden === 1 ? '' : 's'} faster than {thresholdLabel(min)} hidden
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SlowRow({ group: g, isOpen, now, onToggle, examined, returned }: { group: SlowGroup; isOpen: boolean; now: number; onToggle: () => void; examined: number; returned: number }) {
  return (
    <>
      <tr className={styles.tr} onClick={onToggle} aria-expanded={isOpen}>
        <td className={cn(styles.td, 'whitespace-nowrap text-right tabular-nums')}>
          <span className="inline-flex items-center gap-1">
            <ChevronRight className={cn('h-3 w-3 text-slate-400 transition-transform', isOpen && 'rotate-90')} />
            {fmtMs(g.totalMs)}
          </span>
        </td>
        <td className={cn(styles.td, 'text-right tabular-nums')}>{fmtNumber(g.count)}</td>
        <td className={cn(styles.td, 'whitespace-nowrap text-right tabular-nums')}>{fmtMs(g.totalMs / g.count)}</td>
        <td className={cn(styles.td, 'whitespace-nowrap text-right tabular-nums', durationTone(g.maxMs))}>{fmtMs(g.maxMs)}</td>
        <td className={cn(styles.td, 'whitespace-nowrap')}>{g.op}</td>
        <td className={cn(styles.td, styles.mono, 'max-w-[12rem] truncate')} data-tt={g.ns}>{g.ns}</td>
        <td className={cn(styles.td, styles.mono, 'max-w-[26rem] truncate')} data-tt={g.summary}>{g.summary || <span className={styles.muted}>—</span>}</td>
        <td className={cn(styles.td, 'whitespace-nowrap')}><PlanBadge plan={g.plan} /></td>
        <td className={cn(styles.td, 'whitespace-nowrap text-right tabular-nums', wasteful(g) && 'font-medium text-amber-700')} data-tt={wasteful(g) ? 'Reads far more documents than it returns — an index could help' : undefined}>
          {fmtNumber(examined)} → {fmtNumber(returned)}
        </td>
        <td className={cn(styles.td, 'whitespace-nowrap text-right tabular-nums')} data-tt={fmtDateTime(g.last)}>{fmtAgo(g.last, now)}</td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={10} className="p-0">
            <SlowDetail group={g} />
          </td>
        </tr>
      )}
    </>
  );
}
