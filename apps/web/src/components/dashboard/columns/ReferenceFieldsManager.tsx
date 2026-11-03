import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link, X, Plus } from 'lucide-react';
import type { CollectionSummary, MutationRequest } from '../../../types/explorer';

// ── 스타일 ────────────────────────────────────────────────────────────────────

const styles = {
  backdrop: 'fixed inset-0 flex items-center justify-center p-4 inherit',
  overlay: 'absolute inset-0 bg-slate-900/40 backdrop-blur-sm',
  card: 'relative z-[10] w-full max-w-lg bg-white rounded-2xl shadow-elevated p-6 flex flex-col gap-4',
  header: 'flex items-center gap-2',
  iconWrap: 'w-10 h-10 rounded-2xl bg-cyan-50 flex items-center justify-center shrink-0',
  title: 'text-base font-semibold text-slate-900',
  message: 'text-sm text-slate-500 leading-relaxed',
  list: 'flex flex-col gap-1.5 max-h-48 overflow-y-auto -mx-1 px-1',
  row: 'flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 border border-slate-100 text-sm',
  rowField: 'font-mono text-slate-700 shrink-0',
  rowArrow: 'text-slate-300 shrink-0',
  rowTarget: 'font-mono text-cyan-600 truncate flex-1',
  removeBtn: 'p-1 rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 transition-colors shrink-0',
  // 한 줄짜리 선언 행 — [Field key] → [Target collection.key] [+] 로 읽히게 배치한다.
  // 위 목록의 "field → collection.key" 행과 같은 모양이라 무엇을 만드는지가 바로 보인다.
  addRow: 'flex items-end gap-2 pt-3 border-t border-slate-100',
  addGroup: 'flex flex-col gap-1 min-w-0',
  addLabel: 'text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-0.5',
  addArrow: 'text-slate-300 shrink-0 pb-2 text-sm',
  addTargetControls: 'flex items-center gap-1 min-w-0',
  addDot: 'text-slate-300 shrink-0 text-xs',
  select: 'w-full min-w-0 text-xs px-2 py-1.5 rounded-lg bg-slate-100/80 text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 focus:bg-white transition-all font-mono',
  addBtn: 'shrink-0 flex items-center justify-center w-[30px] h-[30px] rounded-lg text-white bg-cyan-500 hover:bg-cyan-600 transition-colors disabled:opacity-40 disabled:pointer-events-none',
  closeBtn: 'self-end px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors',
} as const;

// ── Props ─────────────────────────────────────────────────────────────────────

interface ReferenceFieldsManagerProps {
  isOpen: boolean;
  database: string;
  collection: string;
  referenceFields: Record<string, { targetCollection: string; targetKey: string }>;
  collections: CollectionSummary[];
  // import 직후 일괄 설정 시 — 파싱된 문서들에서 발견된 필드 키 후보(없으면 자유 입력)
  suggestedFieldKeys?: string[];
  onMutate: (op: MutationRequest) => Promise<unknown>;
  onClose: () => void;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────
// 컬렉션 단위로 "어떤 필드가 어떤 컬렉션의 어떤 키를 가리키는지" 선언하는 곳 — 한 곳뿐이고
// 평상시 관리와 import 직후 일괄 설정에서 똑같이 재사용된다.

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
  const [newField, setNewField] = useState('');
  const [newTargetCollection, setNewTargetCollection] = useState('');
  const [newTargetKey, setNewTargetKey] = useState('');

  const resetAddRow = () => {
    setNewField('');
    setNewTargetCollection('');
    setNewTargetKey('');
  };

  const handleRemove = async (field: string) => {
    await onMutate({ type: 'setCollectionReferenceField', database, collection, field });
  };

  const handleAdd = async () => {
    if (!newField.trim() || !newTargetCollection || !newTargetKey.trim()) return;
    await onMutate({
      type: 'setCollectionReferenceField',
      database,
      collection,
      field: newField.trim(),
      targetCollection: newTargetCollection,
      targetKey: newTargetKey.trim(),
    });
    resetAddRow();
  };

  const availableSuggestions = (suggestedFieldKeys ?? []).filter((k) => !(k in referenceFields));

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

            {Object.keys(referenceFields).length > 0 && (
              <div className={styles.list}>
                {Object.entries(referenceFields).map(([field, ref]) => (
                  <div key={field} className={styles.row}>
                    <span className={styles.rowField}>{field}</span>
                    <span className={styles.rowArrow}>→</span>
                    <span className={styles.rowTarget}>{ref.targetCollection}.{ref.targetKey}</span>
                    <button type="button" className={styles.removeBtn} onClick={() => void handleRemove(field)}>
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className={styles.addRow}>
              <div className={`${styles.addGroup} flex-1`}>
                <span className={styles.addLabel}>Field key</span>
                {availableSuggestions.length > 0 ? (
                  <select className={styles.select} value={newField} onChange={(e) => setNewField(e.target.value)}>
                    <option value="">Select…</option>
                    {availableSuggestions.map((key) => (
                      <option key={key} value={key}>{key}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className={styles.select}
                    placeholder="authorId"
                    value={newField}
                    onChange={(e) => setNewField(e.target.value)}
                  />
                )}
              </div>

              <span className={styles.addArrow}>→</span>

              <div className={`${styles.addGroup} flex-[1.6]`}>
                <span className={styles.addLabel}>Target</span>
                <div className={styles.addTargetControls}>
                  <select
                    className={styles.select}
                    value={newTargetCollection}
                    onChange={(e) => {
                      const targetCollection = e.target.value;
                      setNewTargetCollection(targetCollection);
                      const target = collections.find((c) => c.name === targetCollection);
                      setNewTargetKey(target?.primaryKey ?? '_id');
                    }}
                  >
                    <option value="">Collection…</option>
                    {collections.map((c) => (
                      <option key={c.name} value={c.name}>{c.label || c.name}</option>
                    ))}
                  </select>
                  <span className={styles.addDot}>.</span>
                  <input
                    type="text"
                    className={styles.select}
                    placeholder="_id"
                    value={newTargetKey}
                    onChange={(e) => setNewTargetKey(e.target.value)}
                  />
                </div>
              </div>

              <button
                type="button"
                className={styles.addBtn}
                data-tt="Add reference"
                disabled={!newField.trim() || !newTargetCollection || !newTargetKey.trim()}
                onClick={() => void handleAdd()}
              >
                <Plus size={15} />
              </button>
            </div>

            <button type="button" className={styles.closeBtn} onClick={onClose}>
              Done
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
