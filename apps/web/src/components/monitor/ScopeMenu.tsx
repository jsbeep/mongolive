// 범위 바의 드롭다운 한 칸(DB 또는 컬렉션) — 맨 위 'All …'은 범위를 넓힌다.
// 모양·동작은 브레드크럼의 DB 드롭다운(BreadcrumbDatabaseMenu)과 같다. 목록은 열 때 받을 수 있게 loadItems를 둔다
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'framer-motion';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '../../utils/cn';

export interface ScopeMenuItem {
  value: string;
  label: string;
  meta?: string;
}

interface ScopeMenuProps {
  icon: ReactNode;
  // 고른 값(null = 전체)
  value: string | null;
  // 고른 게 없을 때 칸에 보이는 글자이자 목록 맨 위 항목
  allLabel: string;
  // 범위 바의 마지막 칸인가(지금 범위)
  isLast: boolean;
  tooltip: string;
  items: ScopeMenuItem[] | null;
  // 열 때 목록이 없으면 부른다
  loadItems?: () => void;
  onChange: (value: string | null) => void;
}

const styles = {
  trigger: 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
  triggerIdle: 'text-slate-600 hover:bg-slate-100/70 hover:text-slate-800',
  triggerLast: 'bg-slate-100/60 font-semibold text-slate-900 hover:bg-slate-100',
  triggerOpen: 'bg-slate-100 text-slate-900',
  panel: 'fixed z-[101] flex max-h-[360px] min-w-[240px] flex-col overflow-hidden rounded-xl bg-white p-1.5 shadow-elevated ring-1 ring-slate-100',
  list: 'flex min-h-0 flex-col gap-0.5 overflow-y-auto',
  item: 'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
  itemIdle: 'text-slate-700 hover:bg-slate-50',
  itemActive: 'bg-selected font-semibold text-emerald-700',
  meta: 'ml-auto shrink-0 pl-3 font-mono text-[11px] text-slate-400',
  divider: 'my-1 h-px shrink-0 bg-slate-100',
  note: 'flex items-center gap-2 px-3 py-3 text-xs text-slate-400',
} as const;

export function ScopeMenu({ icon, value, allLabel, isLast, tooltip, items, loadItems, onChange }: ScopeMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const toggle = () => {
    if (open) return setOpen(false);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 6, left: rect.left });
    if (!items) loadItems?.();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
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

  const pick = (next: string | null) => {
    setOpen(false);
    if (next !== value) onChange(next);
  };
  const label = value === null ? allLabel : items?.find((item) => item.value === value)?.label ?? value;

  const row = (itemValue: string | null, itemLabel: string, meta?: string) => {
    const active = itemValue === value;
    return (
      <button
        key={itemValue ?? '*'}
        type="button"
        role="option"
        aria-selected={active}
        className={cn(styles.item, active ? styles.itemActive : styles.itemIdle)}
        onClick={() => pick(itemValue)}
      >
        {active ? <Check size={14} className="shrink-0" /> : <span className="w-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{itemLabel}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
      </button>
    );
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cn(styles.trigger, open ? styles.triggerOpen : isLast ? styles.triggerLast : styles.triggerIdle)}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tt={open ? undefined : tooltip}
      >
        {icon}
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDown className={cn('h-3 w-3 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <m.div
              ref={panelRef}
              className={styles.panel}
              style={{ top: pos.top, left: pos.left }}
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.1 }}
            >
              <div className={styles.list} role="listbox" aria-label={tooltip}>
                {row(null, allLabel)}
                <div className={styles.divider} />
                {items === null ? (
                  <p className={styles.note}><Loader2 size={13} className="animate-spin" /> Loading…</p>
                ) : items.length === 0 ? (
                  <p className={styles.note}>Nothing here.</p>
                ) : (
                  items.map((item) => row(item.value, item.label, item.meta))
                )}
              </div>
            </m.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
