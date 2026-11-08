import { useMemo, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MIN_VISIBLE_COLUMNS, type UseExplorerStateResult } from '../../hooks/useExplorerState';
import type { CollectionSummary, JsonValue } from '../../types/explorer';
import { CollectionsColumn } from './columns/CollectionsColumn';
import { DocumentsColumn } from './columns/DocumentsColumn';
import { CollectionsDocumentsColumn } from './columns/CollectionsDocumentsColumn';
import { JsonLevelColumn } from './columns/JsonLevelColumn';
import { PlaceholderColumn } from './columns/PlaceholderColumn';
import type { ActivePath, Document, MutationRequest } from '../../types/explorer';
import { ANIMATION_DISABLE_THRESHOLD_MB } from '../../utils/motionPresets';
import { usePreferences } from '../../services/preferences';

// ── 상수 ──────────────────────────────────────────────────────────────────────

// 마지막 컬럼만 살짝 더 넓게, 나머지는 동일 비율 (컬럼 수가 가변이라 슬롯 개수에 맞춰 생성)
// 단, 컬럼이 2개일 땐(인라인 재귀 중첩 모드) 마지막 패널을 훨씬 더 넓게(3:7)
const getFlexRatios = (count: number): number[] =>
  count === 2
    ? [3, 7]
    : Array.from({ length: count }, (_, i) => (i === count - 1 ? 4 : 3));

// ── 애니메이션 variants ────────────────────────────────────────────────────────

const colVariants = {
  enter: (dir: number) => ({
    x: dir > 0 ? '60%' : '-60%',
    opacity: 0,
    scale: 0.96,
  }),
  center: { x: 0, opacity: 1, scale: 1 },
  exit: {
    opacity: 0,
    scale: 0.94,
  },
};

const spring = { type: 'spring' as const, stiffness: 260, damping: 28 };

const placeholderVariants = {
  enter: { opacity: 0, scale: 0.9 },
  center: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.85 },
};

// ── Props 타입 ────────────────────────────────────────────────────────────────

type MillerColumnsProps = Pick<
  UseExplorerStateResult,
  | 'visibleColumns'
  | 'maxVisibleColumns'
  | 'collections'
  | 'documents'
  | 'documentPage'
  | 'documentQuery'
  | 'setDocumentQuery'
  | 'openDocument'
  | 'isLoading'
  | 'changedPaths'
  | 'editingId'
  | 'activePaths'
  | 'selectCollection'
  | 'selectDocument'
  | 'pushJsonPath'
  | 'pushReference'
  | 'navigateToReference'
  | 'pushReferenceByField'
  | 'navigateToReferenceByField'
  | 'popToIndex'
  | 'mutate'
  | 'uniqueOids'
  | 'registerUniqueOid'
  | 'unregisterUniqueOid'
  | 'setEditingId'
  | 'clearChangedPaths'
