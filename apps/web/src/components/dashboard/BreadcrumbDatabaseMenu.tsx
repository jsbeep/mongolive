// 브레드크럼 첫 칸(DB) = DB 고르기 드롭다운. 고르기만 한다 — 추가/삭제는 사이드바 트리에서.
// 지금 DB를 다시 고르면 예전 브레드크럼 클릭처럼 컬렉션 목록으로 돌아간다.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'framer-motion';
import { Check, ChevronDown, Database } from 'lucide-react';
import type { DatabaseSummary } from '../../types/explorer';
import { cn } from '../../utils/cn';

interface BreadcrumbDatabaseMenuProps {
  label: string;
  // 브레드크럼의 마지막 칸인가(= DB 루트를 보고 있음)
  isLast: boolean;
  databases: DatabaseSummary[];
  activeDatabase: string | null;
  onSelectDatabase: (name: string) => void;
  // 지금 DB를 다시 골랐을 때 — 컬렉션 목록으로
  onBackToRoot: () => void;
}

const styles = {
  // Breadcrumbs의 칸 모양(breadcrumbBase)과 같은 크기
  trigger: 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
  triggerIdle: 'text-slate-600 hover:bg-slate-100/70 hover:text-slate-800',
  triggerLast: 'bg-slate-100/60 font-semibold text-slate-900 hover:bg-slate-100',
  triggerOpen: 'bg-slate-100 text-slate-900',
  panel: 'fixed z-[101] flex max-h-[360px] min-w-[240px] flex-col gap-0.5 overflow-y-auto rounded-xl bg-white p-1.5 shadow-elevated ring-1 ring-slate-100',
  item: 'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
  itemIdle: 'text-slate-700 hover:bg-slate-50',
  itemActive: 'bg-emerald-50 font-semibold text-emerald-700',
  meta: 'ml-auto shrink-0 pl-3 font-mono text-[11px] text-slate-400',
  empty: 'px-3 py-4 text-center text-xs text-slate-400',
} as const;

export function BreadcrumbDatabaseMenu({ label, isLast, databases, activeDatabase, onSelectDatabase, onBackToRoot }: BreadcrumbDatabaseMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 6, left: rect.left });
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

  const pick = (name: string) => {
    setOpen(false);
    if (name === activeDatabase) {
      if (!isLast) onBackToRoot();
    } else {
      onSelectDatabase(name);
    }
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
        data-tt={open ? undefined : 'Switch database'}
      >
        <Database className="h-3.5 w-3.5" />
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
              role="listbox"
              aria-label="Databases"
            >
              {databases.length === 0 ? (
                <p className={styles.empty}>No databases.</p>
              ) : (
                databases.map((db) => {
                  const isActive = db.name === activeDatabase;
                  return (
                    <button
                      key={db.name}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={cn(styles.item, isActive ? styles.itemActive : styles.itemIdle)}
                      onClick={() => pick(db.name)}
                    >
                      {isActive ? <Check size={14} className="shrink-0" /> : <Database size={14} className="shrink-0 text-slate-400" />}
                      <span className="min-w-0 truncate">{db.label}</span>
                      <span className={styles.meta}>{db.collectionCount}</span>
                    </button>
                  );
                })
              )}
            </m.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
