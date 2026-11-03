// path: src/components/layout/DatabaseDropdown.tsx
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m } from 'framer-motion';
import { ChevronDown, Check, X, Plus, Loader2, Trash2 } from 'lucide-react';
import type { DatabaseSummary, MutationRequest } from '../../types/explorer';
import { cn } from '../../utils/cn';
import { useHover } from '../../hooks/useHover';
import { SPRING_HOVER, SPRING_SOFT } from '../../utils/motionPresets';
import { DeleteConfirmModal } from '../common/DeleteConfirmModal';

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = {
  wrap: 'relative min-w-[240px] max-w-[320px]',
  trigger:
    'w-full rounded-[14px] border border-slate-200 bg-white px-4 py-2 shadow-soft flex items-center justify-between gap-3 text-left',
  triggerMeta: 'flex min-w-0',
  triggerLabel: 'text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400',
  triggerValue: 'min-w-0 truncate text-sm font-semibold text-slate-700',
  triggerArrow: 'shrink-0 text-slate-500 transition-transform',
  overlay: 'fixed inset-0 z-[101]',
  panel:
    'fixed z-[101] max-h-[360px] overflow-y-auto rounded-2xl bg-white shadow-elevated ring-1 ring-slate-100 p-1.5 flex flex-col gap-0.5',
  row: 'relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer select-none transition-colors',
  rowActive: 'bg-emerald-50/80',
  rowInactive: 'hover:bg-slate-50',
  rowIcon: 'shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold tracking-wide',
  rowIconActive: 'bg-emerald-100 text-emerald-700',
  rowIconInactive: 'bg-slate-100 text-slate-500',
  rowText: 'flex-1 min-w-0',
  rowLabel: 'text-sm font-medium truncate leading-snug',
  rowMeta: 'text-xs truncate mt-0.5 text-slate-400',
  rowActions: 'flex items-center gap-0.5 shrink-0 overflow-hidden',
  actionBtn: 'p-1.5 rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 transition-colors',
  editRow: 'flex items-center px-2 py-1.5',
  editInput:
    'flex-1 min-w-0 text-sm px-2.5 py-1.5 mr-2 rounded-lg bg-slate-100/80 text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 focus:bg-white transition-all',
  editConfirm: 'p-1.5 rounded-lg text-emerald-500 hover:bg-emerald-100 disabled:opacity-40',
  editCancel: 'p-1.5 rounded-lg text-slate-400 hover:bg-slate-100',
  divider: 'h-px bg-slate-100 my-1',
  addRow:
    'flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium text-emerald-600 hover:bg-emerald-50/70 transition-colors',
  empty: 'px-3 py-4 text-xs text-slate-400 text-center',
} as const;

// ── Props ─────────────────────────────────────────────────────────────────────

interface DatabaseDropdownProps {
  activeDatabase: string | null;
  databases: DatabaseSummary[];
  selectDatabase: (name: string) => Promise<void>;
  onMutate: (op: MutationRequest) => Promise<unknown>;
}

// ── 행(Row) ───────────────────────────────────────────────────────────────────

