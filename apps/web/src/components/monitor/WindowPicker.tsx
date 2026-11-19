// 날짜로 찾기(C2) — 범위 바 기간 줄 끝의 달력 버튼. 누르면 From·To(이 브라우저 시간대)를 고르는 작은 창.
//   고르면 버튼 자리가 칩 "11/18 09:00 → 15:00 ×"로 바뀐다 — 칩을 누르면 다시 고치고, ×나 다른 기간 버튼을 누르면 풀린다.
//   구간은 기록 파일에서만 읽는다(10분 이상, 끝은 지금까지 — 서버와 같은 checkWindow).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { CalendarRange, X } from 'lucide-react';
import { checkWindow, type MonitorWindow } from '../../types/explorer';
import { cn } from '../../utils/cn';
import { windowLabel } from './format';

const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');
// datetime-local 값 — YYYY-MM-DDTHH:mm(이 브라우저 시간대)
const toInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// 오프셋 없는 날짜·시각은 브라우저 시간대로 읽힌다
const fromInput = (value: string) => (value ? new Date(value).getTime() : Number.NaN);
const minuteFloor = (ms: number) => Math.floor(ms / 60_000) * 60_000;

const styles = {
  trigger: 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors',
  idle: 'text-slate-500 hover:text-slate-800',
  on: 'bg-white text-slate-800 shadow-soft',
  clear: 'ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700',
  panel: 'fixed z-[101] flex w-[264px] flex-col gap-2.5 rounded-xl bg-white p-3 shadow-elevated ring-1 ring-slate-100',
  title: 'text-[12px] font-semibold text-slate-800',
  label: 'flex flex-col gap-1 text-[11px] font-medium text-slate-500',
  input: 'h-8 rounded-lg border border-slate-200 px-2 text-[12px] tabular-nums text-slate-800 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100',
  hint: 'text-[11px] leading-snug text-slate-400',
  error: 'text-[11px] leading-snug text-rose-600',
  button: 'h-7 rounded-lg px-3 text-[12px] font-medium transition-colors',
  cancel: 'text-slate-600 hover:bg-slate-100',
  apply: 'bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40',
} as const;

interface WindowPickerProps {
  // 지금 고른 구간(없으면 null)
  value: MonitorWindow | null;
  onPick: (window: MonitorWindow) => void;
  // × — 전에 보던 기간으로
  onClear: () => void;
}

export function WindowPicker({ value, onPick, onClear }: WindowPickerProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) return setOpen(false);
    // 고친다면 지금 구간, 아니면 최근 6시간
    const now = minuteFloor(Date.now());
    setFrom(toInput(value?.from ?? now - 6 * HOUR));
    setTo(toInput(value?.to ?? now));
    setTried(false);
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
    setOpen(true);
  };

  const checked = checkWindow(fromInput(from), fromInput(to), Date.now());
  const problem = typeof checked === 'string' ? checked : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (typeof checked === 'string') return;
    setOpen(false);
    onPick(checked);
  };

  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        {value ? (
          <span role="radio" aria-checked="true" className={cn(styles.trigger, styles.on)}>
            <button type="button" className="inline-flex items-center gap-1" onClick={toggle} data-tt={open ? undefined : 'Change the dates'} aria-expanded={open} aria-haspopup="dialog">
              <CalendarRange className="h-3 w-3 text-slate-400" />
              {windowLabel(value.from, value.to)}
            </button>
            <button type="button" className={styles.clear} onClick={onClear} aria-label="Clear the dates" data-tt="Back to the range you had">
              <X size={11} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            role="radio"
            aria-checked="false"
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label="Pick dates"
            className={cn(styles.trigger, styles.idle)}
            onClick={toggle}
            data-tt={open ? undefined : 'Pick dates — any past window, from history'}
          >
            <CalendarRange className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
      {open &&
        createPortal(
          <form ref={panelRef} role="dialog" aria-label="Pick dates" className={styles.panel} style={{ top: pos.top, right: pos.right }} onSubmit={submit}>
            <p className={styles.title}>Show a past window</p>
            <label className={styles.label}>
              From
              <input type="datetime-local" className={styles.input} value={from} max={toInput(Date.now())} onChange={(e) => setFrom(e.target.value)} autoFocus />
            </label>
            <label className={styles.label}>
              To
              <input type="datetime-local" className={styles.input} value={to} max={toInput(Date.now())} onChange={(e) => setTo(e.target.value)} />
            </label>
            {tried && problem ? (
              <p className={styles.error} role="alert">{problem}</p>
            ) : (
              <p className={styles.hint}>Read from history — at least 10 minutes. Time spent, transactions and replica lag stay live-only.</p>
            )}
            <div className="flex justify-end gap-1.5">
              <button type="button" className={cn(styles.button, styles.cancel)} onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className={cn(styles.button, styles.apply)}>Apply</button>
            </div>
          </form>,
          document.body,
        )}
    </>
  );
}
