import { useEffect, useRef, useState } from 'react';
import { FileText, Tag, Check, X, ArrowLeft, Link, Search, ArrowUpDown, ArrowDownAZ, ArrowDownZA, ArrowDownWideNarrow, ArrowDownNarrowWide, ClockArrowDown, ClockArrowUp } from 'lucide-react';
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
import { PageEdge, useOverscrollPaging } from './PageEdge';
import { QueryBar } from './QueryBar';
import { closeSearchPanel, openSearchPanel, useSearchPanel } from '../../../services/queryPanel';
import { useHeaderFold } from '../../../hooks/useHeaderFold';
import { HeaderOverflowMenu } from './HeaderOverflowMenu';
import { dataSourceKind } from '../../../services/api';

const DOCUMENT_SORT_OPTIONS: SortOption[] = [
  { value: 'none', label: 'Default order', icon: ArrowUpDown },
  { value: 'title-asc', label: 'Title A→Z', icon: ArrowDownAZ },
  { value: 'title-desc', label: 'Title Z→A', icon: ArrowDownZA },
  { value: 'fields-desc', label: 'Most fields', icon: ArrowDownWideNarrow },
  { value: 'fields-asc', label: 'Fewest fields', icon: ArrowDownNarrowWide },
  { value: 'updated-desc', label: 'Recently updated', icon: ClockArrowDown },
  { value: 'updated-asc', label: 'Oldest updated', icon: ClockArrowUp },
];

// 검색어 입력이 멈춘 뒤 이만큼 기다렸다가 요청 — 글자마다 서버에 묻지 않도록
const FILTER_DEBOUNCE_MS = 250;

// ── Props ─────────────────────────────────────────────────────────────────────

// 문서 목록의 페이지·검색·정렬 — 실제 처리는 데이터 소스(Mock/서버)가 하고 여기선 보여주기만 한다
export interface DocumentListControls {
  page: DocumentPageInfo | null;
  query: DocumentListQuery;
  onQueryChange: (patch: Partial<DocumentListQuery>) => void;
  // 사용자 쿼리(MongoDB filter) 적용/해제 — 실패하면 오류 메시지
  onApplyMongoFilter: (filter: JsonObject | undefined, text: string) => Promise<string | null>;
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

  // 찾기 패널 — 머리의 찾기 버튼 하나로 연다. 위: 글자 필터·정렬(FilterSortToolbar), 아래: 쿼리(QueryBar).
  // 거르기·정렬·페이지 자르기는 데이터 소스가 하고(현재 페이지만 받아오므로 브라우저에서 정렬하면 그 페이지
  // 안에서만 섞인다) 여기서는 입력값만 넘긴다. 열림 상태는 breadcrumb 칩·단축키(/, q)도 쓰므로 모듈 저장소에 둔다.
  const searchPanel = useSearchPanel();
  const { page: pageInfo, query, onQueryChange, onApplyMongoFilter } = documentList;
  const isQueryActive = !!query.mongoFilter;
  // Mock은 MongoDB 매칭을 흉내 내지 않는다 — 쿼리는 서버 연결에서만
  const canQuery = dataSourceKind === 'remote';
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

