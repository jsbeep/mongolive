// path: src/components/layout/Header.tsx
import { useState } from 'react';
import { Circle, Columns3, ListTree, Minus, Plus, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';
import { MIN_VISIBLE_COLUMNS, MAX_VISIBLE_COLUMNS, type UseExplorerStateResult } from '../../hooks/useExplorerState';
import { cn } from '../../utils/cn';
import { DatabaseDropdown } from './DatabaseDropdown';

type HeaderProps = Pick<
  UseExplorerStateResult,
  | 'activeDatabase'
  | 'connectionStatus'
  | 'databases'
  | 'selectDatabase'
  | 'mutate'
  | 'maxVisibleColumns'
  | 'setMaxVisibleColumns'
> & {
  onRefresh: () => void;
};

const styles = {
  header:
    'flex min-h-14 w-full items-center border-b border-slate-200/80 bg-white/85 px-3 backdrop-blur-md rounded-[14px] shadow-soft',
  inner: 'flex w-full min-w-0 items-center gap-3',
  left: 'flex min-w-0 items-center gap-2.5',
  logoMark:
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] border border-emerald-200 bg-emerald-50 text-sm font-bold text-emerald-700',
  wordmark: 'min-w-0',
  titleRow: 'flex items-center gap-2',
  title: 'text-sm font-semibold tracking-tight text-slate-900',
  mockBadge:
    'inline-flex items-center rounded-full bg-orange-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700',
  subtitle: 'mt-0.5 text-xs text-slate-500',
  right: 'ml-auto flex min-w-0 items-center gap-2',
  refreshWrap: 'relative shrink-0 overflow-visible',
  refreshButton:
    'relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 focus-visible:border-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-500/20',
  refreshBadge:
    'absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-white bg-white shadow-[0_0_0_1px_rgba(255,255,255,1)]',
  refreshBadgeDot: 'h-2.5 w-2.5',
  stepperWrap:
    'flex shrink-0 items-center rounded-full border border-slate-200 bg-white px-1 py-1',
  stepperButton:
    'inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
  stepperReset: 'inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-600 text-sm font-semibold transition-colors hover:bg-slate-100 hover:text-slate-700',
  modeToggle:
    'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-800',
} as const;

const STATUS_STYLES: Record<UseExplorerStateResult['connectionStatus'], { color: string; label: string }> = {
  disconnected: {
    color: 'text-slate-400',
    label: 'Disconnected',
  },
  connecting: {
    color: 'text-amber-500',
    label: 'Connecting',
  },
  connected: {
    color: 'text-emerald-500',
    label: 'Connected',
  },
  error: {
    color: 'text-rose-500',
    label: 'Error',
  },
};

export function Header({
  activeDatabase,
  connectionStatus,
  databases,
  selectDatabase,
  mutate,
  maxVisibleColumns,
  setMaxVisibleColumns,
  onRefresh,
}: HeaderProps) {
  const status = STATUS_STYLES[connectionStatus];
  const [rotation, setRotation] = useState(0);
  // 생색용 토글 — 트리모드(컬럼 2개)/컬럼모드(컬럼 3개) 둘만 오가며, 다른 상태는 추가하지 않음
  const isTreeMode = maxVisibleColumns === MIN_VISIBLE_COLUMNS;

  const handleRefresh = () => {
    setRotation((current) => current + 360);
    onRefresh();
  };

  return (
    <motion.header
      className={styles.header}
      initial={{ y: -10, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
    >
      <div className={styles.inner}>
        <div className={styles.left}>
          <div className={styles.logoMark} aria-hidden="true">
            ML
          </div>
          <div className={styles.wordmark}>
            <div className={styles.titleRow}>
              <span className={styles.title}>MongoLive - JSON Explorer & Editor</span>
            </div>
            <p className={styles.subtitle}>Miller Column-based JSON viewer & inline editor</p>
          </div>
        </div>

        <div className={styles.right}>
          <button
            type="button"
            className={styles.modeToggle}
            onClick={() => setMaxVisibleColumns(isTreeMode ? 3 : MIN_VISIBLE_COLUMNS)}
            aria-label={isTreeMode ? 'Switch to column mode' : 'Switch to tree mode'}
            data-tt={isTreeMode ? 'Tree mode — click to spread levels across columns' : 'Column mode — click to stack levels into one tree'}
          >
            {isTreeMode ? <ListTree size={14} /> : <Columns3 size={14} />}
            <span>{isTreeMode ? 'Tree' : 'Columns'}</span>
          </button>
          <div className={styles.stepperWrap} role="group" aria-label="Visible column count">
            <button
              type="button"
              className={cn(styles.stepperButton, "rounded-l-2xl")}
              onClick={() => setMaxVisibleColumns(maxVisibleColumns - 1)}
              disabled={maxVisibleColumns <= MIN_VISIBLE_COLUMNS}
              aria-label="Show fewer columns"
            >
              <Minus size={14} />
            </button>
            <button
              type="button"
              className={styles.stepperReset}
              onClick={() => setMaxVisibleColumns(3)}
              aria-label="reset to 3 columns"
            >
              {maxVisibleColumns}
            </button>
            <button
              type="button"
              className={cn(styles.stepperButton, "rounded-r-2xl")}
              onClick={() => setMaxVisibleColumns(maxVisibleColumns + 1)}
              disabled={maxVisibleColumns >= MAX_VISIBLE_COLUMNS}
              aria-label="Show more columns"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className={styles.refreshWrap}>
            <motion.button
              type="button"
              className={styles.refreshButton}
              onClick={handleRefresh}
              whileTap={{ scale: 0.98 }}
              aria-label="Refresh current database view"
            >
              <motion.span
                className="inline-flex"
                animate={{ rotate: rotation }}
                transition={{ duration: 0.8, ease: 'easeInOut' }}
              >
                <RefreshCw size={16} aria-hidden="true" />
              </motion.span>
            </motion.button>
            <span className={styles.refreshBadge} aria-hidden="true">
              <Circle className={cn(styles.refreshBadgeDot, status.color)} fill="currentColor" stroke="none" />
            </span>
          </div>

          <DatabaseDropdown
            activeDatabase={activeDatabase}
            databases={databases}
            selectDatabase={selectDatabase}
            onMutate={mutate}
          />
        </div>
      </div>
    </motion.header>
  );
}
