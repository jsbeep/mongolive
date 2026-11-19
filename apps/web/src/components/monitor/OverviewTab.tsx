// Monitor › Overview — 운영에서 보는 네 가지 신호를 서버 전체 기준으로.
//   처리량(초당 작업) · 지연(평균 ms) · 포화(연결 수) · 에러(asserts)  → 맨 위 숫자 타일 + 차트 8개
// 기간(범위 바):
//   5m · 1h  = 실시간 — 서버 샘플러가 10초마다 잰 칸(9-1). 타일은 '지금' 값
//   24h ~ All = 기록 파일(9-3) — 칸 평균을 그리고, 타일은 기간 평균 + 가장 높았던 값. 기록하지 않던 구간은 회색 띠
// MongoDB가 서버 전체로만 알려 주므로 범위 바의 DB·컬렉션과는 상관없다.
import { RefreshSpinner } from '../common/Skeleton';
import { useMemo, type ReactNode } from 'react';
import { CircleAlert, Loader2 } from 'lucide-react';
import type { ActivityRange, HistoryGap, HistoryPoint, HistoryRange, MonitorMetricKey, MonitorPeriod, MonitorRates, MonitorWindow, MonitorSample } from '../../types/explorer';
import { isLiveRange } from '../../types/explorer';
import type { MonitorState } from '../../hooks/useMonitor';
import { useHistory } from '../../hooks/useActivity';
import { cn } from '../../utils/cn';
import { TimeChart, Sparkline, type ChartSeries } from './charts';
import { fmtBytesRate, liveWindow, fmtDateTime, fmtDuration, fmtMs, fmtNumber, fmtSpan, fmtUptime, periodLabel } from './format';

// 타일의 추세선 — 실시간은 최근 5분(30칸)
const TREND_SAMPLES = 30;
const C = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const styles = {
  body: 'flex flex-col gap-4 px-4 pb-5 pt-3',
  info: 'flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-500',
  infoStrong: 'font-medium text-slate-700',
  banner: 'flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-amber-800',
  bannerError: 'flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-rose-700',
  note: 'flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-slate-500',
  tiles: 'grid grid-cols-2 gap-3 xl:grid-cols-4',
  tile: 'flex min-w-0 flex-col gap-1 rounded-xl border border-slate-200/70 bg-white px-3.5 pb-2 pt-3',
  tileLabel: 'text-[12px] text-slate-500',
  tileValue: 'text-xl font-semibold text-slate-900',
  tileSub: 'truncate text-[11px] text-slate-500',
  sectionTitle: 'text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400',
  grid: 'grid grid-cols-1 gap-3 lg:grid-cols-2',
  waiting: 'flex items-center gap-2 px-4 py-10 text-[13px] text-slate-400',
} as const;

const PROBLEM_TEXT = {
  denied: "This account can't read serverStatus — grant it the clusterMonitor role to see server numbers. Ping still works.",
  unreachable: "Can't reach MongoDB right now. Gaps in the charts are times it couldn't be measured.",
  error: 'Could not read serverStatus. Gaps in the charts are times it couldn’t be measured.',
} as const;

function Tile({ label, value, sub, trend }: { label: string; value: string; sub: ReactNode; trend: (number | null)[] }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileSub}>{sub}</span>
      <Sparkline values={trend} label={label} />
    </div>
  );
}

const series = (key: string, label: string, color: string, values: (number | null)[]): ChartSeries => ({ key, label, color, values });

interface Charts {
  ops: ChartSeries[];
  latency: ChartSeries[];
  docs: ChartSeries[];
  scanned: ChartSeries[];
  ping: ChartSeries[];
  events: ChartSeries[];
  connections: ChartSeries[];
  network: ChartSeries[];
}

