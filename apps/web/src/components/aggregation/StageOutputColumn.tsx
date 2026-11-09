// aggregation 모드의 세 번째 컬럼(Stage Output) — 고른 스테이지까지 돌린 결과. 행·페이지는 문서 목록과 같다.
// 결과를 누르면 오른쪽에 그 문서의 필드 컬럼(기존 JsonLevelColumn, 읽기만). 결과는 AGGREGATE_RESULT_LIMIT개까지(넘으면 작게 알림).
// 출력은 처음 볼 때 한 번 받아 두고(services/aggregateRuns), 그 컬렉션이 바뀌면 '낡았을 수 있음'만 띄운다 — 다시 돌리는 건 사용자가.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Eye, FileText, Layers, RefreshCw } from 'lucide-react';
import {
  AGGREGATE_RESULT_LIMIT,
  PAGE_SIZE,
  summarizeDocument,
  type CollectionSummary,
  type Document,
  type NormalActivePath,
} from '../../types/explorer';
import { INPUT_STAGE_ID, prefixPipeline, stageLabel, usePipelineStages } from '../../services/pipelines';
import { loadOutput, usePreview, useOutput, useStale } from '../../services/aggregateRuns';
import { ColumnItem, ColumnSkeletonList } from '../dashboard/columns/ColumnItem';
import { HeaderTitle } from '../dashboard/columns/HeaderTitle';
import { PageRail, PageTransition } from '../dashboard/columns/PageRail';
import { PageEdge, useOverscrollPaging } from '../dashboard/columns/PageEdge';
import { columnListStyles as styles } from '../dashboard/columns/columnListStyles';

interface StageOutputColumnProps {
  path: NormalActivePath;
  navIndex: number;
  // 오른쪽에 펼쳐 둔 결과(목록에서 몇 번째)
  activeResultIndex: number | null;
  collections: CollectionSummary[];
  reduceMotion: boolean;
  onSelectResult: (document: Document, title: string, index: number) => void;
  // 맨 왼쪽 컬럼 노릇(고정된 Pipeline 바로 오른쪽) — 펼쳐 둔 결과를 다시 누르면 경로 하나 빼기(onStepBack)
  leftEdge: boolean;
  onStepBack: () => void;
  // 펼쳐 둔 결과 오른쪽에 더 깊이 열려 있다(그 결과를 다시 누르면 접는다 — 없으면 아무것도 안 한다)
  hasDeeper: boolean;
  // '낡았을 수 있음'의 Run again — Pipeline 컬럼의 Run과 같다
  onRerun: () => void;
}

