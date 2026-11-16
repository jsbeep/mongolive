// Monitor 차트 — 손으로 그린 SVG(차트 라이브러리 없이, 번들을 늘리지 않게). dataviz 규칙대로:
//   선 2px · 격자는 1px 실선(점선 아님) · y축은 하나 · 계열이 둘 이상이면 범례(각 계열의 지금 값 포함)
//   가로 위치를 따라가는 십자선 + 그 시각의 모든 계열 값을 보여 주는 툴팁(포커스 후 ←→로도)
//   표 보기(툴팁에만 숨은 값이 없게) · 계열 색은 정한 순서(--chart-1…4)만, 글자는 색을 입히지 않는다
// 값이 없는 칸(null)이나 기록이 끊긴 구간(gapMs보다 벌어짐)에서는 선을 끊는다 — 없는 값을 이어 그리지 않는다.
import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { LineChart as LineChartIcon, Table2 } from 'lucide-react';
import { cn } from '../../utils/cn';
import { fmtClock, tickStepFor } from './format';

export interface ChartSeries {
  key: string;
  label: string;
  // CSS 색(var(--chart-n))
  color: string;
  values: (number | null)[];
}

const PLOT_H = 120;
const AXIS_H = 18;
const PAD_TOP = 8;
const PAD_LEFT = 44;
const PAD_RIGHT = 10;

const styles = {
  card: 'flex min-w-0 flex-col gap-2 rounded-xl border border-slate-200/70 bg-white px-3.5 pb-2.5 pt-3',
  head: 'flex items-start gap-2',
  title: 'text-[13px] font-semibold text-slate-800',
  subtitle: 'text-[11px] text-slate-500',
  latest: 'ml-auto shrink-0 text-[13px] font-semibold text-slate-800',
  toggle: 'shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700',
  legend: 'flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-slate-500',
  legendValue: 'font-medium text-slate-700 tabular-nums',
  plot: 'relative outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/50 rounded-md',
  tooltip: 'pointer-events-none absolute top-1 z-10 min-w-[120px] rounded-lg bg-white px-2.5 py-1.5 text-[11px] shadow-elevated ring-1 ring-slate-200',
  tooltipTime: 'mb-1 font-mono text-[10px] text-slate-400',
  tooltipRow: 'flex items-center gap-2',
  tooltipValue: 'font-semibold text-slate-800 tabular-nums',
  tooltipLabel: 'text-slate-500',
  empty: 'flex items-center justify-center text-[11px] text-slate-400',
  table: 'overflow-y-auto rounded-md border border-slate-100 text-[11px]',
  th: 'sticky top-0 bg-slate-50 px-2 py-1 text-left font-medium text-slate-500',
  td: 'px-2 py-0.5 text-slate-700 tabular-nums',
} as const;

