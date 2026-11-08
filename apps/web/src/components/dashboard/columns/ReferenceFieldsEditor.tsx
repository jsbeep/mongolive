// 참조(FK) 선언 — "이 컬렉션의 어떤 필드가 어느 컬렉션의 어떤 키를 가리키는지". 목록(× 지우기) + 추가 줄.
// 두 곳이 같이 쓴다: 문서 컬럼 헤더 아래 패널(DocumentsColumn의 References 패널, 좁아서 두 줄 배치)과
// 컬렉션 가져오기 직후 일괄 설정 모달(ReferenceFieldsManager, 넓어서 한 줄 배치).
import { useEffect, useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { CollectionSummary, MutationRequest } from '../../../types/explorer';
import { loadReferenceKeys, loadTopLevelKeys } from '../../../services/fieldSuggestions';
import { cn } from '../../../utils/cn';

const styles = {
  list: 'flex flex-col gap-1.5 max-h-48 overflow-y-auto -mx-1 px-1',
  row: 'flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 border border-slate-100',
  rowField: 'font-mono text-slate-700 shrink-0 truncate max-w-[45%]',
  rowArrow: 'text-slate-300 shrink-0',
  rowTarget: 'font-mono text-cyan-600 truncate flex-1',
  removeBtn: 'p-1 rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 transition-colors shrink-0',
  addGroup: 'flex flex-col gap-1 min-w-0',
  addLabel: 'text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-0.5',
  addArrow: 'text-slate-300 shrink-0 text-sm',
  addTargetControls: 'flex items-center gap-1 min-w-0',
  addDot: 'text-slate-300 shrink-0 text-xs',
  input: 'w-full min-w-0 text-xs px-2 py-1.5 rounded-lg bg-slate-100/80 text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 focus:bg-white transition-all font-mono',
  addBtn: 'shrink-0 flex items-center justify-center w-[30px] h-[30px] rounded-lg text-white bg-cyan-500 hover:bg-cyan-600 transition-colors disabled:opacity-40 disabled:pointer-events-none',
} as const;

export interface ReferenceFieldsEditorProps {
  database: string;
  collection: string;
  referenceFields: Record<string, { targetCollection: string; targetKey: string }>;
  collections: CollectionSummary[];
  // import 직후 — 파싱된 문서들에서 발견된 키(문서에서 뽑은 후보와 합친다)
  suggestedFieldKeys?: string[];
  onMutate: (op: MutationRequest) => Promise<unknown>;
  // wide = 한 줄([Field key] → [컬렉션 . 키] [+]), compact = 두 줄(좁은 컬럼)
  layout: 'wide' | 'compact';
  // 열리자마자 Field key 입력칸으로
  autoFocus?: boolean;
}

export function ReferenceFieldsEditor({
  database,
  collection,
  referenceFields,
  collections,
  suggestedFieldKeys,
  onMutate,
  layout,
  autoFocus,
}: ReferenceFieldsEditorProps) {
  const [newField, setNewField] = useState('');
  const [newTargetCollection, setNewTargetCollection] = useState('');
  const [newTargetKey, setNewTargetKey] = useState('');
  const compact = layout === 'compact';

  const handleRemove = async (field: string) => {
    await onMutate({ type: 'setCollectionReferenceField', database, collection, field });
  };

  const canAdd = !!newField.trim() && !!newTargetCollection && !!newTargetKey.trim();
  const handleAdd = async () => {
    if (!canAdd) return;
    await onMutate({
      type: 'setCollectionReferenceField',
      database,
      collection,
      field: newField.trim(),
      targetCollection: newTargetCollection,
      targetKey: newTargetKey.trim(),
    });
    setNewField('');
    setNewTargetCollection('');
    setNewTargetKey('');
  };

  // 자동완성 후보(입력칸 + datalist — 목록에 없는 키도 쓸 수 있다)
  //   Field key: 이 컬렉션 문서 몇 개에서 글자·숫자 값을 가진 키 이름(참조는 키 이름으로 맞춘다)
  //   대상 키: 고른 대상 컬렉션 문서의 맨 위 키(대상 문서를 찾을 때 맨 위 필드로 비교한다)
  const [loadedFieldKeys, setLoadedFieldKeys] = useState<string[]>([]);
  const [targetKeys, setTargetKeys] = useState<string[]>([]);
  const fieldListId = useId();
  const targetListId = useId();
  useEffect(() => {
    let alive = true;
    loadReferenceKeys(database, collection).then((keys) => alive && setLoadedFieldKeys(keys)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [database, collection]);
  useEffect(() => {
    if (!newTargetCollection) {
      setTargetKeys([]);
      return;
    }
    let alive = true;
    loadTopLevelKeys(database, newTargetCollection).then((keys) => alive && setTargetKeys(keys)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [database, newTargetCollection]);
  const availableSuggestions = [...new Set([...(suggestedFieldKeys ?? []), ...loadedFieldKeys])].filter((k) => !(k in referenceFields));

  const fieldInput = (
    <div className={cn(styles.addGroup, !compact && 'flex-1')}>
      <span className={styles.addLabel}>Field key</span>
      <input
        type="text"
        autoFocus={autoFocus}
        className={styles.input}
        placeholder={`e.g. ${availableSuggestions[0] ?? 'authorId'}`}
        aria-label="Field key"
        list={fieldListId}
        spellCheck={false}
        autoCapitalize="off"
        value={newField}
        onChange={(e) => setNewField(e.target.value)}
      />
      <datalist id={fieldListId}>
        {availableSuggestions.map((key) => <option key={key} value={key} />)}
      </datalist>
    </div>
  );

  const targetControls = (
    <div className={styles.addTargetControls}>
      <select
        className={styles.input}
        aria-label="Target collection"
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
        className={cn(styles.input, compact && 'max-w-[40%]')}
        placeholder="_id"
        aria-label="Target key"
        list={targetListId}
        spellCheck={false}
        autoCapitalize="off"
        value={newTargetKey}
        onChange={(e) => setNewTargetKey(e.target.value)}
      />
      <datalist id={targetListId}>
        {targetKeys.map((key) => <option key={key} value={key} />)}
      </datalist>
    </div>
  );

  const addButton = (
    <button type="button" className={styles.addBtn} data-tt="Add reference" aria-label="Add reference" disabled={!canAdd} onClick={() => void handleAdd()}>
      <Plus size={15} />
    </button>
  );

  return (
    <div
      className="flex flex-col gap-3"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && canAdd && (e.target as Element).tagName === 'INPUT') {
          e.preventDefault();
          void handleAdd();
        }
      }}
    >
      {Object.keys(referenceFields).length > 0 && (
        <div className={cn(styles.list, compact ? 'text-xs' : 'text-sm')}>
          {Object.entries(referenceFields).map(([field, ref]) => (
            <div key={field} className={cn(styles.row, compact && 'px-2.5 py-1.5')}>
              <span className={styles.rowField} title={field}>{field}</span>
              <span className={styles.rowArrow}>→</span>
              <span className={styles.rowTarget} title={`${ref.targetCollection}.${ref.targetKey}`}>{ref.targetCollection}.{ref.targetKey}</span>
              <button type="button" className={styles.removeBtn} aria-label={`Remove ${field}`} onClick={() => void handleRemove(field)}>
                <X size={compact ? 12 : 14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {compact ? (
        // 두 줄: Field key / → 대상 컬렉션 . 키 [+]
        <div className="flex flex-col gap-2">
          {fieldInput}
          <div className={styles.addGroup}>
            <span className={styles.addLabel}>→ Target</span>
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">{targetControls}</div>
              {addButton}
            </div>
          </div>
        </div>
      ) : (
        // 한 줄: [Field key] → [컬렉션 . 키] [+] — 위 목록의 "field → collection.key"와 같은 모양
        <div className="flex items-end gap-2 border-t border-slate-100 pt-3">
          {fieldInput}
          <span className={cn(styles.addArrow, 'pb-2')}>→</span>
          <div className={cn(styles.addGroup, 'flex-[1.6]')}>
            <span className={styles.addLabel}>Target</span>
            {targetControls}
          </div>
          {addButton}
        </div>
      )}
    </div>
  );
}
