// Monitor › Operations (9-5a) — 지금 실행 중인 작업($currentOp). 이 탭이 보이는 동안만 2초마다 묻는다(브라우저 탭이 숨겨지면 쉰다).
// 기록하지 않는 스냅샷이라 범위 바의 기간은 여기엔 안 쓰인다. 스코프(DB/컬렉션)는 ns로 거른다.
// mongolive 자신(changeStream getMore 등)과 내부 작업은 기본으로 숨긴다. 멈추기(killOp)는 다른 클라이언트의 작업에만.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Loader2, Pause, Play } from 'lucide-react';
import { formatQueryValue, valueKind, type EjsonObject, type EjsonValue, type OperationsReport, type RunningOp } from '../../types/explorer';
import { api } from '../../services/api';
import { cn } from '../../utils/cn';
import { fmtClock, fmtMs, fmtNumber } from './format';
import type { MonitorScope } from './ScopeBar';

const POLL_MS = 2000;
const SLOW_MS = 1000;
const VERY_SLOW_MS = 10_000;

const styles = {
  body: 'flex flex-col gap-3 px-4 pb-5 pt-3',
  toolbar: 'flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-slate-500',
  title: 'text-[13px] font-semibold text-slate-800',
  sub: 'text-[11px] text-slate-500',
  chip: 'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
  chipOn: 'border-slate-300 bg-slate-100 text-slate-700',
  chipOff: 'border-slate-200 text-slate-400 hover:text-slate-600',
  iconBtn: 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800',
  card: 'min-w-0 overflow-x-auto rounded-xl border border-slate-200/70 bg-white',
  table: 'w-full border-collapse text-[12px]',
  th: 'whitespace-nowrap px-2 py-1.5 text-left text-[11px] font-medium text-slate-500',
  tr: 'cursor-pointer border-t border-slate-100 transition-colors hover:bg-slate-50',
  td: 'px-2 py-1.5 align-top text-slate-700',
  mono: 'font-mono text-[11.5px]',
  muted: 'text-slate-400',
  badge: 'inline-block rounded px-1.5 py-px text-[10.5px] font-medium',
  detail: 'border-t border-slate-100 bg-slate-50/60 px-3 py-3',
  facts: 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px] sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]',
  factKey: 'text-slate-400',
  factValue: 'min-w-0 truncate text-slate-700',
  pre: 'mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-white px-3 py-2 font-mono text-[11.5px] leading-relaxed text-slate-700 ring-1 ring-slate-200/70',
  preLabel: 'mt-3 text-[11px] font-medium text-slate-500',
  stopBtn: 'rounded-lg px-2.5 py-1 text-[12px] font-medium text-rose-600 ring-1 ring-rose-200 transition-colors hover:bg-rose-50 disabled:opacity-60',
  stopConfirm: 'inline-flex items-center gap-1.5 rounded-lg bg-red-500 px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-60',
  cancelBtn: 'rounded-lg px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-100',
  note: 'flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-slate-500',
  error: 'flex items-start gap-2 rounded-xl bg-rose-50 px-3.5 py-2.5 text-[12px] leading-relaxed text-rose-700',
  empty: 'px-3 py-8 text-center text-[13px] text-slate-400',
} as const;

// 긴 명령은 바깥부터 줄을 나눈다 — 짧은 덩어리와 ObjectId 같은 값은 한 줄 그대로
const pretty = (value: EjsonValue, depth = 0): string => {
  const one = formatQueryValue(value);
  if (one.length <= 80 - depth * 2) return one;
  const pad = '  '.repeat(depth + 1);
  const end = '  '.repeat(depth);
  if (Array.isArray(value)) return `[\n${value.map((v) => pad + pretty(v, depth + 1)).join(',\n')}\n${end}]`;
  if (valueKind(value) !== 'object') return one;
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  return `{\n${Object.entries(value as EjsonObject).map(([k, v]) => `${pad}${key(k)}: ${pretty(v, depth + 1)}`).join(',\n')}\n${end}}`;
};

const durationTone = (ms: number) => (ms >= VERY_SLOW_MS ? 'font-medium text-rose-600' : ms >= SLOW_MS ? 'font-medium text-amber-700' : 'text-slate-700');

