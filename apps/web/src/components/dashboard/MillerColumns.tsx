import { useMemo, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MIN_VISIBLE_COLUMNS, type UseExplorerStateResult } from '../../hooks/useExplorerState';
import type { CollectionSummary, JsonValue } from '../../types/explorer';
import { CollectionsColumn } from './columns/CollectionsColumn';
import { DocumentsColumn } from './columns/DocumentsColumn';
import { CollectionsDocumentsColumn } from './columns/CollectionsDocumentsColumn';
import { JsonLevelColumn } from './columns/JsonLevelColumn';
import { PlaceholderColumn } from './columns/PlaceholderColumn';
import { PipelineColumn } from '../aggregation/PipelineColumn';
import { StageOutputColumn } from '../aggregation/StageOutputColumn';
import { forgetRuns } from '../../services/aggregateRuns';
import { INPUT_STAGE_ID } from '../../services/pipelines';
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
  | 'treeMode'
  | 'collections'
  | 'documents'
  | 'documentPage'
  | 'documentQuery'
  | 'setDocumentQuery'
  | 'applyMongoFilter'
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
  | 'openPipeline'
  | 'selectStage'
  | 'selectAggregateResult'
>;

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export function MillerColumns({
  visibleColumns,
  maxVisibleColumns,
  treeMode,
  collections,
  documents,
  documentPage,
  documentQuery,
  setDocumentQuery,
  applyMongoFilter,
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
  openPipeline,
  selectStage,
  selectAggregateResult,
}: MillerColumnsProps) {
  // activePaths 전체에서 현재 선택된 collection/document 식별
  // aggregation 모드(두 번째 컬럼이 pipeline)면 그 파이프라인의 컬렉션 — 컬렉션 목록의 강조
  const isAggregation = activePaths[1]?.columnKind === 'pipeline';
  const activeCollectionName = useMemo(() => {
    const docPath = activePaths.find((p) => (p.columnKind === 'documents' || p.columnKind === 'pipeline') && p.kind === 'normal');
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
  // aggregation 모드는 따로(aggregationSlots) — Pipeline을 왼쪽에 고정하고, Tree면 결과 상세만 한 칸에 접는다
  const twoColMode = maxVisibleColumns === MIN_VISIBLE_COLUMNS && !isAggregation;
  const inlineMode = twoColMode && jsonChainPaths.length > 0;

  const renderSlots = useMemo<RenderSlot[]>(() => {
    if (isAggregation) return aggregationSlots(activePaths, jsonChainStartIndex, maxVisibleColumns, treeMode);
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
  }, [isAggregation, activePaths, maxVisibleColumns, treeMode, twoColMode, visibleColumns, prefixPaths, jsonChainPaths, jsonChainStartIndex]);

  // 마지막 push 방향 (보이는 마지막 컬럼의 방향)
  const direction = useMemo(() => {
    for (let i = renderSlots.length - 1; i >= 0; i--) {
      const col = renderSlots[i].col;
      if (col) return col.comp.direction;
    }
    return 1;
  }, [renderSlots]);

  const flexRatios = useMemo(() => getFlexRatios(renderSlots.length), [renderSlots.length]);
  // 인라인 모드에선 visibleLength를 activePaths.length로 줘야 JsonLevelColumn의
  // myIndex = (activePaths.length - visibleLength) + slotIndex 공식이 slotIndex를
  // 실제 배열 인덱스 그대로 돌려준다 (윈도잉이 없으므로). aggregation도 같다 —
  // Pipeline을 고정하면 보이는 칸이 이어져 있지 않아서 slotIndex에 실제 번호를 넣는다
  const jsonVisibleLength = inlineMode || isAggregation ? activePaths.length : visibleColumns.length;

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
                <PlaceholderColumn slotIndex={slot.placeholderHint ?? visualIndex} aggregation={isAggregation} />
              ) : slot.isCollectionsDocuments ? (
                <CollectionsDocumentsColumn
                  collectionsPath={slot.collectionsPath!}
                  documentsPath={slot.documentsPath ?? null}
                  collections={collections}
                  documents={documents}
                  documentList={{ page: documentPage, query: documentQuery, onQueryChange: (patch) => void setDocumentQuery(patch), onApplyMongoFilter: applyMongoFilter }}
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
                  leftEdge={slot.leftEdge}
                  reduceMotion={reduceMotion}
                  collections={collections}
                  documents={documents}
                  documentPage={documentPage}
                  documentQuery={documentQuery}
                  setDocumentQuery={setDocumentQuery}
                  applyMongoFilter={applyMongoFilter}
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
                  isAggregation={isAggregation}
                  openPipeline={openPipeline}
                  selectStage={selectStage}
                  selectAggregateResult={selectAggregateResult}
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
  // 맨 왼쪽 컬럼 노릇(누르면 경로 하나 빼기) — aggregation에서 고정된 Pipeline 바로 오른쪽 칸
  leftEdge?: boolean;
}

// aggregation 모드의 칸 — 경로는 [Collections, Pipeline, Output, 결과 상세(json)…].
// 다 들어가면 그대로 왼쪽부터, 넘치면 Pipeline을 맨 왼쪽에 고정하고 그 뒤의 마지막 (n−1)개만
// (Collections가 먼저 밀려나고, 더 깊어지면 Output도). Tree(최소 3칸)면 결과 상세를 한 칸에 중첩한다.
// slotIndex는 늘 경로의 실제 번호다(jsonVisibleLength = activePaths.length와 짝).
// 고정됐을 때 Pipeline 바로 오른쪽 칸이 '맨 왼쪽 컬럼'(누르면 경로 하나 빼기) — Tree는 빼고
function aggregationSlots(activePaths: ActivePath[], chainStart: number, n: number, tree: boolean): RenderSlot[] {
  const units: RenderSlot[] = [];
  activePaths.forEach((p, i) => {
    if (!tree || i < chainStart) units.push({ key: `col-${p.comp.id}`, col: p, slotIndex: i });
  });
  if (tree && chainStart < activePaths.length) {
    const [head, ...tail] = activePaths.slice(chainStart);
    units.push({ key: `col-${head.comp.id}`, col: head, slotIndex: chainStart, jsonChainTail: tail });
  }
  const pin = units.findIndex((u) => u.col?.columnKind === 'pipeline');
  const shown = units.length <= n ? [...units] : pin < 0 ? units.slice(-n) : [units[pin], ...units.slice(pin + 1).slice(-(n - 1))];
  if (!tree && shown[0]?.col?.columnKind === 'pipeline' && shown[1]?.col) shown[1] = { ...shown[1], leftEdge: true };
  // 남는 칸 — 다음에 열릴 것의 안내(2 = 스테이지의 출력, 3~ = 결과의 필드). 남는 칸이 있으면 다 들어간 것이라 경로 번호를 이어 센다
  const filled = shown.length;
  for (let i = filled; i < n; i++) {
    shown.push({ key: `ph-${i}`, col: null, slotIndex: i, placeholderHint: activePaths.length + (i - filled) });
  }
  return shown;
}

// aggregation 모드의 필드 컬럼(3번 경로부터)은 다 읽기만 — 결과(3번)부터 이 컬럼까지 참조를 한 번도 안 따라갔으면
// 파이프라인이 만든 값('result') 또는 원본 문서('source'), 따라갔으면 진짜 문서('document' — 고치는 건 문서 모드에서)
const aggregationReadOnly = (activePaths: ActivePath[], index: number): false | 'result' | 'source' | 'document' => {
  if (activePaths[1]?.columnKind !== 'pipeline' || index < 3) return false;
  if (!activePaths.slice(3, index + 1).every((p) => p.kind === 'normal')) return 'document';
  const output = activePaths[2];
  return output?.kind === 'normal' && output.stageId === INPUT_STAGE_ID ? 'source' : 'result';
};

// ── 컬럼 내용 분기 ────────────────────────────────────────────────────────────

interface ColumnContentProps extends Omit<MillerColumnsProps, 'visibleColumns' | 'maxVisibleColumns' | 'treeMode'> {
  col: ActivePath;
  visibleLength: number;
  slotIndex: number;
  jsonChainTail?: ActivePath[];
  // aggregation에서 맨 왼쪽 컬럼 노릇을 하는 칸(고정된 Pipeline 바로 오른쪽)
  leftEdge?: boolean;
  activeCollectionName: string | null;
  activeDocumentOid: string | null;
  activeDatabaseName: string | null;
  reduceMotion: boolean;
  isAggregation: boolean;
}

function ColumnContent({ col, visibleLength, slotIndex, jsonChainTail, leftEdge, ...rest }: ColumnContentProps) {
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
        // aggregation 모드면 고른 컬렉션의 파이프라인을 연다
        onSelectCollection={rest.isAggregation && rest.activeDatabaseName
          ? (name, label) => rest.openPipeline(rest.activeDatabaseName!, name, label)
          : rest.selectCollection}
        onMutate={rest.mutate}
        onSetEditingId={rest.setEditingId}
      />
    );
  }

  // ── aggregation: [collections, pipeline, output, json(결과)…] — 경로 번호가 곧 키보드 컬럼 번호 ──
  if (col.columnKind === 'pipeline' && col.kind === 'normal') {
    const output = rest.activePaths[2];
    return (
      <PipelineColumn
        path={col}
        navIndex={1}
        selectedStageId={output?.kind === 'normal' && output.columnKind === 'output' ? output.stageId ?? null : null}
        resultOpen={rest.activePaths.length > 3}
        reduceMotion={rest.reduceMotion}
        onSelectStage={rest.selectStage}
        // 고른 스테이지가 없어지면(마지막 하나를 지움 등) 원본 문서로
        onClearStage={() => rest.selectStage(INPUT_STAGE_ID)}
        collectionNames={rest.collections.map((c) => c.name)}
      />
    );
  }

  if (col.columnKind === 'output' && col.kind === 'normal') {
    const result = rest.activePaths[3];
    return (
      <StageOutputColumn
        path={col}
        navIndex={2}
        activeResultIndex={result?.kind === 'normal' ? result.resultIndex ?? null : null}
        collections={rest.collections}
        reduceMotion={rest.reduceMotion}
        onSelectResult={rest.selectAggregateResult}
        // 맨 왼쪽 노릇이면 펼쳐 둔 결과를 다시 누를 때 경로 하나 빼기
        leftEdge={!!leftEdge}
        onStepBack={() => rest.popToIndex(rest.activePaths.length - 2)}
        hasDeeper={rest.activePaths.length > 4}
        onRerun={() => {
          forgetRuns(col.databaseName ?? '', col.collectionName ?? '');
          if (col.stageId) rest.selectStage(col.stageId);
        }}
      />
    );
  }

  if (col.columnKind === 'documents') {
    return (
      <DocumentsColumn
        path={col}
        documents={rest.documents}
        documentList={{ page: rest.documentPage, query: rest.documentQuery, onQueryChange: (patch) => void rest.setDocumentQuery(patch), onApplyMongoFilter: rest.applyMongoFilter }}
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
      // aggregation은 slotIndex가 경로 번호라 '0번 칸'으로 못 알아본다 — 직접 알려 준다
      leftEdge={rest.isAggregation ? !!leftEdge : undefined}
      nestedChild={isChainHead ? buildJsonChain(jsonChainTail!, slotIndex + 1, visibleLength, chainShared, true) : null}
      // aggregation 모드는 다 읽기만 — slotIndex가 실제 경로 번호다
      readOnly={rest.isAggregation && aggregationReadOnly(rest.activePaths, slotIndex)}
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
      readOnly={aggregationReadOnly(shared.activePaths, startTrueIndex)}
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