// 차트 8개 — 실시간과 기록 파일이 같은 모양을 쓴다(값을 꺼내는 곳만 다르다)
function ChartGrid({ charts, chartProps, standalone, scansText, connectionsText, perLabel }: {
  charts: Charts;
  chartProps: Omit<Parameters<typeof TimeChart>[0], 'title' | 'series' | 'format'>;
  standalone: boolean;
  scansText: string;
  connectionsText: string;
  // '' (실시간) 또는 ' · average per 5 min'
  perLabel: string;
}) {
  return (
    <div className={styles.grid}>
      <TimeChart {...chartProps} title="Operations per second" subtitle={`Requests — one updateMany counts once${perLabel}`} series={charts.ops} format={fmtNumber} />
      <TimeChart {...chartProps} title="Average latency" subtitle={`Time MongoDB spent per operation${perLabel}`} series={charts.latency} format={fmtMs} emptyText="No operations to time" />
      <TimeChart {...chartProps} title="Documents per second" subtitle={`Documents touched — one updateMany of 100 docs counts 100${perLabel}`} series={charts.docs} format={fmtNumber} />
      <TimeChart {...chartProps} title="Scanned vs returned" subtitle={`Scanning far more than returning usually means a missing index${scansText}`} series={charts.scanned} format={fmtNumber} />
      <TimeChart {...chartProps} title="Ping & change stream lag" subtitle="mongolive server → MongoDB, and write → event received" series={charts.ping} format={fmtMs} />
      <TimeChart
        {...chartProps}
        title="Change events per second"
        subtitle={standalone ? 'No change stream on a standalone — the app refreshes on a timer instead' : 'Writes seen by mongolive’s change stream, all databases'}
        series={charts.events}
        format={fmtNumber}
        emptyText={standalone ? 'Not available on a standalone' : 'No data'}
      />
      <TimeChart {...chartProps} title="Connections" subtitle={connectionsText} series={charts.connections} format={fmtNumber} />
      <TimeChart {...chartProps} title="Network" subtitle="Bytes in and out of MongoDB, all clients" series={charts.network} format={fmtBytesRate} />
    </div>
  );
}

function ServerLine({ monitor }: { monitor: MonitorState }) {
  const { info, rttMs } = monitor;
  return (
    <div className={styles.info}>
      {info?.version && <span>MongoDB <span className={styles.infoStrong}>{info.version}</span></span>}
      {info && <span>{info.topology === 'replicaSet' ? 'Replica set' : info.topology === 'sharded' ? 'Sharded (mongos)' : info.topology === 'standalone' ? 'Standalone' : 'Unknown topology'}</span>}
      {info?.uptimeSec !== null && info?.uptimeSec !== undefined && <span>up {fmtUptime(info.uptimeSec)}</span>}
      {info?.host && <span className="font-mono text-[11px]">{info.host}</span>}
      <span>Browser ↔ server <span className={styles.infoStrong}>{rttMs === null ? '—' : `${rttMs} ms`}</span></span>
    </div>
  );
}

// ── 실시간(5m · 1h) ──

const sum = (...values: number[]) => values.reduce((a, b) => a + b, 0);
const reads = (r: MonitorRates) => r.ops.query + r.ops.getmore;
const writes = (r: MonitorRates) => r.ops.insert + r.ops.update + r.ops.delete;
const assertsOf = (r: MonitorRates) => sum(r.asserts.regular, r.asserts.warning, r.asserts.msg, r.asserts.user);

// 칸마다 값 하나 — 못 잰 칸은 null(선이 끊긴다)
const pick = (samples: MonitorSample[], fn: (s: MonitorSample) => number | null | undefined) => samples.map((s) => fn(s) ?? null);
const fromRates = (samples: MonitorSample[], fn: (r: MonitorRates) => number | null) => pick(samples, (s) => (s.rates ? fn(s.rates) : null));