function PlanBadge({ plan }: { plan: string | null }) {
  if (!plan) return <span className={styles.muted}>—</span>;
  const scan = plan.startsWith('COLLSCAN');
  return (
    <span className={cn(styles.badge, scan ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600')} data-tt={scan ? 'Reads every document — no index used' : undefined}>
      {plan.length > 40 ? `${plan.slice(0, 39)}…` : plan}
    </span>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <span className={styles.factKey}>{label}</span>
      <span className={styles.factValue} data-tt={value ?? undefined}>{value ?? '—'}</span>
    </>
  );
}

// 펼친 줄 — 전체 명령 + 멈추기(다른 클라이언트의 작업만, 한 번 더 확인)
function OpDetail({ op, finished, onStopped }: { op: RunningOp; finished: boolean; onStopped: () => void }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'pending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const stop = async () => {
    setStep('pending');
    setError(null);
    try {
      await api.killOperation(op.opid);
      setStep('done');
      onStopped();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('idle');
    }
  };

  return (
    <div className={styles.detail}>
      <div className={styles.facts}>
        <Fact label="Started" value={op.startedAt !== null ? fmtClock(op.startedAt, true) : null} />
        <Fact label="Operation id" value={op.opid} />
        <Fact label="Client" value={op.client} />
        <Fact label="App" value={op.appName} />
        <Fact label="User" value={op.user} />
        <Fact label="Yields" value={op.yields !== null ? fmtNumber(op.yields) : null} />
        <Fact label="Waiting for lock" value={op.waitingForLock ? 'Yes' : 'No'} />
        <Fact label="Plan" value={op.planSummary} />
      </div>
      {op.command && (
        <>
          <p className={styles.preLabel}>Command</p>
          <pre className={styles.pre}>{pretty(op.command)}</pre>
        </>
      )}
      {op.origin && (
        <>
          <p className={styles.preLabel}>Started by</p>
          <pre className={styles.pre}>{pretty(op.origin)}</pre>
        </>
      )}
      {op.kind === 'user' && !finished && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {step === 'idle' && (
            <button type="button" className={styles.stopBtn} onClick={() => setStep('confirm')}>
              Stop operation…
            </button>
          )}
          {(step === 'confirm' || step === 'pending') && (
            <>
              <span className="text-[12px] text-slate-600">Stop it? The client gets an “operation was interrupted” error.</span>
              <button type="button" className={styles.stopConfirm} disabled={step === 'pending'} onClick={stop}>
                {step === 'pending' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Stop
              </button>
              <button type="button" className={styles.cancelBtn} disabled={step === 'pending'} onClick={() => setStep('idle')}>
                Cancel
              </button>
            </>
          )}
          {step === 'done' && <span className="text-[12px] text-slate-500">Stop requested — MongoDB ends it at its next checkpoint.</span>}
          {error && <span className="text-[12px] text-rose-600">{error}</span>}
        </div>
      )}
      {op.kind !== 'user' && (
        <p className="mt-3 text-[11px] text-slate-400">
          {op.kind === 'mongolive' ? 'mongolive’s own operation — it can’t be stopped here.' : 'Internal MongoDB operation — it can’t be stopped here.'}
        </p>
      )}
    </div>
  );
}

export function OperationsTab({ scope }: { scope: MonitorScope }) {
  const [report, setReport] = useState<OperationsReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [showOwn, setShowOwn] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  // 펼친 작업 — 끝나서 목록에서 사라져도 접을 때까지 마지막 모습을 남긴다(읽던 중 사라지지 않게)
  const [open, setOpen] = useState<{ op: RunningOp; finished: boolean } | null>(null);
  const [nudge, setNudge] = useState(0);
  const scopeKey = `${scope.database ?? ''}\u0000${scope.collection ?? ''}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    setReport(null);
    setOpen(null);
  }, [scopeKey]);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.hidden) return; // 다시 보일 때 visibilitychange가 이어 간다
      try {
        const next = await api.getOperations(scopeRef.current);
        if (!alive) return;
        setFailed(null);
        if (next) {
          setReport(next);
          setOpen((prev) => {
            if (!prev) return prev;
            const same = next.ops.find((o) => o.opid === prev.op.opid);
            return same ? { op: same, finished: false } : { op: prev.op, finished: true };
          });
        }
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
  }, [paused, scopeKey, nudge]);

  const refreshSoon = useCallback(() => setNudge((n) => n + 1), []);

  const ops = report?.ops ?? [];
  const own = ops.filter((o) => o.kind === 'mongolive').length;
  const system = ops.filter((o) => o.kind === 'system').length;
  const shown = ops.filter((o) => o.kind === 'user' || (o.kind === 'mongolive' && showOwn) || (o.kind === 'system' && showSystem));
  const rows = open?.finished ? [open.op, ...shown.filter((o) => o.opid !== open.op.opid)] : shown;
  const where = scope.collection ? `${scope.database}.${scope.collection}` : scope.database ? `the ${scope.database} database` : 'this server';

  return (
    <div className={styles.body}>
      <div className={styles.toolbar}>
        <div className="flex min-w-0 flex-col">
          <h2 className={styles.title}>Running now{report ? ` · ${shown.length} operation${shown.length === 1 ? '' : 's'}` : ''}</h2>
          <span className={styles.sub}>
            {paused ? 'Paused' : `Every ${POLL_MS / 1000}s`} · {report ? fmtClock(report.at, true) : 'loading…'} · live snapshot — the range above doesn’t apply here
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" className={cn(styles.chip, showOwn ? styles.chipOn : styles.chipOff)} onClick={() => setShowOwn((v) => !v)} data-tt="mongolive’s own work — the change stream it listens on, the 10 s sampler, your Explorer queries">
            mongolive {own}
          </button>
          <button type="button" className={cn(styles.chip, showSystem ? styles.chipOn : styles.chipOff)} onClick={() => setShowSystem((v) => !v)} data-tt="MongoDB’s internal threads, replication, and drivers waiting for server news (hello)">
            internal {system}
          </button>
          <button type="button" className={styles.iconBtn} onClick={() => setPaused((v) => !v)} data-tt={paused ? 'Resume refreshing' : 'Hold the list still while you read it'}>
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>

      {failed && (
        <p className={styles.error}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {failed}
        </p>
      )}
      {report?.error && (
        <p className={styles.error}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {report.error}
        </p>
      )}
      {report?.limited && (
        <p className={styles.note}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
          Only this user’s operations are shown — seeing everyone’s needs the inprog privilege (the clusterMonitor role).
        </p>
      )}

      {!report && !failed ? (
        <div className="flex items-center gap-2 px-1 py-10 text-[13px] text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Asking MongoDB…
        </div>
      ) : report && !report.error && (
        <div className={styles.card}>
          {rows.length === 0 ? (
            <p className={styles.empty}>
              Nothing running on {where} right now. Most operations finish in milliseconds — long ones show up here while they run.
            </p>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={cn(styles.th, 'text-right')}>Running</th>
                  <th className={styles.th}>Op</th>
                  <th className={styles.th}>Namespace</th>
                  <th className={styles.th}>Command</th>
                  <th className={styles.th}>Plan</th>
                  <th className={styles.th}>Client</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((op) => {
                  const isOpen = open?.op.opid === op.opid;
                  const finished = isOpen && open.finished;
                  return (
                    <OpRow
                      key={op.opid}
                      op={op}
                      isOpen={isOpen}
                      finished={finished}
                      onToggle={() => setOpen(isOpen ? null : { op, finished: false })}
                      onStopped={refreshSoon}
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function OpRow({ op, isOpen, finished, onToggle, onStopped }: { op: RunningOp; isOpen: boolean; finished: boolean; onToggle: () => void; onStopped: () => void }) {
  return (
    <>
      <tr className={cn(styles.tr, finished && 'opacity-60')} onClick={onToggle} aria-expanded={isOpen}>
        <td className={cn(styles.td, 'whitespace-nowrap text-right tabular-nums', durationTone(op.ms))}>
          <span className="inline-flex items-center gap-1">
            <ChevronRight className={cn('h-3 w-3 text-slate-400 transition-transform', isOpen && 'rotate-90')} />
            {finished ? 'Finished' : fmtMs(op.ms)}
          </span>
        </td>
        <td className={cn(styles.td, 'whitespace-nowrap')}>
          {op.op}
          {op.waitingForLock && <span className={cn(styles.badge, 'ml-1 bg-rose-50 text-rose-700')} data-tt="Waiting for a lock held by another operation">lock</span>}
        </td>
        <td className={cn(styles.td, styles.mono, 'max-w-[14rem] truncate')} data-tt={op.ns ?? undefined}>{op.ns ?? <span className={styles.muted}>—</span>}</td>
        <td className={cn(styles.td, styles.mono, 'max-w-[28rem] truncate')} data-tt={op.summary}>{op.summary || <span className={styles.muted}>—</span>}</td>
        <td className={cn(styles.td, 'whitespace-nowrap')}><PlanBadge plan={op.planSummary} /></td>
        <td className={cn(styles.td, 'max-w-[12rem] truncate')} data-tt={op.client ?? undefined}>
          {op.appName ?? op.client ?? <span className={styles.muted}>internal</span>}
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={6} className="p-0">
            <OpDetail op={op} finished={finished} onStopped={onStopped} />
          </td>
        </tr>
      )}
    </>
  );
}
