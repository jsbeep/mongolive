// Monitor › Collections 맨 위 — 탭이 없던 동안(빈 구간)의 쓰기를 불러오는 배너(9-4). 범위와 상관없이 이 연결 전체.
//   구간마다: 언제 · 얼마나(쓰기 수·크기) · 언제까지 불러와야 하나(oplog에서 밀려나기 전) + [Load]
//   불러오는 중: 진행 막대 + [Stop] / 멈춤: [Continue] / 오류: [Retry]
// 자동 한도(설정 › Monitor) 이하는 서버가 알아서 불러온다 — 그때는 잠깐 '불러오는 중'으로 보였다가 사라진다.
// 다 끝난 구간은 '끝났다'를 잠깐 보여 준다(차트는 1분 안에 따라온다).
import { useEffect, useState } from 'react';
import { History, Loader2, X } from 'lucide-react';
import type { BackfillGap, BackfillReport } from '../../types/explorer';
import type { BackfillState } from '../../hooks/useBackfill';
import { cn } from '../../utils/cn';
import { backfillProgress, fmtEventCount, fmtGapLength, fmtSize, timeLeft } from './backfill';
import { fmtClock, fmtDateTime, fmtNumber } from './format';

const SHOWN = 3;
const DONE_MS = 15_000;

const styles = {
  box: 'flex flex-col gap-2 rounded-xl border border-slate-200/70 bg-slate-50 px-3.5 py-2.5 text-[12px] text-slate-600',
  head: 'flex items-center gap-2',
  title: 'flex-1 text-[12px] font-semibold text-slate-700',
  row: 'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-slate-200/70 pt-2',
  when: 'min-w-0 flex-1',
  meta: 'text-[11px] text-slate-500',
  btn: 'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50',
  btnMain: 'bg-emerald-600 text-white hover:bg-emerald-700',
  btnPlain: 'bg-white text-slate-600 shadow-soft hover:text-slate-900',
  bar: 'h-1.5 w-32 overflow-hidden rounded-full bg-slate-200',
  done: 'flex items-center gap-2 rounded-xl bg-emerald-50 px-3.5 py-2 text-[12px] text-emerald-800',
} as const;

const span = (g: { from: number; to: number }) => {
  const sameDay = new Date(g.from).toDateString() === new Date(g.to).toDateString();
  return `${fmtDateTime(g.from)} – ${sameDay ? fmtClock(g.to) : fmtDateTime(g.to)}`;
};

function GapRow({ gap, now, state }: { gap: BackfillGap; now: number; state: BackfillState }) {
  const est = gap.estimate;
  const sending = state.sending === gap.id || state.sending === '*';
  const left = timeLeft(est?.deadline ?? null, now);
  const progress = backfillProgress(gap);
  const total = est?.total ?? null;
  const counted = total ? `${gap.loaded.toLocaleString('en-US')} / ~${fmtNumber(total)}` : `${gap.loaded.toLocaleString('en-US')} writes${gap.loadedTo ? ` · up to ${fmtClock(gap.loadedTo)}` : ''}`;
  const started = gap.loaded > 0 || gap.loadedTo !== null;

  return (
    <div className={styles.row}>
      <div className={styles.when}>
        <span className="font-medium text-slate-700">{span(gap)}</span>
        <span className="ml-1.5 text-slate-400">({fmtGapLength(gap.to - gap.from)})</span>
        <div className={styles.meta}>
          {gap.status === 'pending' && (
            <>
              <span data-tt={est?.source === 'counters' ? 'From the server totals (serverStatus) — includes some writes mongolive doesn’t list' : est?.source === 'oplog' ? 'Counted in the oplog' : 'Couldn’t count them'}>
                {est ? fmtEventCount(est.events) : 'Counting…'}
              </span>
              {est?.bytes != null && <span> · {fmtSize(est.bytes)}</span>}
              {left && <span data-tt="After that the oplog starts dropping the start of this gap (at the current write rate)"> · load within ~{left}</span>}
            </>
          )}
          {gap.status !== 'pending' && gap.status !== 'error' && <span className="tabular-nums">{started ? counted : 'Starting…'}</span>}
          {gap.status === 'paused' && <span> · paused</span>}
          {gap.status === 'error' && <span className="text-rose-600">{gap.error ?? 'Failed'}</span>}
        </div>
        {est?.resumable === false && (
          <div className={cn(styles.meta, 'text-amber-700')}>The oplog no longer goes back this far — only the part it still has can be loaded.</div>
        )}
        {est?.resumable === null && gap.status === 'pending' && (
          <div className={styles.meta} data-tt="Needs read access to the local database">Couldn’t check the oplog — loading may stop partway.</div>
        )}
        {gap.partialFrom !== undefined && <div className={styles.meta}>Only from {fmtDateTime(gap.partialFrom)} — earlier writes were gone from the oplog.</div>}
      </div>

      {(gap.status === 'loading' || gap.status === 'paused') && (
        <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <div className={cn('h-full rounded-full', gap.status === 'paused' ? 'bg-slate-400' : 'bg-emerald-500')} style={{ width: `${Math.max(2, progress * 100)}%` }} />
        </div>
      )}

      {gap.status === 'loading' ? (
        <button type="button" className={cn(styles.btn, styles.btnPlain)} disabled={sending} onClick={() => state.stop(gap.id)}>Stop</button>
      ) : (
        <button type="button" className={cn(styles.btn, styles.btnMain)} disabled={sending} onClick={() => state.start(gap.id)}>
          {sending && <Loader2 size={11} className="animate-spin" />}
          {gap.status === 'paused' ? 'Continue' : gap.status === 'error' ? 'Retry' : 'Load'}
        </button>
      )}
    </div>
  );
}

