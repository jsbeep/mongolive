// Monitor › Operations의 두 표(지금 실행 중 · 느린 쿼리)가 같이 쓰는 모양
import { formatQueryValue, valueKind, type EjsonObject, type EjsonValue } from '../../types/explorer';
import { cn } from '../../utils/cn';

export const SLOW_MS = 1000;
export const VERY_SLOW_MS = 10_000;

export const opStyles = {
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
export const pretty = (value: EjsonValue, depth = 0): string => {
  const one = formatQueryValue(value);
  if (one.length <= 80 - depth * 2) return one;
  const pad = '  '.repeat(depth + 1);
  const end = '  '.repeat(depth);
  if (Array.isArray(value)) return `[\n${value.map((v) => pad + pretty(v, depth + 1)).join(',\n')}\n${end}]`;
  if (valueKind(value) !== 'object') return one;
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  return `{\n${Object.entries(value as EjsonObject).map(([k, v]) => `${pad}${key(k)}: ${pretty(v, depth + 1)}`).join(',\n')}\n${end}}`;
};

export const durationTone = (ms: number) => (ms >= VERY_SLOW_MS ? 'font-medium text-rose-600' : ms >= SLOW_MS ? 'font-medium text-amber-700' : 'text-slate-700');

export function PlanBadge({ plan }: { plan: string | null }) {
  if (!plan) return <span className={opStyles.muted}>—</span>;
  const scan = plan.startsWith('COLLSCAN');
  return (
    <span className={cn(opStyles.badge, scan ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600')} data-tt={scan ? 'Reads every document — no index used' : undefined}>
      {plan.length > 40 ? `${plan.slice(0, 39)}…` : plan}
    </span>
  );
}

export function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <span className={opStyles.factKey}>{label}</span>
      <span className={opStyles.factValue} data-tt={value ?? undefined}>{value ?? '—'}</span>
    </>
  );
}