interface DatabaseRowProps {
  database: DatabaseSummary;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

// DB 이름 변경/복제는 MongoDB에 대응 명령이 없어 지원하지 않는다 — 행 액션은 삭제뿐
function DatabaseRow({ database, isActive, onSelect, onDelete }: DatabaseRowProps) {
  const { hovered, hoverHandlers } = useHover();

  return (
    <m.div
      layout
      className={cn(styles.row, isActive ? styles.rowActive : styles.rowInactive)}
      {...hoverHandlers}
      onClick={onSelect}
    >
      <span className={cn(styles.rowIcon, isActive ? styles.rowIconActive : styles.rowIconInactive)}>
        {database.label.slice(0, 2).toUpperCase()}
      </span>
      <div className={styles.rowText}>
        <p className={cn(styles.rowLabel, isActive ? 'text-emerald-700 font-semibold' : 'text-slate-700')}>
          {database.label}
        </p>
        <p className={styles.rowMeta}>{database.collectionCount} collections · {database.documentCount} docs</p>
      </div>

      <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
        <AnimatePresence>
          {hovered && (
            <m.div
              className="flex items-center gap-0.5 overflow-hidden"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'auto', opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={SPRING_HOVER}
            >
              <button type="button" className={styles.actionBtn} onClick={onDelete} aria-label={`Delete ${database.label}`}>
                <Trash2 size={16} />
              </button>
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </m.div>
  );
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export function DatabaseDropdown({ activeDatabase, databases, selectDatabase, onMutate }: DatabaseDropdownProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [panelPos, setPanelPos] = useState({ top: 0, left: 0, width: 320 });
  const [isAdding, setIsAdding] = useState(false);
  const [newDbName, setNewDbName] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DatabaseSummary | null>(null);

  const hasDatabases = databases.length > 0;
  const selectedLabel = activeDatabase
    ? databases.find((db) => db.name === activeDatabase)?.label ?? activeDatabase
    : hasDatabases
      ? 'Select database'
      : 'Loading databases...';

  const open = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.max(rect.width, 280);
      setPanelPos({ top: rect.bottom + 8, left: rect.right - width, width });
    }
    setIsOpen(true);
  };

  const close = () => {
    setIsOpen(false);
    setIsAdding(false);
    setNewDbName('');
  };

  const handleSelect = (name: string) => {
    if (name !== activeDatabase) void selectDatabase(name);
    // close();
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    await onMutate({ type: 'deleteDatabase', database: deleteTarget.name });
    setDeleteTarget(null);
    close();
  };

  const handleConfirmAdd = async () => {
    if (!newDbName.trim() || isPending) return;
    setIsPending(true);
    try {
      await onMutate({
        type: 'createDatabase',
        database: { name: newDbName.trim(), label: newDbName.trim(), description: '' },
      });
      close();
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => (isOpen ? close() : open())}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
        <span className={styles.triggerLabel}>Database</span>
        <span className={styles.triggerMeta}>
          <span className={styles.triggerValue}>{selectedLabel}</span>
        </span>
        </div>
        <ChevronDown className={cn(styles.triggerArrow, isOpen && 'rotate-180')} size={16} />
      </button>

      {createPortal(
        <AnimatePresence>
          {isOpen && (
            <>
              <div className={styles.overlay} onClick={close} />
              <m.div
                className={styles.panel}
                style={{ top: panelPos.top, left: panelPos.left, width: panelPos.width }}
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.98 }}
                transition={{ duration: 0.1 }}
              >
              {hasDatabases ? (
                databases.map((database) => (
                  <DatabaseRow
                    key={database.name}
                    database={database}
                    isActive={activeDatabase === database.name}
                    onSelect={() => handleSelect(database.name)}
                    onDelete={() => setDeleteTarget(database)}
                  />
                ))
              ) : (
                <p className={styles.empty}>No databases.</p>
              )}

              <div className={styles.divider} />

              {isAdding ? (
                <div className={styles.editRow}>
                  <input
                    autoFocus
                    type="text"
                    placeholder="my-database"
                    className={styles.editInput}
                    value={newDbName}
                    onChange={(e) => setNewDbName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleConfirmAdd();
                      if (e.key === 'Escape') setIsAdding(false);
                    }}
                  />
                  <button type="button" className={styles.editConfirm} onClick={() => void handleConfirmAdd()} disabled={!newDbName.trim() || isPending}>
                    {isPending ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  </button>
                  <button type="button" className={styles.editCancel} onClick={() => setIsAdding(false)}>
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <button type="button" className={styles.addRow} onClick={() => setIsAdding(true)}>
                  <Plus size={15} />
                  New Database
                </button>
              )}
              </m.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {deleteTarget && createPortal(
        <DeleteConfirmModal
          isOpen={!!deleteTarget}
          targetType="database"
          targetLabel={deleteTarget.label}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />,
        document.body,
      )}
    </div>
  );
}
