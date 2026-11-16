// Monitor › Overview (9-1) — 운영에서 보는 네 가지 신호를 서버 전체 기준으로.
//   처리량(초당 작업) · 지연(평균 ms) · 포화(연결 수) · 에러(asserts)  → 맨 위 숫자 타일 + 지난 1시간 차트
// 값은 서버 샘플러가 10초마다 잰 칸(serverStatus + ping). MongoDB가 서버 전체로만 알려 주므로 범위 바와 상관없다.
import { useMemo, type ReactNode } from 'react';
import { CircleAlert, Loader2 } from 'lucide-react';
import type { MonitorRates, MonitorSample } from '../../types/explorer';
import type { MonitorState } from '../../hooks/useMonitor';
import { TimeChart, Sparkline, type ChartSeries } from './charts';
import { chartWindow, fmtBytesRate, fmtMs, fmtNumber, fmtUptime } from './format';

// 타일의 추세선 — 최근 5분(30칸)
const TREND_SAMPLES = 30;
const C = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'] as const;

const styles = {
  body: 'flex flex-col gap-4 px-4 pb-5 pt-3',
  info: 'flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-500',
  infoStrong: 'font-medium text-slate-700',
  banner: 'flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-amber-800',
  bannerError: 'flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-rose-700',
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

const sum = (...values: number[]) => values.reduce((a, b) => a + b, 0);
const reads = (r: MonitorRates) => r.ops.query + r.ops.getmore;
const writes = (r: MonitorRates) => r.ops.insert + r.ops.update + r.ops.delete;
const assertsOf = (r: MonitorRates) => sum(r.asserts.regular, r.asserts.warning, r.asserts.msg, r.asserts.user);

// 칸마다 값 하나 — 못 잰 칸은 null(선이 끊긴다)
const pick = (samples: MonitorSample[], fn: (s: MonitorSample) => number | null | undefined) => samples.map((s) => fn(s) ?? null);
const fromRates = (samples: MonitorSample[], fn: (r: MonitorRates) => number | null) => pick(samples, (s) => (s.rates ? fn(s.rates) : null));

export function OverviewTab({ monitor }: { monitor: MonitorState }) {
  const { samples, info, intervalMs, received, rttMs, now } = monitor;
  const times = useMemo(() => samples.map((s) => s.at), [samples]);
  const gapMs = intervalMs * 2.5;
  const seconds = intervalMs / 1000;

  const charts = useMemo(() => {
    const series = (key: string, label: string, color: string, values: (number | null)[]): ChartSeries => ({ key, label, color, values });
    return {
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
    };
  }, [samples, seconds]);

  if (!received) {
    return <p className={styles.waiting}><Loader2 size={15} className="animate-spin" /> Waiting for the server…</p>;
  }

  const latest = samples[samples.length - 1];
  // 타일은 가장 최근에 잰 값(차이를 낼 수 있었던 마지막 칸)
  const lastRates = [...samples].reverse().find((s) => s.rates)?.rates ?? null;
  const lastGauges = [...samples].reverse().find((s) => s.gauges)?.gauges ?? null;
  const trend = (fn: (r: MonitorRates) => number | null) => fromRates(samples.slice(-TREND_SAMPLES), fn);
  const recent = samples.slice(-TREND_SAMPLES);
  const standalone = info?.topology === 'standalone';
  const lastScans = lastRates?.collectionScans;

  const range = chartWindow(samples[0]?.at, now);
  const chartProps = { times, windowMs: range.ms, now, gapMs };

  return (
    <div className={styles.body}>
      {/* 서버 한 줄 소개 */}
      <div className={styles.info}>
        {info?.version && <span>MongoDB <span className={styles.infoStrong}>{info.version}</span></span>}
        {info && <span>{info.topology === 'replicaSet' ? 'Replica set' : info.topology === 'sharded' ? 'Sharded (mongos)' : info.topology === 'standalone' ? 'Standalone' : 'Unknown topology'}</span>}
        {info?.uptimeSec !== null && info?.uptimeSec !== undefined && <span>up {fmtUptime(info.uptimeSec)}</span>}
        {info?.host && <span className="font-mono text-[11px]">{info.host}</span>}
        <span>Browser ↔ server <span className={styles.infoStrong}>{rttMs === null ? '—' : `${rttMs} ms`}</span></span>
      </div>

      {latest?.problem && (
        <p className={latest.problem === 'denied' ? styles.banner : styles.bannerError} role="status">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          {PROBLEM_TEXT[latest.problem]}
        </p>
      )}

      {samples.length > 0 && !lastRates && !latest?.problem && (
        <p className={styles.waiting}><Loader2 size={15} className="animate-spin" /> Measuring — per-second numbers appear after the second sample ({seconds}s).</p>
      )}

      {/* 네 가지 신호 — 처리량 · 지연 · 포화 · 에러 */}
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

      <h2 className={styles.sectionTitle}>{range.label} · whole server</h2>
      <div className={styles.grid}>
        <TimeChart {...chartProps} title="Operations per second" subtitle="Requests — one updateMany counts once" series={charts.ops} format={fmtNumber} />
        <TimeChart {...chartProps} title="Average latency" subtitle="Time MongoDB spent per operation" series={charts.latency} format={fmtMs} emptyText="No operations to time yet" />
        <TimeChart {...chartProps} title="Documents per second" subtitle="Documents touched — one updateMany of 100 docs counts 100" series={charts.docs} format={fmtNumber} />
        <TimeChart
          {...chartProps}
          title="Scanned vs returned"
          subtitle={`Scanning far more than returning usually means a missing index${lastScans != null ? ` · collection scans ${fmtNumber(lastScans)}/s` : ''}`}
          series={charts.scanned}
          format={fmtNumber}
        />
        <TimeChart {...chartProps} title="Ping & change stream lag" subtitle="mongolive server → MongoDB, and write → event received" series={charts.ping} format={fmtMs} />
        <TimeChart
          {...chartProps}
          title="Change events per second"
          subtitle={standalone ? 'No change stream on a standalone — the app refreshes on a timer instead' : 'Writes seen by mongolive’s change stream, all databases'}
          series={charts.events}
          format={fmtNumber}
          emptyText={standalone ? 'Not available on a standalone' : 'No data yet'}
        />
        <TimeChart
          {...chartProps}
          title="Connections"
          subtitle={lastRates ? `${fmtNumber(lastRates.newConnections)} new per second — high and steady means clients aren’t reusing connections` : 'Open connections to this server'}
          series={charts.connections}
          format={fmtNumber}
        />
        <TimeChart {...chartProps} title="Network" subtitle="Bytes in and out of MongoDB, all clients" series={charts.network} format={fmtBytesRate} />
      </div>
    </div>
  );
}