>;

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export function MillerColumns({
  visibleColumns,
  maxVisibleColumns,
  collections,
  documents,
  documentPage,
  documentQuery,
  setDocumentQuery,
  openDocument,
  isLoading,
  changedPaths,
  editingId,
  activePaths,
  selectCollection,
  selectDocument,
  pushJsonPath,
  pushReference,
  navigateToReference,
  pushReferenceByField,
  navigateToReferenceByField,
  popToIndex,
  mutate,
  uniqueOids,
  registerUniqueOid,
  unregisterUniqueOid,
  setEditingId,
  clearChangedPaths,
}: MillerColumnsProps) {
  // 마지막 push 방향 (visibleColumns의 마지막 non-null 컬럼 방향)
  const direction = useMemo(() => {
    for (let i = visibleColumns.length - 1; i >= 0; i--) {
      const col = visibleColumns[i];
      if (col) return col.comp.direction;
    }
    return 1;
  }, [visibleColumns]);

  // activePaths 전체에서 현재 선택된 collection/document 식별
  const activeCollectionName = useMemo(() => {
    const docPath = activePaths.find((p) => p.columnKind === 'documents' && p.kind === 'normal');
    return docPath?.kind === 'normal' ? docPath.collectionName ?? null : null;
  }, [activePaths]);

  const activeDocumentOid = useMemo(() => {
    const jsonPath = activePaths.find((p) => p.columnKind === 'json' && p.kind === 'normal' && !p.projectionPath?.length);
    return jsonPath?.kind === 'normal' ? jsonPath.documentOid ?? null : null;
  }, [activePaths]);

  const activeDatabaseName = useMemo(() => {
    const cp = activePaths.find((p) => p.columnKind === 'collections');
    return cp?.kind === 'normal' ? (cp.databaseName ?? null) : null;
  }, [activePaths]);

  // 조회 중인 컬렉션이 무거우면 layout 애니메이션을 끈다 (FLIP 재계산 비용 절감) — 설정 › Display › Animations가 auto일 때.
  // off면 늘 끄고, on이면 커도 켠다
  const { animations } = usePreferences();
  const reduceMotion = useMemo(() => {
    if (animations !== 'auto') return animations === 'off';
    const sizeMb = collections.find((c) => c.name === activeCollectionName)?.sizeMb ?? 0;
    return sizeMb > ANIMATION_DISABLE_THRESHOLD_MB;
  }, [collections, activeCollectionName, animations]);

  // activePaths는 항상 [collections?, documents?, json, json, json...] 순서의 스택이다 —
  // 끝에서부터 연속으로 columnKind==='json'인 구간이 "현재 문서 안에서 얼마나 깊이
  // 들어갔는지"를 나타내는 체인이다.
  const jsonChainStartIndex = useMemo(() => {
    let i = activePaths.length;
    while (i > 0 && activePaths[i - 1].columnKind === 'json') i--;
    return i;
  }, [activePaths]);

  const jsonChainPaths = useMemo(() => activePaths.slice(jsonChainStartIndex), [activePaths, jsonChainStartIndex]);
  const prefixPaths = useMemo(() => activePaths.slice(0, jsonChainStartIndex), [activePaths, jsonChainStartIndex]);

  // 컬럼 수가 최소(MIN_VISIBLE_COLUMNS)일 때 — Collections/Documents를 한 패널에서
  // navigate하고, json 체인은(있으면) 가로 슬라이딩 대신 재귀적으로 한 패널 안에
  // 중첩해서 보여준다
  const twoColMode = maxVisibleColumns === MIN_VISIBLE_COLUMNS;
  const inlineMode = twoColMode && jsonChainPaths.length > 0;

  const renderSlots = useMemo<RenderSlot[]>(() => {
    if (!twoColMode) {
      return visibleColumns.map((col, i) => ({
        key: col ? `col-${col.comp.id}` : `ph-${i}`,
        col,
        slotIndex: i,
      }));
    }

    const slots: RenderSlot[] = [];
    const collectionsPath = prefixPaths.find((p) => p.columnKind === 'collections') ?? null;
    const documentsPath = prefixPaths.find((p) => p.columnKind === 'documents') ?? null;
    if (collectionsPath) {
      slots.push({
        key: 'colsdocs', // collections↔documents 토글은 패널 내부에서 처리 — 키를 고정해 슬라이드 애니메이션이 안 일어나게 함
        col: collectionsPath,
        slotIndex: 0,
        isCollectionsDocuments: true,
        collectionsPath,
        documentsPath,
      });
    }

    if (jsonChainPaths.length > 0) {
      const [head, ...tail] = jsonChainPaths;
      slots.push({
        key: `col-${head.comp.id}`,
        col: head,
        slotIndex: jsonChainStartIndex, // activePaths 안의 실제 인덱스 — myIndex 공식에 그대로 들어감
        jsonChainTail: tail,
      });
    } else {
      slots.push({ key: 'ph-doc', col: null, slotIndex: 1, placeholderHint: 2 });
    }
    return slots;
  }, [twoColMode, visibleColumns, prefixPaths, jsonChainPaths, jsonChainStartIndex]);

  const flexRatios = useMemo(() => getFlexRatios(renderSlots.length), [renderSlots.length]);
  // 인라인 모드에선 visibleLength를 activePaths.length로 줘야 JsonLevelColumn의
  // myIndex = (activePaths.length - visibleLength) + slotIndex 공식이 slotIndex를
  // 실제 배열 인덱스 그대로 돌려준다 (윈도잉이 없으므로)
  const jsonVisibleLength = inlineMode ? activePaths.length : visibleColumns.length;

  return (
    <div className="relative flex h-full w-full gap-3 overflow-hidden rounded-2xl p-3">
      <AnimatePresence initial={false} mode="popLayout" custom={direction}>
        {renderSlots.map((slot, visualIndex) => {
          const flex = flexRatios[visualIndex];
          const isPlaceholder = slot.col === null;

          return (
            <motion.div
              key={slot.key}
              custom={direction}
              variants={isPlaceholder ? placeholderVariants : colVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={reduceMotion ? { duration: 0 } : spring}
              layout={!reduceMotion}
              style={{ flex, zIndex: 99 - visualIndex }} // 뒤에 나올수록 zIndex 낮게
              className={[
                'min-w-0 h-full flex flex-col rounded-2xl overflow-hidden',
                isPlaceholder
                  ? 'border border-dashed border-slate-200 opacity-40'
                  : 'bg-white border border-slate-200/80 shadow-panel',
              ].join(' ')}
            >
              {isPlaceholder ? (
                <PlaceholderColumn slotIndex={slot.placeholderHint ?? visualIndex} />
              ) : slot.isCollectionsDocuments ? (
                <CollectionsDocumentsColumn
                  collectionsPath={slot.collectionsPath!}
                  documentsPath={slot.documentsPath ?? null}
                  collections={collections}
                  documents={documents}
                  documentList={{ page: documentPage, query: documentQuery, onQueryChange: (patch) => void setDocumentQuery(patch) }}
                  activeCollectionName={activeCollectionName}
                  activeDocumentOid={activeDocumentOid}
                  activeDatabaseName={activeDatabaseName}
                  isLoading={isLoading}
                  changedPaths={changedPaths}
                  editingId={editingId}
                  reduceMotion={reduceMotion}
                  onSelectCollection={selectCollection}
                  onSelectDocument={selectDocument}
                  onMutate={mutate}
                  onSetEditingId={setEditingId}
                  onBackToCollections={() => popToIndex(0)}
                />
              ) : (
                <ColumnContent
                  col={slot.col!}
                  visibleLength={slot.col!.columnKind === 'json' ? jsonVisibleLength : visibleColumns.length}
                  slotIndex={slot.slotIndex}
                  jsonChainTail={slot.jsonChainTail}
                  reduceMotion={reduceMotion}
                  collections={collections}
                  documents={documents}
                  documentPage={documentPage}
                  documentQuery={documentQuery}
                  setDocumentQuery={setDocumentQuery}
                  openDocument={openDocument}
                  isLoading={isLoading}
                  changedPaths={changedPaths}
                  editingId={editingId}
                  activePaths={activePaths}
                  activeCollectionName={activeCollectionName}
                  activeDocumentOid={activeDocumentOid}
                  activeDatabaseName={activeDatabaseName}
                  selectCollection={selectCollection}
                  selectDocument={selectDocument}
                  pushJsonPath={pushJsonPath}
                  pushReference={pushReference}
                  navigateToReference={navigateToReference}
                  pushReferenceByField={pushReferenceByField}
                  navigateToReferenceByField={navigateToReferenceByField}
                  popToIndex={popToIndex}
                  mutate={mutate}
                  uniqueOids={uniqueOids}
                  registerUniqueOid={registerUniqueOid}
                  unregisterUniqueOid={unregisterUniqueOid}
                  setEditingId={setEditingId}
                  clearChangedPaths={clearChangedPaths}
                />
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ── 슬롯 타입 ─────────────────────────────────────────────────────────────────

interface RenderSlot {
  key: string;
  col: ActivePath | null;
  slotIndex: number;
  // 있으면 이 슬롯(json 컬럼)이 재귀 중첩 체인의 head — 나머지를 nestedChild로 이어붙인다
  jsonChainTail?: ActivePath[];
  // true면 Collections/Documents를 한 패널에서 navigate(컬럼 2개 모드)
  isCollectionsDocuments?: boolean;
  collectionsPath?: ActivePath;
  documentsPath?: ActivePath | null;
  // placeholder일 때 보여줄 힌트 — 없으면 시각적 위치(visualIndex)를 그대로 사용
  placeholderHint?: number;
}

// ── 컬럼 내용 분기 ────────────────────────────────────────────────────────────

interface ColumnContentProps extends Omit<MillerColumnsProps, 'visibleColumns' | 'maxVisibleColumns'> {
  col: ActivePath;
  visibleLength: number;
  slotIndex: number;
  jsonChainTail?: ActivePath[];
  activeCollectionName: string | null;
  activeDocumentOid: string | null;
  activeDatabaseName: string | null;
  reduceMotion: boolean;
}

function ColumnContent({ col, visibleLength, slotIndex, jsonChainTail, ...rest }: ColumnContentProps) {
  if (col.columnKind === 'collections') {
    return (
      <CollectionsColumn
        path={col}
        collections={rest.collections}
        activeCollectionName={rest.activeCollectionName}
        isLoading={rest.isLoading}
        changedPaths={rest.changedPaths}
        editingId={rest.editingId}
        reduceMotion={rest.reduceMotion}
        onSelectCollection={rest.selectCollection}
        onMutate={rest.mutate}
        onSetEditingId={rest.setEditingId}
      />
    );
  }

  if (col.columnKind === 'documents') {
    return (
      <DocumentsColumn
        path={col}
        documents={rest.documents}
        documentList={{ page: rest.documentPage, query: rest.documentQuery, onQueryChange: (patch) => void rest.setDocumentQuery(patch) }}
        collections={rest.collections}
        activeDocumentOid={rest.activeDocumentOid}
        isLoading={rest.isLoading}
        changedPaths={rest.changedPaths}
        editingId={rest.editingId}
        activeCollectionName={rest.activeCollectionName}
        activeDatabaseName={rest.activeDatabaseName}
        reduceMotion={rest.reduceMotion}
        onSelectDocument={rest.selectDocument}
        onMutate={rest.mutate}
        onSetEditingId={rest.setEditingId}
      />
    );
  }

  const isChainHead = jsonChainTail !== undefined;
  const chainShared: JsonChainSharedProps = {
    openDocument: rest.openDocument,
    isLoading: rest.isLoading,
    changedPaths: rest.changedPaths,
    editingId: rest.editingId,
    activePaths: rest.activePaths,
    activeCollectionName: rest.activeCollectionName,
    activeDatabaseName: rest.activeDatabaseName,
    collections: rest.collections,
    reduceMotion: rest.reduceMotion,
    onPushJsonPath: rest.pushJsonPath,
    onPushReference: rest.pushReference,
    onNavigateToReference: rest.navigateToReference,
    onPushReferenceByField: rest.pushReferenceByField,
    onNavigateToReferenceByField: rest.navigateToReferenceByField,
    onPopToIndex: rest.popToIndex,
    onMutate: rest.mutate,
    uniqueOids: rest.uniqueOids,
    onRegisterUniqueOid: rest.registerUniqueOid,
    onUnregisterUniqueOid: rest.unregisterUniqueOid,
    onSetEditingId: rest.setEditingId,
  };

  return (
    <JsonLevelColumn
      path={col}
      openDocument={rest.openDocument}
      visibleLength={visibleLength}
      slotIndex={slotIndex}
      isLoading={rest.isLoading}
      changedPaths={rest.changedPaths}
      editingId={rest.editingId}
      activePaths={rest.activePaths}
      activeCollectionName={rest.activeCollectionName}
      activeDatabaseName={rest.activeDatabaseName}
      collections={rest.collections}
      reduceMotion={rest.reduceMotion}
      onPushJsonPath={rest.pushJsonPath}
      onPushReference={rest.pushReference}
      onNavigateToReference={rest.navigateToReference}
      onPushReferenceByField={rest.pushReferenceByField}
      onNavigateToReferenceByField={rest.navigateToReferenceByField}
      onPopToIndex={rest.popToIndex}
      onMutate={rest.mutate}
      uniqueOids={rest.uniqueOids}
      onRegisterUniqueOid={rest.registerUniqueOid}
      onUnregisterUniqueOid={rest.unregisterUniqueOid}
      onSetEditingId={rest.setEditingId}
      isInlineChain={isChainHead}
      nestedChild={isChainHead ? buildJsonChain(jsonChainTail!, slotIndex + 1, visibleLength, chainShared, true) : null}
    />
  );
}

// ── 재귀 중첩 체인 빌더 ────────────────────────────────────────────────────────
// 인라인 모드에서 json 체인의 head 다음 단계들을 뒤따라가며, 각 단계가 자기
// 다음 단계를 nestedChild로 품은 JsonLevelColumn을 만든다. ColumnContent의 json
// 분기와 똑같은 props를 그대로 재사용 — 탐색/pop 로직은 전혀 건드리지 않는다.

interface JsonChainSharedProps {
  openDocument: Document | null;
  isLoading: boolean;
  changedPaths: string[];
  editingId: string | null;
  activePaths: ActivePath[];
  activeCollectionName: string | null;
  activeDatabaseName: string | null;
  collections: CollectionSummary[];
  reduceMotion: boolean;
  onPushJsonPath: (path: ActivePath) => void;
  onPushReference: (oid: string, fieldKey: string, popIndex?: number) => Promise<void>;
  onNavigateToReference: (oid: string) => Promise<void>;
  onPushReferenceByField: (database: string, collection: string, key: string, value: JsonValue, fieldKey: string, popIndex?: number) => Promise<void>;
  onNavigateToReferenceByField: (database: string, collection: string, key: string, value: JsonValue) => Promise<void>;
  onPopToIndex: (index: number) => void;
  onMutate: (op: MutationRequest) => Promise<unknown>;
  uniqueOids: Set<string>;
  onRegisterUniqueOid: (oid: string) => void;
  onUnregisterUniqueOid: (oid: string) => void;
  onSetEditingId: (id: string | null) => void;
}

function buildJsonChain(
  paths: ActivePath[],
  startTrueIndex: number,
  visibleLength: number,
  shared: JsonChainSharedProps,
  isNested: boolean,
): ReactNode | null {
  if (!paths.length) return null;
  const [head, ...tail] = paths;
  return (
    <JsonLevelColumn
      path={head}
      visibleLength={visibleLength}
      slotIndex={startTrueIndex}
      isNested={isNested}
      isInlineChain
      nestedChild={buildJsonChain(tail, startTrueIndex + 1, visibleLength, shared, true)}
      openDocument={shared.openDocument}
      isLoading={shared.isLoading}
      changedPaths={shared.changedPaths}
      editingId={shared.editingId}
      activePaths={shared.activePaths}
      activeCollectionName={shared.activeCollectionName}
      activeDatabaseName={shared.activeDatabaseName}
      collections={shared.collections}
      reduceMotion={shared.reduceMotion}
      onPushJsonPath={shared.onPushJsonPath}
      onPushReference={shared.onPushReference}
      onNavigateToReference={shared.onNavigateToReference}
      onPushReferenceByField={shared.onPushReferenceByField}
      onNavigateToReferenceByField={shared.onNavigateToReferenceByField}
      onPopToIndex={shared.onPopToIndex}
      onMutate={shared.onMutate}
      uniqueOids={shared.uniqueOids}
      onRegisterUniqueOid={shared.onRegisterUniqueOid}
      onUnregisterUniqueOid={shared.onUnregisterUniqueOid}
      onSetEditingId={shared.onSetEditingId}
    />
  );
}