// 0부터 '깔끔한' 최댓값(1·2·2.5·5 × 10ⁿ)까지
const niceMax = (max: number): number => {
  if (!(max > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * exp >= max) return step * exp;
  return 10 * exp;
};

// 짧은 선 하나 — 범례·툴팁의 계열 표시(채운 네모 대신, 선 차트의 표시와 같은 모양)
function LineKey({ color }: { color: string }) {
  return (
    <svg width="12" height="4" aria-hidden="true" className="shrink-0">
      <line x1="1" y1="2" x2="11" y2="2" style={{ stroke: color }} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

// 그려질 너비(px) — SVG를 늘이지 않고 실제 너비로 그려야 선 두께가 2px 그대로다.
// 콜백 ref: 표 보기 ↔ 차트를 오가며 요소가 새로 생겨도 다시 잰다
const useWidth = () => {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { ref: setEl, width };
};

interface TimeChartProps {
  title: string;
  subtitle?: ReactNode;
  times: number[];
  series: ChartSeries[];
  format: (value: number) => string;
  windowMs: number;
  now: number;
  // 이웃 칸이 이보다 멀면 선을 끊는다(기록이 없던 구간)
  gapMs: number;
  // 그릴 값이 하나도 없을 때
  emptyText?: string;
}

export function TimeChart({ title, subtitle, times, series, format, windowMs, now, gapMs, emptyText = 'No data yet' }: TimeChartProps) {
  const { ref, width } = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const start = now - windowMs;
  const plotW = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const x = (t: number) => PAD_LEFT + ((t - start) / windowMs) * plotW;

  // 창 안에 든 칸만
  const visible = useMemo(() => times.map((t, i) => (t >= start && t <= now ? i : -1)).filter((i) => i >= 0), [times, start, now]);
  const max = useMemo(() => {
    let m = 0;
    for (const s of series) for (const i of visible) {
      const v = s.values[i];
      if (v !== null && v > m) m = v;
    }
    return niceMax(m);
  }, [series, visible]);
  const y = (v: number) => PAD_TOP + PLOT_H - (v / max) * PLOT_H;
  const hasData = series.some((s) => visible.some((i) => s.values[i] !== null));

  // 계열마다: 이어진 구간들(선) + 홀로 떨어진 점(이웃 없이 값 하나)
  const shapes = useMemo(() => series.map((s) => {
    const runs: number[][] = [];
    let run: number[] = [];
    let prevT = -Infinity;
    for (const i of visible) {
      const v = s.values[i];
      if (v === null || times[i] - prevT > gapMs) {
        if (run.length) runs.push(run);
        run = [];
      }
      if (v !== null) run.push(i);
      prevT = times[i];
    }
    if (run.length) runs.push(run);
    return runs;
  }), [series, visible, times, gapMs]);

  const lastIndex = (s: ChartSeries) => {
    for (let k = visible.length - 1; k >= 0; k--) if (s.values[visible[k]] !== null) return visible[k];
    return -1;
  };

  // 가로 위치 → 가장 가까운 칸
  const nearest = (px: number): number | null => {
    if (!visible.length) return null;
    const t = start + ((px - PAD_LEFT) / Math.max(1, plotW)) * windowMs;
    let best = visible[0];
    for (const i of visible) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    return best;
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(nearest(e.clientX - rect.left));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!visible.length) return;
    if (e.key === 'Escape') return setHover(null);
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = hover === null ? visible.length - 1 : visible.indexOf(hover);
    const next = Math.min(visible.length - 1, Math.max(0, at + (e.key === 'ArrowRight' ? 1 : -1)));
    setHover(visible[next]);
  };

  // 시각 눈금(창 길이에 따라 2·5·15분 간격)
  const tickMs = tickStepFor(windowMs);
  const ticks: number[] = [];
  for (let t = Math.ceil(start / tickMs) * tickMs; t <= now; t += tickMs) {
    // 양 끝에 너무 붙은 눈금은 뺀다 — y축 숫자·오른쪽 가장자리와 겹치지 않게(시각 글자 폭의 절반쯤)
    if (x(t) >= PAD_LEFT + 18 && x(t) <= width - PAD_RIGHT - 4) ticks.push(t);
  }

  const single = series.length === 1;
  const latestOf = (s: ChartSeries) => {
    const i = lastIndex(s);
    return i >= 0 ? (s.values[i] as number) : null;
  };
  const hoverX = hover !== null ? x(times[hover]) : 0;

  return (
    <section className={styles.card} aria-label={title}>
      <div className={styles.head}>
        <div className="min-w-0">
          <h3 className={styles.title}>{title}</h3>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {/* 계열이 하나면 범례 대신 제목 옆에 지금 값 */}
        {single && <span className={styles.latest}>{latestOf(series[0]) === null ? '—' : format(latestOf(series[0]) as number)}</span>}
        <button
          type="button"
          className={cn(styles.toggle, !single && 'ml-auto')}
          onClick={() => setShowTable((v) => !v)}
          aria-label={showTable ? 'Show as chart' : 'Show as table'}
          data-tt={showTable ? 'Show as chart' : 'Show as table'}
        >
          {showTable ? <LineChartIcon size={14} /> : <Table2 size={14} />}
        </button>
      </div>

      {!single && (
        <div className={styles.legend}>
          {series.map((s) => {
            const latest = latestOf(s);
            return (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <LineKey color={s.color} />
                {s.label}
                <span className={styles.legendValue}>{latest === null ? '—' : format(latest)}</span>
              </span>
            );
          })}
        </div>
      )}

      {showTable ? (
        <div className={styles.table} style={{ height: PLOT_H + AXIS_H + PAD_TOP }}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={styles.th}>Time</th>
                {series.map((s) => <th key={s.key} className={cn(styles.th, 'text-right')}>{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...visible].reverse().map((i) => (
                <tr key={times[i]} className="border-t border-slate-100">
                  <td className={cn(styles.td, 'font-mono text-slate-500')}>{fmtClock(times[i], true)}</td>
                  {series.map((s) => <td key={s.key} className={cn(styles.td, 'text-right')}>{s.values[i] === null ? '—' : format(s.values[i] as number)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          ref={ref}
          className={styles.plot}
          style={{ height: PLOT_H + AXIS_H + PAD_TOP }}
          tabIndex={hasData ? 0 : -1}
          role="img"
          aria-label={`${title}, last ${Math.round(windowMs / 60000)} minutes. Focus and use the arrow keys to read values.`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setHover(null)}
        >
          {width > 0 && (
            <svg width={width} height={PLOT_H + AXIS_H + PAD_TOP} className="block overflow-visible">
              {/* 격자: 0 · 가운데 · 최댓값 */}
              {[0, max / 2, max].map((v) => (
                <g key={v}>
                  <line x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={y(v) + 0.5} y2={y(v) + 0.5} className="stroke-slate-200" strokeWidth={1} />
                  <text x={PAD_LEFT - 6} y={y(v) + 3.5} textAnchor="end" className="fill-slate-400 text-[10px] tabular-nums">{format(v)}</text>
                </g>
              ))}
              {ticks.map((t) => (
                <text key={t} x={x(t)} y={PAD_TOP + PLOT_H + 13} textAnchor="middle" className="fill-slate-400 font-mono text-[10px]">{fmtClock(t)}</text>
              ))}

              {hasData && series.map((s, si) => (
                <g key={s.key}>
                  {shapes[si].map((run) => {
                    if (run.length === 1) {
                      const i = run[0];
                      return <circle key={i} cx={x(times[i])} cy={y(s.values[i] as number)} r={2.5} style={{ fill: s.color }} />;
                    }
                    const d = run.map((i, k) => `${k ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(s.values[i] as number).toFixed(1)}`).join('');
                    return (
                      <g key={run[0]}>
                        {/* 계열이 하나면 옅은 면(10%) — 여럿이면 겹쳐서 탁해지므로 선만 */}
                        {single && (
                          <path
                            d={`${d}L${x(times[run[run.length - 1]]).toFixed(1)},${y(0)}L${x(times[run[0]]).toFixed(1)},${y(0)}Z`}
                            style={{ fill: s.color }}
                            opacity={0.1}
                          />
                        )}
                        <path d={d} fill="none" style={{ stroke: s.color }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                      </g>
                    );
                  })}
                  {/* 마지막 값 점 — 카드 바탕색 테두리로 선과 겹쳐도 보이게 */}
                  {lastIndex(s) >= 0 && hover === null && (
                    <circle cx={x(times[lastIndex(s)])} cy={y(s.values[lastIndex(s)] as number)} r={4} style={{ fill: s.color }} className="stroke-white" strokeWidth={2} />
                  )}
                </g>
              ))}

              {hover !== null && (
                <g>
                  <line x1={hoverX} x2={hoverX} y1={PAD_TOP} y2={PAD_TOP + PLOT_H} className="stroke-slate-300" strokeWidth={1} />
                  {series.map((s) => s.values[hover] === null ? null : (
                    <circle key={s.key} cx={hoverX} cy={y(s.values[hover] as number)} r={4} style={{ fill: s.color }} className="stroke-white" strokeWidth={2} />
                  ))}
                </g>
              )}
            </svg>
          )}
          {width > 0 && !hasData && <div className={cn(styles.empty, 'absolute inset-0')} style={{ paddingLeft: PAD_LEFT, paddingBottom: AXIS_H }}>{emptyText}</div>}

          {hover !== null && (
            <div className={styles.tooltip} style={hoverX > width / 2 ? { right: width - hoverX + 10 } : { left: hoverX + 10 }}>
              <div className={styles.tooltipTime}>{fmtClock(times[hover], true)}</div>
              {series.map((s) => (
                <div key={s.key} className={styles.tooltipRow}>
                  <LineKey color={s.color} />
                  <span className={styles.tooltipValue}>{s.values[hover] === null ? '—' : format(s.values[hover] as number)}</span>
                  {!single && <span className={styles.tooltipLabel}>{s.label}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// 숫자 타일의 작은 추세선 — 흐린 회색 선 + 지금 값만 강조색 점(dataviz의 stat tile 규칙). 값은 타일이 글자로 보여 준다
export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const { ref, width } = useWidth();
  const H = 28;
  const defined = values.filter((v): v is number => v !== null);
  const max = Math.max(1e-9, ...defined);
  const step = values.length > 1 ? (width - 6) / (values.length - 1) : 0;
  // 값이 하나뿐이면(막 세기 시작함) '지금' 자리인 오른쪽 끝에
  const px = (i: number) => (values.length === 1 ? width - 3 : 3 + i * step);
  const py = (v: number) => 3 + (H - 6) - (v / max) * (H - 6);
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
    pen = true;
  });
  const last = values.length - 1;
  return (
    <div ref={ref} className="h-7 w-full" role="img" aria-label={`${label}, last ${values.length} samples`}>
      {width > 0 && defined.length > 0 && (
        <svg width={width} height={H} className="block overflow-visible">
          <path d={d} fill="none" className="stroke-slate-300" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          {values[last] !== null && <circle cx={px(last)} cy={py(values[last] as number)} r={3} style={{ fill: 'var(--chart-1)' }} className="stroke-white" strokeWidth={1.5} />}
        </svg>
      )}
    </div>
  );
}