function LiveOverview({ monitor, range }: { monitor: MonitorState; range: ActivityRange }) {
  const { samples, info, intervalMs, received, now } = monitor;
  const times = useMemo(() => samples.map((s) => s.at), [samples]);
  const seconds = intervalMs / 1000;

  const charts = useMemo((): Charts => ({
    ops: [
      series('reads', 'Reads', C[0], fromRates(samples, reads)),
      series('writes', 'Writes', C[1], fromRates(samples, writes)),
      series('commands', 'Commands', C[2], fromRates(samples, (r) => r.ops.command)),
    ],
    latency: [
      series('reads', 'Reads', C[0], fromRates(samples, (r) => r.latencyMs.reads)),
      series('writes', 'Writes', C[1], fromRates(samples, (r) => r.latencyMs.writes)),
      series('commands', 'Commands', C[2], fromRates(samples, (r) => r.latencyMs.commands)),
    ],
    docs: [
      series('returned', 'Returned', C[0], fromRates(samples, (r) => r.docs.returned)),
      series('inserted', 'Inserted', C[1], fromRates(samples, (r) => r.docs.inserted)),
      series('updated', 'Updated', C[2], fromRates(samples, (r) => r.docs.updated)),
      series('deleted', 'Deleted', C[3], fromRates(samples, (r) => r.docs.deleted)),
    ],
    scanned: [
      series('returned', 'Returned', C[0], fromRates(samples, (r) => r.docs.returned)),
      series('scannedDocs', 'Docs scanned', C[1], fromRates(samples, (r) => r.scannedDocs)),
      series('scannedKeys', 'Index keys scanned', C[2], fromRates(samples, (r) => r.scannedKeys)),
    ],
    ping: [
      series('ping', 'Ping', C[0], pick(samples, (s) => s.pingMs)),
      series('lag', 'Change stream lag (p95)', C[1], pick(samples, (s) => s.stream.lagP95Ms)),
    ],
    events: [series('events', 'Change events', C[0], pick(samples, (s) => (s.problem === 'unreachable' ? null : s.stream.events / seconds)))],
    connections: [series('connections', 'Connections', C[0], pick(samples, (s) => s.gauges?.connections?.current))],
    network: [
      series('in', 'In', C[0], fromRates(samples, (r) => r.network.inBps)),
      series('out', 'Out', C[1], fromRates(samples, (r) => r.network.outBps)),
    ],
  }), [samples, seconds]);

  if (!received) return <p className={styles.waiting}><Loader2 size={15} className="animate-spin" /> Waiting for the server…</p>;

  const latest = samples[samples.length - 1];
  // 타일은 가장 최근에 잰 값(차이를 낼 수 있었던 마지막 칸)
  const lastRates = [...samples].reverse().find((s) => s.rates)?.rates ?? null;
  const lastGauges = [...samples].reverse().find((s) => s.gauges)?.gauges ?? null;
  const trend = (fn: (r: MonitorRates) => number | null) => fromRates(samples.slice(-TREND_SAMPLES), fn);
  const recent = samples.slice(-TREND_SAMPLES);
  const window = liveWindow(range, samples[0]?.at, now);
  const windowMs = window.ms;

  return (
    <div className={styles.body}>
      <ServerLine monitor={monitor} />
      {latest?.problem && (
        <p className={latest.problem === 'denied' ? styles.banner : styles.bannerError} role="status">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          {PROBLEM_TEXT[latest.problem]}
        </p>
      )}
      {samples.length > 0 && !lastRates && !latest?.problem && (
        <p className={styles.waiting}><Loader2 size={15} className="animate-spin" /> Measuring — per-second numbers appear after the second sample ({seconds}s).</p>
      )}

      <div className={styles.tiles}>
        <Tile
          label="Operations"
          value={lastRates ? `${fmtNumber(sum(reads(lastRates), writes(lastRates), lastRates.ops.command))}/s` : '—'}
          sub={lastRates ? `reads ${fmtNumber(reads(lastRates))} · writes ${fmtNumber(writes(lastRates))} · commands ${fmtNumber(lastRates.ops.command)}` : 'per second, whole server'}
          trend={trend((r) => sum(reads(r), writes(r), r.ops.command))}
        />
        <Tile
          label="Read latency"
          value={lastRates?.latencyMs.reads != null ? fmtMs(lastRates.latencyMs.reads) : '—'}
          sub={`writes ${lastRates?.latencyMs.writes != null ? fmtMs(lastRates.latencyMs.writes) : '—'} · ping ${latest?.pingMs != null ? fmtMs(latest.pingMs) : '—'}`}
          trend={trend((r) => r.latencyMs.reads)}
        />
        <Tile
          label="Connections"
          value={lastGauges?.connections ? fmtNumber(lastGauges.connections.current) : '—'}
          sub={lastGauges?.connections
            ? `of ${fmtNumber(lastGauges.connections.current + lastGauges.connections.available)} · ${lastRates ? fmtNumber(lastRates.newConnections) : '—'} new/s`
            : 'open to this server'}
          trend={pick(recent, (s) => s.gauges?.connections?.current)}
        />
        <Tile
          label="Asserts"
          value={lastRates ? `${fmtNumber(assertsOf(lastRates))}/s` : '—'}
          sub={lastRates
            ? (assertsOf(lastRates) === 0 ? 'no server-side errors' : `user ${fmtNumber(lastRates.asserts.user)} · warning ${fmtNumber(lastRates.asserts.warning)} · regular ${fmtNumber(lastRates.asserts.regular)}`)
            : 'server-side errors and warnings'}
          trend={trend(assertsOf)}
        />
      </div>

      <h2 className={styles.sectionTitle}>{window.label} · whole server · live</h2>
      <ChartGrid
        charts={charts}
        chartProps={{ times, windowMs, now, gapMs: intervalMs * 2.5 }}
        standalone={info?.topology === 'standalone'}
        scansText={lastRates?.collectionScans != null ? ` · collection scans ${fmtNumber(lastRates.collectionScans)}/s` : ''}
        connectionsText={lastRates ? `${fmtNumber(lastRates.newConnections)} new per second — high and steady means clients aren’t reusing connections` : 'Open connections to this server'}
        perLabel=""
      />
    </div>
  );
}

