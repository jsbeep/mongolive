import { useEffect, useRef, useState } from 'react';
import { FileText, Tag, Check, X, ArrowLeft, Link, Filter } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { ActivePath, CollectionSummary, DocumentSort, DocumentSummary, JsonObject, MutationRequest } from '../../../types/explorer';
import type { DocumentListQuery, DocumentPageInfo } from '../../../hooks/useExplorerState';
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
import { FILTER_DOT_CLASS, HeaderTitle } from './HeaderTitle';
import { canEditIn, useServerSettings } from '../../../services/serverSettings';
import { FilterSortToolbar, type SortOption } from './FilterSortToolbar';
import { PageRail, PageTransition } from './PageRail';

const DOCUMENT_SORT_OPTIONS: SortOption[] = [
  { value: 'none', label: 'Default order' },
  { value: 'title-asc', label: 'Title A→Z' },
  { value: 'title-desc', label: 'Title Z→A' },
  { value: 'fields-desc', label: 'Most fields' },
  { value: 'fields-asc', label: 'Fewest fields' },
  { value: 'updated-desc', label: 'Recently updated' },
  { value: 'updated-asc', label: 'Oldest updated' },
];

// 검색어 입력이 멈춘 뒤 이만큼 기다렸다가 요청 — 글자마다 서버에 묻지 않도록
const FILTER_DEBOUNCE_MS = 250;

// ── Props ─────────────────────────────────────────────────────────────────────

// 문서 목록의 페이지·검색·정렬 — 실제 처리는 데이터 소스(Mock/서버)가 하고 여기선 보여주기만 한다
export interface DocumentListControls {
  page: DocumentPageInfo | null;
  query: DocumentListQuery;
  onQueryChange: (patch: Partial<DocumentListQuery>) => void;
}

interface DocumentsColumnProps {
  path: ActivePath;
  documents: DocumentSummary[];
  documentList: DocumentListControls;
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
  documentList,
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
  const referenceFields = activeCollectionSummary?.referenceFields ?? {};

  const [isEditingTitleKey, setIsEditingTitleKey] = useState(false);
  const [titleKeyInput, setTitleKeyInput] = useState('');
  const [isManagingRefs, setIsManagingRefs] = useState(false);

  // 문서 검색/정렬 — 토글 가능한 보조 툴바 (헤더의 필터 아이콘). 거르기·정렬·페이지 자르기는
  // 데이터 소스가 하고(현재 페이지만 받아오므로 브라우저에서 정렬하면 그 페이지 안에서만 섞인다),
  // 여기서는 입력값만 넘긴다.
  const [isDocToolbarOpen, setIsDocToolbarOpen] = useState(false);
  const { page: pageInfo, query, onQueryChange } = documentList;
  const [filterInput, setFilterInput] = useState(query.filter);
  // 컬렉션이 바뀌어 검색어가 초기화되면 입력창도 맞춘다
  useEffect(() => { setFilterInput(query.filter); }, [query.filter]);
  useEffect(() => {
    if (filterInput === query.filter) return;
    const timer = setTimeout(() => onQueryChange({ filter: filterInput }), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // query.filter가 바뀐 경우는 위 effect가 입력창을 맞추므로 여기선 입력값 변화에만 반응
  }, [filterInput]); // eslint-disable-line react-hooks/exhaustive-deps
  const isDocFilterActive = query.filter.trim().length > 0 || query.sort !== 'none';
  const totalAll = pageInfo?.totalUnfiltered ?? documents.length;
  const totalMatched = pageInfo?.total ?? documents.length;
  const pageCount = pageInfo ? Math.ceil(pageInfo.total / pageInfo.pageSize) : 1;
  // 선택된 문서가 있는 페이지 — 지금 페이지에 보이면 지금 페이지, 아니면 서버가 알려준 페이지.
  // 서버 값은 그걸 계산할 때의 선택(markId)이 지금 선택과 같을 때만 믿는다.
  const markedPage = !activeDocumentOid
    ? undefined
    : documents.some((d) => d.id === activeDocumentOid)
      ? pageInfo?.page
      : pageInfo?.markId === activeDocumentOid
        ? pageInfo.markedPage
        : undefined;

  // 페이지를 바꾸면 목록 맨 위부터 보이게
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.scrollTo({ top: 0 }); }, [query.page]);

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

  // 안전장치(설정 창 › Safety): read-only거나 이 컬렉션(또는 DB)이 보호 대상이면 편집·추가·파일 드롭을 숨긴다
  const canEditHere = canEditIn(useServerSettings(), activeDatabaseName, activeCollectionName);

  return (
    // data-nav-col: 키보드 탐색의 컬럼 번호 = 경로 번호(문서 목록은 늘 1)
    <div data-nav-col={1} className={styles.container} {...(canEditHere ? dragHandlers : {})}>
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
        ) : (
          <>
            <FileText size={15} className={styles.headerIcon} />
            <HeaderTitle title={collectionLabel} total={totalAll} matched={isDocFilterActive ? totalMatched : undefined} />
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
                <span className={FILTER_DOT_CLASS} />
              )}
              <Filter size={13} />
            </button>
          </>
        )}
      </div>

      {/* 문서 검색/정렬 툴바 */}
      {isDocToolbarOpen && (
        <FilterSortToolbar
          filterText={filterInput}
          onFilterTextChange={setFilterInput}
          filterPlaceholder="Search title or preview…"
          sortValue={query.sort}
          onSortChange={(value) => onQueryChange({ sort: value as DocumentSort })}
          sortOptions={DOCUMENT_SORT_OPTIONS}
        />
      )}

      {/* 목록 + 오른쪽 페이지 레일 */}
      <div className="flex flex-1 min-h-0">
      <div ref={listRef} className={styles.list}>
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
          <PageTransition
            /* 전환 기준은 클릭한 번호(query.page)가 아니라 실제로 받아 온 페이지(pageInfo.page) —
               응답 전에 펼쳐지면 이전 페이지 내용이 잠깐 다시 보인다 */
            pageKey={pageInfo?.page ?? 0}
            disabled={reduceMotion}
            className="flex flex-col gap-0.5"
          >
          {documents.map((doc) => {
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
                onEdit={canEditHere ? () => onSetEditingId(`document:${doc.id}`) : undefined}
                onDelete={canEditHere ? () => setDeleteTarget(doc) : undefined}
              />
            );
          })}
          </PageTransition>
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
        ) : canEditHere && (
          <AddItemButton
            label="Add Document"
            onClick={() => onSetEditingId('document:__new__')}
            buttonClassName={styles.addCard}
            iconClassName={styles.addCardIcon}
            textClassName={styles.addCardText}
            reduceMotion={reduceMotion}
          />
        )}
        {!isLoading && totalAll === 0 && (
          <div className={styles.empty}>
            <FileText size={28} className="opacity-30" />
            <span>No documents</span>
          </div>
        )}
        {totalAll > 0 && totalMatched === 0 && (
          <div className={styles.empty}>
            <FileText size={28} className="opacity-30" />
            <span>No documents match the filter</span>
          </div>
        )}
      </div>
      <PageRail
        page={query.page}
        pageCount={pageCount}
        markedPage={markedPage}
        isBusy={isLoading}
        onChange={(page) => onQueryChange({ page })}
      />
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
