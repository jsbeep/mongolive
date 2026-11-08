import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'lucide-react';
import type { CollectionSummary, MutationRequest } from '../../../types/explorer';
import { ReferenceFieldsEditor } from './ReferenceFieldsEditor';

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = {
  backdrop: 'fixed inset-0 flex items-center justify-center p-4 inherit',
  overlay: 'absolute inset-0 bg-black/40 backdrop-blur-sm',
  card: 'relative z-[10] w-full max-w-lg bg-white rounded-2xl shadow-elevated p-6 flex flex-col gap-4',
  header: 'flex items-center gap-2',
  iconWrap: 'w-10 h-10 rounded-2xl bg-cyan-50 flex items-center justify-center shrink-0',
  title: 'text-base font-semibold text-slate-900',
  message: 'text-sm text-slate-500 leading-relaxed',
  closeBtn: 'self-end px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors',
} as const;

// ── Props ─────────────────────────────────────────────────────────────────────

interface ReferenceFieldsManagerProps {
  isOpen: boolean;
  database: string;
  collection: string;
  referenceFields: Record<string, { targetCollection: string; targetKey: string }>;
  collections: CollectionSummary[];
  // import 직후 일괄 설정 시 — 파싱된 문서들에서 발견된 필드 키 후보. 그 밖엔 열 때 이 컬렉션 문서 몇 개에서 뽑는다
  suggestedFieldKeys?: string[];
  onMutate: (op: MutationRequest) => Promise<unknown>;
  onClose: () => void;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────
// 컬렉션 가져오기(import) 직후 일괄 설정용 모달 — 그때는 그 컬렉션의 문서 컬럼이 아직 열려 있지 않아서.
// 평소 관리는 문서 컬럼 헤더 아래 패널(DocumentsColumn의 References 패널)에서 한다. 안의 내용은 둘 다 ReferenceFieldsEditor.

export function ReferenceFieldsManager({
  isOpen,
  database,
  collection,
  referenceFields,
  collections,
  suggestedFieldKeys,
  onMutate,
  onClose,
}: ReferenceFieldsManagerProps) {
  // Esc = 닫기(다른 모달과 같게). 입력 중이어도 — 추가 줄은 저장 전이라 잃을 게 적다
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

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
          <div className={styles.overlay} onClick={onClose} />

          <motion.div
            className={styles.card}
            role="dialog"
            aria-modal="true"
            aria-label="References"
            initial={{ scale: 0.94, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 340, damping: 30 }}
          >
            <div className={styles.header}>
              <div className={styles.iconWrap}>
                <Link size={18} className="text-cyan-500" />
              </div>
              <div>
                <p className={styles.title}>Manage references</p>
                <p className={styles.message}>
                  <span className="font-mono text-slate-600">{collection}</span> field → another collection (FK)
                </p>
              </div>
            </div>

            <ReferenceFieldsEditor
              database={database}
              collection={collection}
              referenceFields={referenceFields}
              collections={collections}
              suggestedFieldKeys={suggestedFieldKeys}
              onMutate={onMutate}
              layout="wide"
            />

            <button type="button" className={styles.closeBtn} onClick={onClose}>
              Done
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