// ── 기록 파일(24h ~ All) ──

const avg = (p: HistoryPoint, key: MonitorMetricKey) => p.avg[key] ?? null;
// 여러 지표의 합 — 하나도 없으면 null
const avgSum = (p: HistoryPoint, keys: MonitorMetricKey[]) => (keys.some((k) => p.avg[k] !== undefined) ? keys.reduce((s, k) => s + (p.avg[k] ?? 0), 0) : null);
const READ_KEYS: MonitorMetricKey[] = ['query', 'getmore'];
const WRITE_KEYS: MonitorMetricKey[] = ['insert', 'update', 'delete'];
const OPS_KEYS: MonitorMetricKey[] = [...READ_KEYS, ...WRITE_KEYS, 'command'];

// 기간 평균(칸마다 들어간 10초 칸 수로 가중)
const meanOf = (points: HistoryPoint[], fn: (p: HistoryPoint) => number | null) => {
  let total = 0;
  let weight = 0;
  for (const p of points) {
    const v = fn(p);
    if (v === null) continue;
    total += v * p.n;
    weight += p.n;
  }
  return weight ? total / weight : null;
};
const highest = (values: (number | null)[]) => values.reduce<number | null>((m, v) => (v !== null && (m === null || v > m) ? v : m), null);

const gapLabel = (g: HistoryGap) => {
  const span = `${fmtDateTime(g.from)} – ${fmtDateTime(g.to)} (${fmtDuration(g.to - g.from)})`;
  if (g.restarted || !g.ops) return `Not recording ${span} — MongoDB restarted in between, so the totals are unknown`;
  const w = g.ops.insert + g.ops.update + g.ops.delete;
  const r = g.ops.query + g.ops.getmore;
  return `Not recording ${span} — meanwhile ${w.toLocaleString()} write and ${r.toLocaleString()} read requests (whole server)`;
};

