// 지표 (레거시 PerformanceMetrics) — 레거시는 무작위로 늘어나는 가짜 숫자였다. 여기선 실제 값:
//   실시간: 스트림 상태, 최근 60초 초당 이벤트 수, DB→서버 지연(p50/p95/max), 브라우저↔서버 왕복
//   MongoDB: serverStatus — 버전·가동 시간·연결 수·메모리, 초당 연산/네트워크(두 번 받은 누적값의 차이)
// 패널이 열려 있는 동안에만 3초마다 받는다.
import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Loader2 } from 'lucide-react';
import { api } from '../../services/api';
import type { ClientMetrics } from '../../services/dataSource';
import { cn } from '../../utils/cn';

const POLL_MS = 3000;
const OPS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const;

interface Rates {
  ops: Record<string, number>;
  netInKBs: number;
  netOutKBs: number;
}

const styles = {
  body: 'flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-4',
  section: 'flex flex-col gap-2',
  sectionTitle: 'text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400',
  grid: 'grid grid-cols-3 gap-2',
  tile: 'flex flex-col gap-0.5 rounded-xl bg-slate-50 px-3 py-2 min-w-0',
  tileLabel: 'text-[11px] text-slate-500 truncate',
  tileValue: 'text-sm font-semibold text-slate-800 tabular-nums truncate',
  tileSub: 'text-[11px] text-slate-400 tabular-nums truncate',
  status: 'flex items-center gap-1.5 text-xs font-medium',
  chartWrap: 'rounded-xl bg-slate-50 px-3 pt-2 pb-1.5',
  chartHead: 'flex items-baseline justify-between text-[11px] text-slate-500',
  opsTable: 'grid grid-cols-3 gap-x-3 gap-y-1 rounded-xl bg-slate-50 px-3 py-2 text-xs',
  opName: 'text-slate-500',
  opValue: 'text-right font-mono tabular-nums text-slate-800',
  note: 'rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500',
} as const;

const formatUptime = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};
const fmtRate = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {sub && <span className={styles.tileSub}>{sub}</span>}
    </div>
  );
}

// 초당 이벤트 수 막대(최근 60초, 왼쪽이 오래된 것). 한 계열이라 범례 없이 제목이 이름 역할.
// 막대 사이 2px 간격, 바닥에 붙은 둥근 윗면, 칸 전체가 hover 영역(막대보다 넓게).
function EventsSparkline({ values }: { values: number[] }) {
  const W = 360;
  const H = 44;
  const slot = W / values.length;
  const barW = Math.max(1, slot - 2);
  const max = Math.max(1, ...values);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-11" role="img" aria-label="Events per second, last 60 seconds">
      <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} className="stroke-slate-200" strokeWidth={1} />
      {values.map((v, i) => {
        const h = v === 0 ? 0 : Math.max(2, (v / max) * (H - 4));
        const secondsAgo = values.length - 1 - i;
        return (
          <g key={i} data-tt={`${v} event${v === 1 ? '' : 's'} · ${secondsAgo === 0 ? 'now' : `${secondsAgo}s ago`}`} data-tt-side="top">
            <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
            {h > 0 && <rect x={i * slot + 1} y={H - h} width={barW} height={h} rx={Math.min(2, barW / 2)} className="fill-sky-400" />}
          </g>
        );
      })}
    </svg>
  );
}

