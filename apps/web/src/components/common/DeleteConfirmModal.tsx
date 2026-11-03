import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Loader2 } from 'lucide-react';

// ── 타겟 타입별 경고 문구 ─────────────────────────────────────────────────────

const TARGET_MESSAGES: Record<string, string> = {
  database: 'This database and all its collections and documents will be deleted.',
  collection: 'This collection and all its documents will be deleted.',
  document: 'This document will be permanently deleted.',
  field: 'This field and all its nested data will be deleted.',
};

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = {
  backdrop: 'fixed inset-0 flex items-center justify-center p-4 inherit',
  overlay: 'absolute inset-0 bg-slate-900/40 backdrop-blur-sm',
  card: 'relative z-[10] w-full max-w-sm bg-white rounded-2xl shadow-elevated p-6 flex flex-col gap-5',
  iconWrap: 'w-12 h-12 rounded-2xl bg-red-50 flex items-center justify-center',
  title: 'text-base font-semibold text-slate-900',
  targetName: 'font-mono text-sm bg-slate-100 rounded-lg px-2 py-1 text-slate-700 mt-1 block truncate',
  message: 'text-sm text-slate-500 leading-relaxed',
  actions: 'flex gap-2 justify-end',
  cancelBtn: 'px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors',
  confirmBtn: 'px-4 py-2 rounded-xl text-sm font-medium text-white bg-red-500 hover:bg-red-600 transition-colors flex items-center gap-2 disabled:opacity-60',
} as const;

// ── Props ─────────────────────────────────────────────────────────────────────

interface DeleteConfirmModalProps {
  isOpen: boolean;
  targetType: 'database' | 'collection' | 'document' | 'field';
  targetLabel: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export function DeleteConfirmModal({
  isOpen,
  targetType,
  targetLabel,
  onConfirm,
  onCancel,
}: DeleteConfirmModalProps) {
  const [isPending, setIsPending] = useState(false);
  const message = TARGET_MESSAGES[targetType] ?? TARGET_MESSAGES.field;

  const handleConfirm = async () => {
    setIsPending(true);
    try {
      await onConfirm();
    } finally {
      setIsPending(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={styles.backdrop}
          style={{ zIndex: 1000 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {/* 오버레이 */}
          <div className={styles.overlay} onClick={onCancel} />

          {/* 카드 */}
          <motion.div
            className={styles.card}
            initial={{ scale: 0.94, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 340, damping: 30 }}
          >
            <div className={styles.iconWrap}>
              <AlertTriangle size={22} className="text-red-500" />
            </div>

            <div>
              <p className={styles.title}>Are you sure you want to delete this?</p>
              <code className={styles.targetName}>{targetLabel}</code>
            </div>

            <p className={styles.message}>{message} This action cannot be undone.</p>

            <div className={styles.actions}>
              <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={isPending}>
                Cancel
              </button>
              <button
                type="button"
                className={styles.confirmBtn}
                onClick={handleConfirm}
                disabled={isPending}
              >
                {isPending && <Loader2 size={14} className="animate-spin" />}
                Delete
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