export function BackfillBanner({ state }: { state: BackfillState }) {
  const report = state.report;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // 사라진 구간 = 끝남(다 불러왔거나 oplog에 없어 못 불러옴) — 직전 보고와 비교해서
  const [seen, setSeen] = useState<BackfillReport | null>(report);
  const [done, setDone] = useState<BackfillGap[]>([]);
  if (report !== seen) {
    setSeen(report);
    if (seen && report) {
      const ids = new Set(report.gaps.map((g) => g.id));
      const gone = seen.gaps.filter((g) => !ids.has(g.id) && g.status === 'loading');
      if (gone.length > 0) setDone((d) => [...d, ...gone].slice(-SHOWN));
    }
  }
  useEffect(() => {
    if (done.length === 0) return;
    const timer = setTimeout(() => setDone([]), DONE_MS);
    return () => clearTimeout(timer);
  }, [done]);

  const gaps = report?.gaps ?? [];
  const waiting = gaps.filter((g) => g.status !== 'loading').length;

  return (
    <>
      {done.length > 0 && (
        <div className={styles.done} role="status">
          <History size={14} className="shrink-0" />
          <span className="flex-1">
            Finished loading writes from {done.map(span).join(', ')}
            {done.some((g) => g.estimate?.resumable === false) ? ' (only what the oplog still had)' : ''}. The charts catch up within a minute.
          </span>
          <button type="button" className="rounded p-0.5 hover:bg-emerald-100" aria-label="Dismiss" onClick={() => setDone([])}><X size={13} /></button>
        </div>
      )}
      {gaps.length > 0 && (
        <div className={styles.box}>
          <div className={styles.head}>
            <History size={14} className="shrink-0 text-slate-500" />
            <span
              className={styles.title}
              data-tt="mongolive counts writes only while a tab uses this connection. It can read the missed ones back from the change stream — read-only, counts only. Settings › Monitor sets how many load by themselves."
            >
              Writes made while no tab was open {gaps.length > 1 ? `· ${gaps.length} gaps` : ''}
            </span>
            {waiting > 1 && (
              <button type="button" className={cn(styles.btn, styles.btnMain)} disabled={state.sending !== null} onClick={() => state.start()}>Load all</button>
            )}
          </div>
          {gaps.slice(0, SHOWN).map((g) => <GapRow key={g.id} gap={g} now={now} state={state} />)}
          {gaps.length > SHOWN && <p className={styles.meta}>+{gaps.length - SHOWN} more — Load all takes them in order.</p>}
          {state.error && <p className="text-[11px] text-rose-600">{state.error}</p>}
        </div>
      )}
    </>
  );
}