export function StageOutputColumn({ path, navIndex, activeResultIndex, collections, reduceMotion, onSelectResult, leftEdge, onStepBack, hasDeeper, onRerun }: StageOutputColumnProps) {
  const database = path.databaseName ?? '';
  const collection = path.collectionName ?? '';
  const stageId = path.stageId ?? '';
  // 원본 문서(Pipeline 컬럼 맨 위 버튼) — 빈 파이프라인 = 컬렉션 그대로
  const isInput = stageId === INPUT_STAGE_ID;
  const stages = usePipelineStages(database, collection);
  const index = stages.findIndex((s) => s.id === stageId);
  const stage = index >= 0 ? stages[index] : null;

  // 편집기의 Preview가 이 출력에 걸려 있으면 그 파이프라인('*' = 통 JSON 미리보기는 어느 스테이지에서든)
  const preview = usePreview(database, collection);
  const previewing = !!preview && (preview.stageId === '*' || preview.stageId === stageId);
  const pipeline = useMemo(
    () => (previewing ? preview!.pipeline : isInput ? [] : index >= 0 ? prefixPipeline(stages, index) : null),
    [previewing, preview, stages, index, isInput],
  );
  const state = useOutput(database, collection, pipeline);
  const pipelineId = JSON.stringify(pipeline);
  useEffect(() => {
    if (pipeline && !state) loadOutput(database, collection, pipeline);
  }, [database, collection, pipelineId, state]); // eslint-disable-line react-hooks/exhaustive-deps
  const stale = useStale(database, collection);

  const results = state?.status === 'done' ? (state.data.results as Document[]) : [];
  const summary = collections.find((c) => c.name === collection);
  const rows = useMemo(
    () => results.map((doc, i) => ({ doc, ...summarizeDocument(doc, 0, summary?.titleKey, summary?.primaryKey, i) })),
    [results, summary?.titleKey, summary?.primaryKey],
  );

  // 화면에서만 나누는 페이지(문서 목록과 같은 PAGE_SIZE) — 펼쳐 둔 결과가 있는 페이지를 기억해 둔다
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const markedPage = activeResultIndex !== null ? Math.floor(activeResultIndex / PAGE_SIZE) : undefined;
  const [page, setPage] = useState(markedPage ?? 0);
  useEffect(() => {
    setPage(markedPage ?? 0);
  }, [pipelineId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownPage = Math.min(page, pageCount - 1);
  const listRef = useRef<HTMLDivElement>(null);
  const paging = useOverscrollPaging(listRef, {
    canPrev: shownPage > 0,
    canNext: shownPage < pageCount - 1,
    onPrev: () => setPage(shownPage - 1),
    onNext: () => setPage(shownPage + 1),
  });
  useEffect(() => { paging.land(); }, [shownPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = stageId === '*' ? 'Preview' : isInput || stage ? stageLabel(stages, stageId) : 'Stage';
  const truncated = state?.status === 'done' && state.data.truncated;

  return (
    <div data-nav-col={navIndex} className={styles.container}>
      <div className={styles.header}>
        <Layers size={15} className={`${styles.headerIcon} shrink-0`} />
        <HeaderTitle title={isInput ? label : `${label} output`} total={rows.length} titleClassName={isInput ? undefined : 'font-mono'} />
        {truncated && (
          <span
            className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-600"
            data-tt={`Only the first ${AGGREGATE_RESULT_LIMIT} results are shown — add $limit or $match to narrow it`}
          >
            first {AGGREGATE_RESULT_LIMIT}
          </span>
        )}
        {state?.status === 'done' && <span className="shrink-0 font-mono text-[11px] text-slate-400">{state.data.elapsedMs} ms</span>}
      </div>

      {/* 알림 줄 — 미리보기 / 꺼진 스테이지 / 낡았을 수 있음 */}
      {previewing && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-sky-100 bg-sky-50 px-4 py-1.5 text-xs text-sky-700">
          <Eye size={12} className="shrink-0" />
          <span className="truncate">Preview of your edit — Apply to keep it</span>
        </div>
      )}
      {!previewing && stage?.pending && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-emerald-100 bg-emerald-50 px-4 py-1.5 text-xs text-emerald-700">
          <span className="truncate">Not run yet — showing the output before it · Run adds it</span>
        </div>
      )}
      {!previewing && stage && !stage.pending && !stage.enabled && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-1.5 text-xs text-slate-500">
          <span className="truncate">This stage is off — showing the output without it</span>
        </div>
      )}
      {stale && state?.status === 'done' && (
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 border-b border-amber-100 bg-amber-50 px-4 py-1.5 text-left text-xs text-amber-700 transition-colors hover:bg-amber-100/70"
          onClick={onRerun}
        >
          <AlertTriangle size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{summary?.label || collection} changed — results may be stale</span>
          <span className="flex shrink-0 items-center gap-1 font-medium">
            <RefreshCw size={11} />
            Run again
          </span>
        </button>
      )}

      <div className="flex min-h-0 flex-1">
        <div ref={listRef} className={styles.list}>
          {!pipeline ? (
            <div className={styles.empty}>
              <Layers size={28} className="opacity-30" />
              <span>{stage ? 'This stage can’t be read — fix it in the editor' : 'This stage is gone'}</span>
            </div>
          ) : !state || state.status === 'loading' ? (
            <ColumnSkeletonList count={5} />
          ) : state.status === 'error' ? (
            <div className="m-2 rounded-xl bg-rose-50 px-3 py-2.5 text-xs leading-relaxed text-rose-700" role="alert">
              <p className="mb-0.5 font-semibold">This stage failed</p>
              <p className="break-words font-mono">{state.message}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className={styles.empty}>
              <FileText size={28} className="opacity-30" />
              <span>No documents come out here</span>
            </div>
          ) : (
            <PageTransition pageKey={shownPage} disabled={reduceMotion} className="flex flex-col gap-0.5">
              {shownPage > 0 && <PageEdge direction="prev" progress={paging.prevProgress} onClick={paging.goPrev} />}
              {rows.slice(shownPage * PAGE_SIZE, (shownPage + 1) * PAGE_SIZE).map((row, i) => {
                const at = shownPage * PAGE_SIZE + i;
                return (
                  <ColumnItem
                    key={at}
                    label={row.title}
                    meta={row.preview}
                    isActive={activeResultIndex === at}
                    variant="document"
                    reduceMotion={reduceMotion}
                    onSelect={() => {
                      // 펼쳐 둔 결과를 다시 — 맨 왼쪽 노릇이면 하나 빼기, 그 결과가 경로의 끝이면 아무것도 안 한다, 아니면 접는다
                      if (activeResultIndex === at) {
                        if (leftEdge) return onStepBack();
                        if (!hasDeeper) return;
                      }
                      onSelectResult(row.doc, row.title, at);
                    }}
                  />
                );
              })}
              {shownPage < pageCount - 1 && <PageEdge direction="next" progress={paging.nextProgress} onClick={paging.goNext} />}
            </PageTransition>
          )}
        </div>
        <PageRail page={shownPage} pageCount={pageCount} markedPage={markedPage} onChange={setPage} />
      </div>
    </div>
  );
}