function HistoryOverview({ monitor, range, historyOff }: { monitor: MonitorState; range: HistoryRange | MonitorWindow; historyOff: boolean }) {
  const { report, loading, refreshing, error } = useHistory(true, range);
  const points = report?.points ?? [];

  const charts = useMemo((): Charts => {
    const of = (fn: (p: HistoryPoint) => number | null) => points.map(fn);
    return {
      ops: [
        series('reads', 'Reads', C[0], of((p) => avgSum(p, READ_KEYS))),
        series('writes', 'Writes', C[1], of((p) => avgSum(p, WRITE_KEYS))),
        series('commands', 'Commands', C[2], of((p) => avg(p, 'command'))),
      ],
      latency: [
        series('reads', 'Reads', C[0], of((p) => avg(p, 'latReads'))),
        series('writes', 'Writes', C[1], of((p) => avg(p, 'latWrites'))),
        series('commands', 'Commands', C[2], of((p) => avg(p, 'latCommands'))),
      ],
      docs: [
        series('returned', 'Returned', C[0], of((p) => avg(p, 'returned'))),
        series('inserted', 'Inserted', C[1], of((p) => avg(p, 'inserted'))),
        series('updated', 'Updated', C[2], of((p) => avg(p, 'updated'))),
        series('deleted', 'Deleted', C[3], of((p) => avg(p, 'deleted'))),
      ],
      scanned: [
        series('returned', 'Returned', C[0], of((p) => avg(p, 'returned'))),
        series('scannedDocs', 'Docs scanned', C[1], of((p) => avg(p, 'scannedDocs'))),
        series('scannedKeys', 'Index keys scanned', C[2], of((p) => avg(p, 'scannedKeys'))),
      ],
      ping: [
        series('ping', 'Ping', C[0], of((p) => avg(p, 'ping'))),
        series('lag', 'Change stream lag (p95)', C[1], of((p) => avg(p, 'lag'))),
      ],
      events: [series('events', 'Change events', C[0], of((p) => avg(p, 'events')))],
      connections: [series('connections', 'Connections', C[0], of((p) => avg(p, 'conns')))],
      network: [
        series('in', 'In', C[0], of((p) => avg(p, 'netIn'))),
        series('out', 'Out', C[1], of((p) => avg(p, 'netOut'))),
      ],
    };
  }, [points]);

  if (!report) {
    return error
      ? <p className={cn(styles.note, 'm-4')}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Could not load history: {error}</p>
      : loading
        ? (
            // 처음 한 번 — 차트 자리를 미리 잡는다
            <div className="grid gap-3 sm:grid-cols-2" role="status" aria-label="Loading history">
              {[0, 1, 2, 3].map((i) => <div key={i} className="h-40 animate-pulse rounded-xl bg-slate-100" />)}
            </div>
          )
        : <p className={styles.waiting}>No data</p>;
  }

  const bucket = fmtSpan(report.bucketMs);
  const total = (p: HistoryPoint) => avgSum(p, OPS_KEYS);
  const maxOf = (key: MonitorMetricKey) => highest(points.map((p) => p.max[key] ?? null));
  const opsMean = meanOf(points, total);
  const opsBusiest = highest(points.map(total));
  const readLat = meanOf(points, (p) => avg(p, 'latReads'));
  const conns = meanOf(points, (p) => avg(p, 'conns'));
  const asserts = meanOf(points, (p) => avg(p, 'asserts'));
  const assertsBusiest = highest(points.map((p) => avg(p, 'asserts')));
  const gapTime = report.gaps.reduce((s, g) => s + Math.min(g.to, report.to) - Math.max(g.from, report.from), 0);

  return (
    <div className={styles.body}>
      <ServerLine monitor={monitor} />
      {!report.ready ? (
        <p className={styles.note}><CircleAlert size={14} className="mt-0.5 shrink-0" /> Can't tell which server this is yet, so its history can't be read — try again in a moment.</p>
      ) : points.length === 0 ? (
        <p className={styles.note}>
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          {historyOff
            ? 'History is off — turn it on in Settings › Monitor. Until then only the last hour is kept, in memory.'
            : report.range === 'custom'
              ? 'No history in this window — nothing was recorded then (no tab used this connection, or it was removed by the retention or disk limit in Settings › Monitor).'
              : 'No history in this range yet. It builds up while a tab uses this connection — one line per minute.'}
        </p>
      ) : null}
      {points.length > 0 && report.coarse && (
        <p className={styles.note}>
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          The finer records from then are gone (Settings › Monitor › History keeps per-minute detail for a few days), so this window shows one point per {bucket}.
        </p>
      )}

      {points.length > 0 && (
        <>
          <div className={styles.tiles}>
            <Tile
              label="Operations"
              value={opsMean !== null ? `${fmtNumber(opsMean)}/s` : '—'}
              sub={`average · busiest ${bucket} ${opsBusiest !== null ? `${fmtNumber(opsBusiest)}/s` : '—'}`}
              trend={points.map(total)}
            />
            <Tile
              label="Read latency"
              value={readLat !== null ? fmtMs(readLat) : '—'}
              sub={`average · highest ${maxOf('latReads') !== null ? fmtMs(maxOf('latReads') as number) : '—'}`}
              trend={points.map((p) => avg(p, 'latReads'))}
            />
            <Tile
              label="Connections"
              value={conns !== null ? fmtNumber(conns) : '—'}
              sub={`average · highest ${maxOf('conns') !== null ? fmtNumber(maxOf('conns') as number) : '—'}`}
              trend={points.map((p) => avg(p, 'conns'))}
            />
            <Tile
              label="Asserts"
              value={asserts !== null ? `${fmtNumber(asserts)}/s` : '—'}
              sub={assertsBusiest ? `average · busiest ${bucket} ${fmtNumber(assertsBusiest)}/s` : 'no server-side errors'}
              trend={points.map((p) => avg(p, 'asserts'))}
            />
          </div>
          {report.gaps.length > 0 && (
            <p className={styles.note}>
              <CircleAlert size={14} className="mt-0.5 shrink-0" />
              Not recorded for {fmtDuration(gapTime)} in this range (no tab used this connection, or the mongolive server was off) — hover the grey bands for what happened meanwhile.
            </p>
          )}
        </>
      )}

      <h2 className={styles.sectionTitle}>{periodLabel(range)} · whole server · per {bucket}<RefreshSpinner show={refreshing} /></h2>
      <ChartGrid
        charts={charts}
        chartProps={{
          times: points.map((p) => p.t),
          windowMs: Math.max(report.bucketMs, report.to - report.from),
          now: report.to,
          gapMs: report.bucketMs * 1.5,
          timeFormat: report.bucketMs >= DAY_MS ? 'date' : 'datetime',
          bands: report.gaps.map((g) => ({ from: g.from, to: g.to, label: gapLabel(g) })),
        }}
        standalone={monitor.info?.topology === 'standalone'}
        scansText={maxOf('collScans') ? ` · collection scans up to ${fmtNumber(maxOf('collScans') as number)}/s` : ''}
        connectionsText={`Average per ${bucket} — up to ${maxOf('conns') !== null ? fmtNumber(maxOf('conns') as number) : '—'} at once · ${maxOf('newConns') !== null ? fmtNumber(maxOf('newConns') as number) : '—'} new/s at most`}
        perLabel={` · average per ${bucket}`}
      />
    </div>
  );
}

export function OverviewTab({ monitor, range, historyOff }: { monitor: MonitorState; range: MonitorPeriod; historyOff: boolean }) {
  if (isLiveRange(range)) return <LiveOverview monitor={monitor} range={range} />;
  return <HistoryOverview monitor={monitor} range={range} historyOff={historyOff} />;
}
