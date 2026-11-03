import { useState } from 'react';
import { FileText, Tag, Check, X, ArrowLeft, KeyRound, Lock, Link, AlertTriangle, Filter } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { ActivePath, CollectionSummary, DocumentSummary, JsonObject, MutationRequest } from '../../../types/explorer';
import { ColumnItem, ColumnSkeletonList } from './ColumnItem';
import { AddItemButton } from './AddItemButton';
import { DropOverlay } from './DropOverlay';
import { InlineSegmentEditor } from '../../editors/InlineSegmentEditor';
import { DeleteConfirmModal } from '../../common/DeleteConfirmModal';
import { ReferenceFieldsManager } from './ReferenceFieldsManager';
import { cn } from '../../../utils/cn';
import { api } from '../../../services/api';
import { columnListStyles as styles } from './columnListStyles';
import { isPathChanged } from '../../../utils/changedPaths';
import { useFileDrop } from '../../../hooks/useFileDrop';
import { FilterSortToolbar, type SortOption } from './FilterSortToolbar';

const DOCUMENT_SORT_OPTIONS: SortOption[] = [
  { value: 'none', label: 'Default order' },
  { value: 'title-asc', label: 'Title A→Z' },
  { value: 'title-desc', label: 'Title Z→A' },
  { value: 'fields-desc', label: 'Most fields' },
  { value: 'fields-asc', label: 'Fewest fields' },
  { value: 'updated-desc', label: 'Recently updated' },
  { value: 'updated-asc', label: 'Oldest updated' },
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface DocumentsColumnProps {
  path: ActivePath;
  documents: DocumentSummary[];
  collections: CollectionSummary[];
  activeDocumentOid: string | null;
  isLoading: boolean;
  changedPaths: string[];
  editingId: string | null;
  activeCollectionName: string | null;
  activeDatabaseName: string | null;
  reduceMotion?: boolean;
  onSelectDocument: (oid: string, title: string) => Promise<void>;
  onMutate: (op: MutationRequest) => Promise<unknown>;
  onSetEditingId: (id: string | null) => void;
  // 컬럼 2개(최소) 모드에서 Collections/Documents가 한 패널을 공유할 때만 전달됨 —
  // 있으면 목록 맨 위에 컬렉션 목록으로 돌아가는 큰 버튼을 보여준다
  onBack?: () => void;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export function DocumentsColumn({
  path,
  documents,
  collections,
  activeDocumentOid,
  isLoading,
  changedPaths,
  editingId,
  activeCollectionName,
  activeDatabaseName,
  reduceMotion,
  onSelectDocument,
  onMutate,
  onSetEditingId,
  onBack,
}: DocumentsColumnProps) {
  const [deleteTarget, setDeleteTarget] = useState<DocumentSummary | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const collectionLabel = path.kind === 'normal' ? path.label : '';
  const activeCollectionSummary = collections.find((c) => c.name === activeCollectionName);
  const currentTitleKey = activeCollectionSummary?.titleKey;
  const currentPrimaryKey = activeCollectionSummary?.primaryKey;
  // _id.$oid를 쓰는 문서가 하나라도 있으면 PK는 항상 '_id' — 기존 oid REF 메커니즘을 따른다
  const isPrimaryKeyLocked = activeCollectionSummary?.hasOidIds ?? false;
  // 현재 PK(또는 기본값 _id) 필드가 없는 문서가 하나라도 있으면 경고 표시
  const hasPrimaryKeyGaps = activeCollectionSummary?.hasPrimaryKeyGaps ?? false;
  const referenceFields = activeCollectionSummary?.referenceFields ?? {};

  const [isEditingTitleKey, setIsEditingTitleKey] = useState(false);
  const [titleKeyInput, setTitleKeyInput] = useState('');
  const [isEditingPrimaryKey, setIsEditingPrimaryKey] = useState(false);
  const [primaryKeyInput, setPrimaryKeyInput] = useState('');
  const [isManagingRefs, setIsManagingRefs] = useState(false);

  // 문서 검색/정렬 — 토글 가능한 보조 툴바 (헤더의 필터 아이콘)
  const [isDocToolbarOpen, setIsDocToolbarOpen] = useState(false);
  const [docFilterText, setDocFilterText] = useState('');
  const [docSortMode, setDocSortMode] = useState('none');
  const isDocFilterActive = docFilterText.trim().length > 0 || docSortMode !== 'none';

  const displayDocuments = (() => {
    const needle = docFilterText.trim().toLowerCase();
    let result = !needle
      ? documents
      : documents.filter((doc) => doc.title.toLowerCase().includes(needle) || doc.preview.toLowerCase().includes(needle));
    switch (docSortMode) {
      case 'title-asc':
        result = [...result].sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'title-desc':
        result = [...result].sort((a, b) => b.title.localeCompare(a.title));
        break;
      case 'fields-asc':
        result = [...result].sort((a, b) => a.fieldCount - b.fieldCount);
        break;
      case 'fields-desc':
        result = [...result].sort((a, b) => b.fieldCount - a.fieldCount);
        break;
      case 'updated-asc':
        result = [...result].sort((a, b) => a.updatedAt - b.updatedAt);
        break;
      case 'updated-desc':
        result = [...result].sort((a, b) => b.updatedAt - a.updatedAt);
        break;
      default:
        break;
    }
    return result;
  })();

  // 컬럼 전체에 파일을 드롭하면 "문서 추가" 에디터를 열고 그 파일을 업로드한 것처럼 처리
  const { isDragOver: isColumnDragOver, dragHandlers } = useFileDrop((file) => {
    onSetEditingId('document:__new__');
    setPendingImportFile(file);
  });

  const handleDeleteDocument = async () => {
    if (!deleteTarget || !activeCollectionName || !activeDatabaseName) return;
    await onMutate({
      type: 'deleteDocument',
      database: activeDatabaseName,
      collection: activeCollectionName,
      documentId: deleteTarget.id,
    });
    setDeleteTarget(null);
  };

  const handleSaveTitleKey = async () => {
    if (!activeCollectionName || !activeDatabaseName) return;
    await onMutate({
      type: 'setCollectionTitleKey',
      database: activeDatabaseName,
      collection: activeCollectionName,
      titleKey: titleKeyInput.trim(),
    });
    setIsEditingTitleKey(false);
  };

  const handleSavePrimaryKey = async () => {
    if (!activeCollectionName || !activeDatabaseName) return;
    await onMutate({
      type: 'setCollectionPrimaryKey',
      database: activeDatabaseName,
      collection: activeCollectionName,
      primaryKey: primaryKeyInput.trim(),
    });
    setIsEditingPrimaryKey(false);
  };

  return (
    <div className={styles.container} {...dragHandlers}>
      <DropOverlay visible={isColumnDragOver} label="Drop a file to import as a document" />

      {/* 헤더 */}
      <div className={styles.header}>
        {isEditingTitleKey ? (
          <>
            <span className="text-[13px] font-semibold text-slate-700 truncate">Title Field</span>
            <input
              autoFocus
              type="text"
              className="flex-1 min-w-0 text-xs px-2 py-1 rounded-lg bg-slate-100/80 text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 focus:bg-white transition-all"
              placeholder="Field key to use as title (e.g. name)"
              value={titleKeyInput}
              onChange={(e) => setTitleKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSaveTitleKey();
                if (e.key === 'Escape') setIsEditingTitleKey(false);
              }}
            />
            <button
              type="button"
              className="p-1.5 rounded-lg text-emerald-500 hover:bg-emerald-50 transition-colors shrink-0"
              onClick={() => void handleSaveTitleKey()}
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 transition-colors shrink-0"
              onClick={() => setIsEditingTitleKey(false)}
            >
              <X size={14} />
            </button>
          </>
        ) : isEditingPrimaryKey ? (
          <>
            <input
              autoFocus
              type="text"
              className="flex-1 min-w-0 text-xs px-2 py-1 rounded-lg bg-slate-100/80 text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400/60 focus:bg-white transition-all"
              placeholder="Field key to use as primary key (e.g. code)"
              value={primaryKeyInput}
              onChange={(e) => setPrimaryKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSavePrimaryKey();
                if (e.key === 'Escape') setIsEditingPrimaryKey(false);
              }}
            />
            <button
              type="button"
              className="p-1.5 rounded-lg text-emerald-500 hover:bg-emerald-50 transition-colors shrink-0"
              onClick={() => void handleSavePrimaryKey()}
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 transition-colors shrink-0"
              onClick={() => setIsEditingPrimaryKey(false)}
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            <div className="relative flex items-center gap-0 leading-none mr-0.5">
              <FileText size={15} className={styles.headerIcon} />
              <span className="absolute pl-[1px] -bottom-[0.2rem] right-0.5 translate-x-1/2 text-xs font-mono text-slate-500 tabular-nums shrink-0 leading-[0.9] bg-white rounded-s">
                {isDocFilterActive ? `${displayDocuments.length}/${documents.length}` : documents.length}
              </span>
            </div>
            <span className={styles.headerTitle}>{collectionLabel}</span>
            <button
              type="button"
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200/70 text-slate-500 hover:text-slate-700 transition-colors shrink-0',
                !activeCollectionName && 'opacity-40 pointer-events-none',
              )}
              data-tt="Title field — which field labels each document in this list"
              onClick={() => {
                setTitleKeyInput(currentTitleKey ?? 'name');
                setIsEditingTitleKey(true);
              }}
            >
              <Tag size={12} />
              <span className="text-[11px] font-mono">{currentTitleKey ?? 'name'}</span>
            </button>
            <button
              type="button"
              className={cn(
                'relative flex items-center gap-1 px-2 py-1 rounded-lg transition-colors shrink-0',
                hasPrimaryKeyGaps ? 'bg-red-50 hover:bg-red-100 text-red-500 hover:text-red-600' : 'bg-slate-100 hover:bg-slate-200/70 text-slate-500 hover:text-slate-700',
                (!activeCollectionName || isPrimaryKeyLocked) && 'opacity-40 pointer-events-none',
              )}
              data-tt={
                isPrimaryKeyLocked
                  ? 'Primary key — locked to _id for ObjectId collections'
                  : hasPrimaryKeyGaps
                    ? `Some documents are missing the primary key field (${currentPrimaryKey ?? '_id'})`
                    : 'Primary key — the field other collections reference this one by'
              }
              onClick={() => {
                if (isPrimaryKeyLocked) return;
                setPrimaryKeyInput(currentPrimaryKey ?? '_id');
                setIsEditingPrimaryKey(true);
              }}
            >
              {hasPrimaryKeyGaps && (
                <AlertTriangle size={10} className="absolute -top-1.5 -right-1.5 text-red-500 bg-white rounded-full" />
              )}
              {isPrimaryKeyLocked ? <Lock size={12} /> : <KeyRound size={12} />}
              <span className="text-[11px] font-mono">{isPrimaryKeyLocked ? '_id' : currentPrimaryKey ?? '_id'}</span>
            </button>
            <button
              type="button"
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200/70 text-slate-500 hover:text-slate-700 transition-colors shrink-0',
                !activeCollectionName && 'opacity-40 pointer-events-none',
              )}
              data-tt="References — declare which fields link to another collection, then click them to jump"
              onClick={() => setIsManagingRefs(true)}
            >
              <Link size={12} />
              <span className="text-[11px] font-mono">{Object.keys(referenceFields).length}</span>
            </button>
            <button
              type="button"
              className={cn(
                'relative p-1.5 rounded-lg transition-colors shrink-0',
                isDocToolbarOpen || isDocFilterActive ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600',
              )}
              data-tt="Filter / sort documents in this collection"
              onClick={() => setIsDocToolbarOpen((v) => !v)}
            >
              {isDocFilterActive && !isDocToolbarOpen && (
                <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500" />
              )}
              <Filter size={13} />
            </button>
          </>
        )}
      </div>

      {/* 문서 검색/정렬 툴바 */}
      {isDocToolbarOpen && (
        <FilterSortToolbar
          filterText={docFilterText}
          onFilterTextChange={setDocFilterText}
          filterPlaceholder="Search title or preview…"
          sortValue={docSortMode}
          onSortChange={setDocSortMode}
          sortOptions={DOCUMENT_SORT_OPTIONS}
        />
      )}

      {/* 목록 */}
      <div className={styles.list}>
        {onBack && (
          <button
            type="button"
            className="relative flex items-center gap-3 px-4 py-3.5 rounded-2xl cursor-pointer select-none text-left hover:bg-slate-50/80 active:bg-slate-100/50 transition-colors"
            onClick={onBack}
          >
            <span className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center bg-slate-100 text-slate-500">
              <ArrowLeft size={16} />
            </span>
            <span className="text-sm font-medium text-slate-600">Back to Collections</span>
          </button>
        )}
        {isLoading && !documents.length ? (
          <ColumnSkeletonList count={5} />
        ) : (
          displayDocuments.map((doc) => {
            const isEditing = editingId === `document:${doc.id}`;
            const isHighlighted = activeDatabaseName && activeCollectionName
              ? isPathChanged(changedPaths, `databases.${activeDatabaseName}.collections.${activeCollectionName}.documents.${doc.id}`)
              : false;

            if (isEditing) {
              return (
                <InlineSegmentEditor
                  key={doc.id}
                  mode="edit"
                  level="document"
                  initialKey={doc.title}
                  siblingKeys={[]}
                  onExportRequest={() => api.getFullDocumentByIdInCollection(activeDatabaseName ?? '', activeCollectionName ?? '', doc.id)}
                  onSubmit={async (data) => {
                    if (!activeCollectionName || !activeDatabaseName) return;
                    await onMutate({
                      type: 'mutateField',
                      database: activeDatabaseName,
                      collection: activeCollectionName,
                      documentId: doc.id,
                      field: { path: [], key: currentTitleKey ?? 'name', action: 'edit', value: data.key, containerType: 'object' },
                    });
                    onSetEditingId(null);
                  }}
                  onCancel={() => onSetEditingId(null)}
                  onDelete={() => setDeleteTarget(doc)}
                  onDuplicate={async () => {
                    if (!activeCollectionName || !activeDatabaseName) return;
                    await onMutate({
                      type: 'duplicateDocument',
                      database: activeDatabaseName,
                      collection: activeCollectionName,
                      documentId: doc.id,
                    });
                    onSetEditingId(null);
                  }}
                />
              );
            }

            return (
              <ColumnItem
                key={doc.id}
                label={doc.title}
                meta={doc.preview}
                isActive={activeDocumentOid === doc.id}
                isHighlighted={isHighlighted}
                variant="document"
                reduceMotion={reduceMotion}
                onSelect={() => void onSelectDocument(doc.id, doc.title)}
                onEdit={() => onSetEditingId(`document:${doc.id}`)}
                onDelete={() => setDeleteTarget(doc)}
              />
            );
          })
        )}

        {/* 추가 카드 */}
        {editingId === 'document:__new__' ? (
          <InlineSegmentEditor
            mode="add"
            level="document"
            siblingKeys={[]}
            onSubmit={async (data) => {
              if (!activeCollectionName || !activeDatabaseName) return;
              // _id(있으면 oid든 plain 값이든)는 손대지 않고 그대로 넘긴다 — 없거나 깨져있으면
              // upsertDocument 핸들러가 ensureDocumentId로 채워준다
              const newDoc: JsonObject =
                data.importedJson && typeof data.importedJson === 'object' && !Array.isArray(data.importedJson)
                  ? (data.importedJson as JsonObject)
                  : { [currentTitleKey ?? 'name']: data.key };
              await onMutate({
                type: 'upsertDocument',
                database: activeDatabaseName,
                collection: activeCollectionName,
                document: newDoc,
              });
              onSetEditingId(null);
            }}
            onCancel={() => onSetEditingId(null)}
            pendingImportFile={pendingImportFile}
            onPendingImportFileConsumed={() => setPendingImportFile(null)}
          />
        ) : (
          <AddItemButton
            label="Add Document"
            onClick={() => onSetEditingId('document:__new__')}
            buttonClassName={styles.addCard}
            iconClassName={styles.addCardIcon}
            textClassName={styles.addCardText}
            reduceMotion={reduceMotion}
          />
        )}
        {!documents.length && (
          <div className={styles.empty}>
            <FileText size={28} className="opacity-30" />
            <span>No documents</span>
          </div>
        )}
        {!!documents.length && !displayDocuments.length && (
          <div className={styles.empty}>
            <FileText size={28} className="opacity-30" />
            <span>No documents match the filter</span>
          </div>
        )}
      </div>

      {/* 삭제 확인 모달 */}
      {deleteTarget && createPortal(
        <DeleteConfirmModal
          isOpen={!!deleteTarget}
          targetType="document"
          targetLabel={deleteTarget.title}
          onConfirm={handleDeleteDocument}
          onCancel={() => setDeleteTarget(null)}
        />,
        document.body,
      )}

      {/* 참조(FK) 관리 모달 */}
      {isManagingRefs && activeDatabaseName && activeCollectionName && createPortal(
        <ReferenceFieldsManager
          isOpen={isManagingRefs}
          database={activeDatabaseName}
          collection={activeCollectionName}
          referenceFields={referenceFields}
          collections={collections}
          onMutate={onMutate}
          onClose={() => setIsManagingRefs(false)}
        />,
        document.body,
      )}
    </div>
  );
}
