// 충돌 창 — 저장하려던 값이 편집하는 동안 다른 곳에서 바뀌었을 때(서버 409).
// 내가 본 값 / 지금 값 / 내 값을 나란히 보여 주고 고르게 한다:
//   Keep theirs       최신 값 유지 — 내 변경은 버리고 편집기를 닫는다
//   Overwrite anyway  그래도 덮어쓰기 — 비교 없이 다시 저장한다
// 모양은 DeleteConfirmModal과 맞춘다. 실패가 아니라 '골라야 하는 상황'이라 빨강 대신 호박색.
import { AnimatePresence, motion } from 'framer-motion';
import { GitMerge } from 'lucide-react';
import { displayValue, isContainer, type ExpectedValue, type JsonValue } from '../../types/explorer';
import type { PendingConflict } from '../../hooks/useExplorerState';

const MAX_CHARS = 120;

const show = (value: JsonValue): string => {
  const text = isContainer(value) ? JSON.stringify(value) : displayValue(value);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
};

const showSlot = (slot: ExpectedValue): string => (slot.exists ? show(slot.value) : '(none)');

const styles = {
  backdrop: 'fixed inset-0 flex items-center justify-center p-4',
  overlay: 'absolute inset-0 bg-black/40 backdrop-blur-sm',
  card: 'relative z-[10] w-full max-w-md bg-white rounded-2xl shadow-elevated p-6 flex flex-col gap-5',
  iconWrap: 'w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center',
  title: 'text-base font-semibold text-slate-900',
  path: 'font-mono text-sm bg-slate-100 rounded-lg px-2 py-1 text-slate-700 mt-1 block truncate',
  rows: 'flex flex-col gap-1.5',
  row: 'grid grid-cols-[72px_1fr] items-start gap-3 px-3 py-2 rounded-lg',
  rowLabel: 'text-xs font-medium text-slate-500 pt-0.5',
  rowValue: 'font-mono text-xs text-slate-700 break-all',
  // 각 줄 배경은 하나만 — cn은 겹치는 클래스를 정리해 주지 않는다
  rowSeen: 'bg-slate-50',
  rowNow: 'bg-sky-50',
  rowMine: 'bg-emerald-50',
  message: 'text-sm text-slate-500 leading-relaxed',
  actions: 'flex gap-2 justify-end',
  keepBtn: 'px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors cursor-pointer',
  overwriteBtn: 'px-4 py-2 rounded-xl text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 transition-colors cursor-pointer',
} as const;

interface ConflictModalProps {
  pending: PendingConflict | null;
  onOverwrite: () => void;
  onKeepTheirs: () => void;
}

export function ConflictModal({ pending, onOverwrite, onKeepTheirs }: ConflictModalProps) {
  const mine = pending
    ? pending.mine.action === 'delete'
      ? '(delete)'
      : pending.mine.value === undefined
        ? '(unchanged)'
        : show(pending.mine.value)
    : '';

  return (
    <AnimatePresence>
      {pending && (
        <motion.div
          className={styles.backdrop}
          style={{ zIndex: 1000 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {/* 바깥을 누르면 '최신 값 유지'(덮어쓰기는 반드시 버튼으로만) */}
          <div className={styles.overlay} onClick={onKeepTheirs} />

          <motion.div
            className={styles.card}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="conflict-title"
            initial={{ scale: 0.94, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 340, damping: 30 }}
          >
            <div className={styles.iconWrap}>
              <GitMerge size={22} className="text-amber-500" />
            </div>

            <div>
              <p id="conflict-title" className={styles.title}>Changed while you were editing</p>
              <code className={styles.path}>{pending.path}</code>
            </div>

            <div className={styles.rows}>
              <div className={`${styles.row} ${styles.rowSeen}`}>
                <span className={styles.rowLabel}>You saw</span>
                <span className={styles.rowValue}>{showSlot(pending.seen)}</span>
              </div>
              <div className={`${styles.row} ${styles.rowNow}`}>
                <span className={styles.rowLabel}>Now</span>
                <span className={styles.rowValue}>{showSlot(pending.current)}</span>
              </div>
              <div className={`${styles.row} ${styles.rowMine}`}>
                <span className={styles.rowLabel}>Yours</span>
                <span className={styles.rowValue}>{mine}</span>
              </div>
            </div>

            <p className={styles.message}>Someone else saved a newer value. Overwriting replaces it with yours.</p>

            <div className={styles.actions}>
              <button type="button" className={styles.keepBtn} onClick={onKeepTheirs}>
                Keep theirs
              </button>
              <button type="button" className={styles.overwriteBtn} onClick={onOverwrite}>
                Overwrite anyway
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