  const listRef = useRef<HTMLDivElement>(null);
  // 머리가 좁으면 제목 필드·참조를 ⋯ 메뉴로 접는다
  const headerRef = useRef<HTMLDivElement>(null);
  const foldableRef = useRef<HTMLDivElement>(null);
  const fixedRef = useRef<HTMLButtonElement>(null);
  const isHeaderFolded = useHeaderFold(headerRef, foldableRef, fixedRef);
  const startTitleKeyEdit = () => {
    setTitleKeyInput(currentTitleKey ?? 'name');
    setIsEditingTitleKey(true);
  };
  // 페이지 끝 화살표 행 + 끝에서 더 굴리면 넘기기(PageEdge). 불러오는 동안은 멈춘다(한 번에 여러 장 넘어가지 않게)
  const canPrevPage = query.page > 0;
  const canNextPage = query.page < pageCount - 1;
  const paging = useOverscrollPaging(listRef, {
    canPrev: canPrevPage,
    canNext: canNextPage,
    onPrev: () => onQueryChange({ page: query.page - 1 }),
    onNext: () => onQueryChange({ page: query.page + 1 }),
    disabled: isLoading,
  });
  // 새 페이지를 받아 온 뒤 맨 위부터(이전 페이지로 넘겼으면 맨 아래부터)
  useEffect(() => { paging.land(); }, [pageInfo?.page]); // eslint-disable-line react-hooks/exhaustive-deps
  // 화살표 행은 받아 온 페이지 기준 — 페이지 안에 함께 그려져 옛 페이지와 접히고 새 페이지와 펼쳐진다
  const shownPage = pageInfo?.page ?? 0;

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
      <div ref={headerRef} className={styles.header}>
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
            {/* 왼쪽: 아이콘·제목·개수 — 머리 너비의 절반은 늘 이쪽(useHeaderFold) */}
            <div className="flex min-w-[50%] flex-1 items-center gap-2">
              <FileText size={15} className={cn(styles.headerIcon, 'shrink-0')} />
              <HeaderTitle title={collectionLabel} total={totalAll} matched={isDocFilterActive || isQueryActive ? totalMatched : undefined} />
            </div>
            {/* 오른쪽: 제목 필드·참조(좁으면 ⋯ 메뉴로) + 찾기(늘 보임 — 걸린 조건의 점이 여기 붙는다) */}
            <div className="flex shrink-0 items-center gap-2">
              {isHeaderFolded ? (
                <HeaderOverflowMenu
                  items={[
                    { icon: <Tag size={12} />, label: 'Title field', detail: currentTitleKey ?? 'name', disabled: !activeCollectionName, onSelect: startTitleKeyEdit },
                    { icon: <Link size={12} />, label: 'References', detail: String(Object.keys(referenceFields).length), disabled: !activeCollectionName, onSelect: () => setIsManagingRefs(true) },
                  ]}
                />
              ) : (
                <div ref={foldableRef} className="flex items-center gap-2">
                  <button
                    type="button"
                    className={cn(
                      'flex min-w-0 items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200/70 text-slate-500 hover:text-slate-700 transition-colors shrink-0',
                      !activeCollectionName && 'opacity-40 pointer-events-none',
                    )}
                    data-tt={`Title field${currentTitleKey ? ` "${currentTitleKey}"` : ''} — which field labels each document in this list`}
                    onClick={startTitleKeyEdit}
                  >
                    <Tag size={12} className="shrink-0" />
                    {/* 긴 필드 이름은 영문 8글자쯤에서 … (전체는 툴팁) */}
                    <span className="max-w-[8ch] truncate text-[11px] font-mono">{currentTitleKey ?? 'name'}</span>
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
                </div>
              )}
              <button
                ref={fixedRef}
                type="button"
                className={cn(
                  'relative p-1.5 rounded-lg transition-colors shrink-0',
                  searchPanel.open || isDocFilterActive || isQueryActive ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600',
                )}
                // '/' 단축키(useMillerKeyboard)가 data-tt가 "Filter"로 시작하는 버튼을 찾아 누른다
                data-tt={canQuery ? 'Filter & query — / to filter, q to query' : 'Filter / sort documents in this collection'}
                onClick={() => (searchPanel.open ? closeSearchPanel() : openSearchPanel('filter'))}
              >
                {(isDocFilterActive || isQueryActive) && !searchPanel.open && <span className={FILTER_DOT_CLASS} />}
                <Search size={13} />
              </button>
            </div>
          </>
        )}
      </div>

      {/* 찾기 패널 — 위: 글자 필터·정렬, 아래: 쿼리(서버 연결에서만). 컬렉션이 바뀌면 쿼리 입력은 새로 그린다 */}
      {searchPanel.open && activeCollectionName && (
        <>
          <FilterSortToolbar
            filterText={filterInput}
            onFilterTextChange={setFilterInput}
            filterPlaceholder="Search title or preview…"
            sortValue={query.sort}
            onSortChange={(value) => onQueryChange({ sort: value as DocumentSort })}
            sortOptions={DOCUMENT_SORT_OPTIONS}
            onClose={closeSearchPanel}
            autoFocus={false}
            focusSignal={searchPanel.focus === 'filter' ? searchPanel.seq : undefined}
          />
          {canQuery && (
            <QueryBar
              key={`${activeDatabaseName}.${activeCollectionName}`}
              appliedText={query.mongoFilter ? query.mongoFilterText : undefined}
              isApplied={isQueryActive}
              onRun={onApplyMongoFilter}
              onClose={closeSearchPanel}
              focusSignal={searchPanel.focus === 'query' ? searchPanel.seq : undefined}
            />
          )}
        </>
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
          {/* 화살표 행도 페이지 안에 — 옛 페이지와 함께 접히고 새 페이지와 함께 펼쳐진다(먼저 튀어나오지 않게) */}
          {shownPage > 0 && <PageEdge direction="prev" progress={paging.prevProgress} onClick={paging.goPrev} busy={isLoading} />}
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
          {shownPage < pageCount - 1 && <PageEdge direction="next" progress={paging.nextProgress} onClick={paging.goNext} busy={isLoading} />}
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
            <span>{isQueryActive ? 'No documents match the query' : 'No documents match the filter'}</span>
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
