import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'lucide-react';
import type { PendingFieldReference } from '../../hooks/useExplorerState';
import type { FieldReferenceCandidate } from '../../types/explorer';

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = {
  backdrop: 'fixed inset-0 flex items-center justify-center p-4 inherit',
  overlay: 'absolute inset-0 bg-slate-900/40 backdrop-blur-sm',
  card: 'relative z-[10] w-full max-w-sm bg-white rounded-2xl shadow-elevated p-6 flex flex-col gap-4',
  iconWrap: 'w-12 h-12 rounded-2xl bg-cyan-50 flex items-center justify-center',
  title: 'text-base font-semibold text-slate-900',
  message: 'text-sm text-slate-500 leading-relaxed',
  list: 'flex flex-col gap-1.5 max-h-64 overflow-y-auto -mx-1 px-1',
  candidateBtn: 'flex flex-col items-start gap-0.5 text-left px-3 py-2 rounded-xl bg-slate-50 hover:bg-cyan-50 border border-slate-100 hover:border-cyan-200 transition-colors',
  candidateTitle: 'text-sm font-medium text-slate-700',
  candidateMeta: 'text-xs font-mono text-slate-400',
  cancelBtn: 'self-end px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors',
} as const;

// ── Props ─────────────────────────────────────────────────────────────────────

interface ReferenceCandidatesModalProps {
  pending: PendingFieldReference | null;
  onSelect: (candidate: FieldReferenceCandidate) => void;
  onCancel: () => void;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────
// 같은 컬렉션 안에서 PK 값이 중복돼 참조 후보가 여러 개일 때 — 조용히 하나를
// 골라 잘못 연결하지 않고 사용자가 직접 고르게 한다.

export function ReferenceCandidatesModal({ pending, onSelect, onCancel }: ReferenceCandidatesModalProps) {
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
          <div className={styles.overlay} onClick={onCancel} />

          <motion.div
            className={styles.card}
            initial={{ scale: 0.94, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 340, damping: 30 }}
          >
            <div className={styles.iconWrap}>
              <Link size={20} className="text-cyan-500" />
            </div>

            <div>
              <p className={styles.title}>Multiple documents match</p>
              <p className={styles.message}>{pending.candidates.length} documents share this value. Pick the one to open.</p>
            </div>

            <div className={styles.list}>
              {pending.candidates.map((candidate, i) => (
                <button
                  key={`${candidate.collection}:${candidate.documentId}:${i}`}
                  type="button"
                  className={styles.candidateBtn}
                  onClick={() => onSelect(candidate)}
                >
                  <span className={styles.candidateTitle}>{candidate.documentTitle}</span>
                  <span className={styles.candidateMeta}>{candidate.collection} · {candidate.documentId}</span>
                </button>
              ))}
            </div>

            <button type="button" className={styles.cancelBtn} onClick={onCancel}>
              Cancel
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