export function MetricsTab() {
  const [metrics, setMetrics] = useState<ClientMetrics | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prevRef = useRef<ClientMetrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.getMetrics();
        if (cancelled || !next) return;
        const prev = prevRef.current;
        // 누적값의 차이 ÷ 경과 시간 = 초당 값 (서버가 재시작돼 줄어들면 건너뜀)
        if (prev?.mongo.opcounters && next.mongo.opcounters) {
          const dt = (next.at - prev.at) / 1000;
          if (dt > 0) {
            const ops: Record<string, number> = {};
            for (const op of OPS) ops[op] = Math.max(0, ((next.mongo.opcounters[op] ?? 0) - (prev.mongo.opcounters[op] ?? 0)) / dt);
            const netIn = next.mongo.network && prev.mongo.network ? (next.mongo.network.bytesIn - prev.mongo.network.bytesIn) / dt / 1024 : 0;
            const netOut = next.mongo.network && prev.mongo.network ? (next.mongo.network.bytesOut - prev.mongo.network.bytesOut) / dt / 1024 : 0;
            setRates({ ops, netInKBs: Math.max(0, netIn), netOutKBs: Math.max(0, netOut) });
          }
        }
        prevRef.current = next;
        setMetrics(next);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load metrics');
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!metrics) {
    return (
      <div className={styles.body}>
        {error ? <p className={styles.note}>{error}</p> : <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={14} className="animate-spin" /> Loading metrics…</p>}
      </div>
    );
  }

  const { realtime, mongo } = metrics;
  const running = realtime.status.state === 'running';
  const last60 = realtime.eventsPerSecond.reduce((a, b) => a + b, 0);

  return (
    <div className={styles.body}>
      {error && <p className={styles.note}>Last refresh failed: {error}</p>}

      <section className={styles.section}>
        <div className="flex items-center justify-between">
          <h3 className={styles.sectionTitle}>Realtime</h3>
          {/* 상태는 아이콘 + 글자로 — 색만으로 구분하지 않는다 */}
          <span className={cn(styles.status, running ? 'text-emerald-600' : realtime.status.state === 'error' ? 'text-rose-600' : 'text-amber-600')}>
            {running ? <CircleCheck size={13} /> : realtime.status.state === 'error' ? <CircleAlert size={13} /> : <Loader2 size={13} className="animate-spin" />}
            {running ? 'Change stream running' : realtime.status.state === 'error' ? 'Change stream error' : 'Connecting'}
          </span>
        </div>
        {realtime.status.error && <p className={styles.note}>{realtime.status.error}</p>}

        <div className={styles.chartWrap}>
          <div className={styles.chartHead}>
            <span>Events per second · last 60s</span>
            <span className="font-mono tabular-nums text-slate-700">{last60} total</span>
          </div>
          <EventsSparkline values={realtime.eventsPerSecond} />
        </div>

        <div className={styles.grid}>
          <Tile label="DB → server" value={realtime.lag ? `${realtime.lag.p50} ms` : '—'} sub={realtime.lag ? `p95 ${realtime.lag.p95} · max ${realtime.lag.max}` : 'no events yet'} />
          <Tile label="Browser ↔ server" value={metrics.rttMs === null ? '—' : `${metrics.rttMs} ms`} sub="round trip" />
          <Tile label="Events" value={realtime.eventsTotal.toLocaleString()} sub="since server start" />
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>MongoDB server</h3>
        {mongo.error ? (
          <p className={styles.note}>{mongo.error}</p>
        ) : (
          <>
            <div className={styles.grid}>
              <Tile label="Version" value={mongo.version ?? '—'} sub={mongo.uptimeSec !== undefined ? `up ${formatUptime(mongo.uptimeSec)}` : undefined} />
              <Tile label="Connections" value={mongo.connections ? String(mongo.connections.current) : '—'} sub={mongo.connections ? `of ${mongo.connections.available + mongo.connections.current}` : undefined} />
              {mongo.memResidentMb !== undefined ? (
                <Tile label="Memory" value={`${mongo.memResidentMb} MB`} sub="resident" />
              ) : (
                <Tile label="Network" value={rates ? `${fmtRate(rates.netInKBs)} KB/s` : '—'} sub={rates ? `out ${fmtRate(rates.netOutKBs)} KB/s` : 'measuring…'} />
              )}
            </div>
            <div className={styles.opsTable}>
              {OPS.map((op) => (
                <div key={op} className="contents">
                  <span className={styles.opName}>{op}</span>
                  <span className={cn(styles.opValue, 'col-span-2')}>{rates ? `${fmtRate(rates.ops[op] ?? 0)} /s` : '…'}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">Operations per second across the whole MongoDB server (all clients, not only this app).</p>
          </>
        )}
      </section>
    </div>
  );
}
