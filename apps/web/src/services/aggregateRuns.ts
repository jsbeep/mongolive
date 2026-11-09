// aggregation 실행 결과 — 메모리에만(탭을 닫으면 사라진다). 파이프라인 자체는 services/pipelines(localStorage).
//   출력: 파이프라인(켜진 스테이지 0..k)마다 한 번 받아 두고, 같은 스테이지를 다시 누르면 다시 묻지 않는다
//   개수: 스테이지 카드의 "31 → 12" — 켜진 파이프라인 전체에 대해 한 번
//   낡음: 받은 뒤 그 컬렉션이 바뀌면(실시간 반영) 표시만 한다 — 다시 돌리는 건 사용자가(Run)
//   미리보기: 스테이지 편집기의 Preview — 적용 전 글자로 돌린 출력을 출력 컬럼에 잠깐 보여 준다
import { useSyncExternalStore } from 'react';
import type { AggregateCounts, AggregateResult, EjsonObject } from '@mongolive/shared';
import { api } from './api';
import { pipelineKey } from './pipelines';

export type RunState<T> =
  | { status: 'loading' }
  | { status: 'done'; data: T }
  | { status: 'error'; message: string };

// 결과는 최대 500개씩이라 너무 많이 들고 있지 않는다 — 오래된 것부터 버린다
const MAX_OUTPUTS = 40;

const outputs = new Map<string, RunState<AggregateResult>>();
const counts = new Map<string, RunState<AggregateCounts>>();
const stale = new Set<string>();
// 편집기 미리보기 — 대상(DB·컬렉션)마다 하나. stageId '*' = 통 JSON 모드 전체
export interface PipelinePreview {
  stageId: string;
  pipeline: EjsonObject[];
}
const previews = new Map<string, PipelinePreview>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const runKey = (database: string, collection: string, pipeline: EjsonObject[]) =>
  `${pipelineKey(database, collection)}\u0000${JSON.stringify(pipeline)}`;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : 'Aggregation failed');

// 받은 뒤 그 컬렉션이 바뀌면 '낡았을 수 있음' — 처음 돌릴 때 한 번만 구독한다
let watching = false;
const watchLive = () => {
  if (watching) return;
  watching = true;
  api.onLiveChange((change) => {
    if (!change.collection) return;
    const target = pipelineKey(change.database, change.collection);
    if (stale.has(target)) return;
    const prefix = `${target}\u0000`;
    const hasResults = [...outputs.keys(), ...counts.keys()].some((key) => key.startsWith(prefix));
    if (!hasResults) return;
    stale.add(target);
    emit();
  });
};

const run = <T,>(map: Map<string, RunState<T>>, key: string, force: boolean, request: () => Promise<T>, max = Infinity) => {
  watchLive();
  if (!force && map.has(key)) return;
  const loading: RunState<T> = { status: 'loading' };
  map.delete(key);
  map.set(key, loading);
  // Map은 넣은 순서를 지킨다 — 맨 앞이 가장 오래된 것
  if (map.size > max) map.delete(map.keys().next().value!);
  emit();
  request()
    .then((data) => {
      // 그 사이 다시 돌렸으면(Run) 늦게 온 옛 응답은 버린다
      if (map.get(key) === loading) map.set(key, { status: 'done', data });
    })
    .catch((e: unknown) => {
      if (map.get(key) === loading) map.set(key, { status: 'error', message: messageOf(e) });
    })
    .finally(emit);
};

// 이 파이프라인의 출력 — 이미 받았으면(실패 포함) 다시 묻지 않는다. force = Run
export const loadOutput = (database: string, collection: string, pipeline: EjsonObject[], force = false) =>
  run(outputs, runKey(database, collection, pipeline), force, () => api.aggregate(database, collection, pipeline), MAX_OUTPUTS);

export const loadCounts = (database: string, collection: string, pipeline: EjsonObject[], force = false) =>
  run(counts, runKey(database, collection, pipeline), force, () => api.aggregateCounts(database, collection, pipeline), MAX_OUTPUTS);

// Run — 이 대상의 받아 둔 출력·개수를 버린다(지금 보이는 것은 호출한 쪽이 force로 다시 받는다). 낡음 표시도 지운다
export const forgetRuns = (database: string, collection: string) => {
  const prefix = `${pipelineKey(database, collection)}\u0000`;
  for (const key of [...outputs.keys()]) if (key.startsWith(prefix)) outputs.delete(key);
  for (const key of [...counts.keys()]) if (key.startsWith(prefix)) counts.delete(key);
  stale.delete(pipelineKey(database, collection));
  emit();
};

export const setPreview = (database: string, collection: string, preview: PipelinePreview | null) => {
  const target = pipelineKey(database, collection);
  if (preview) {
    previews.set(target, preview);
    loadOutput(database, collection, preview.pipeline, true);
  } else if (previews.has(target)) {
    previews.delete(target);
  } else {
    return;
  }
  emit();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useOutput = (database: string, collection: string, pipeline: EjsonObject[] | null) => {
  const key = pipeline ? runKey(database, collection, pipeline) : '';
  return useSyncExternalStore(subscribe, () => (key ? outputs.get(key) : undefined));
};

export const useCounts = (database: string, collection: string, pipeline: EjsonObject[] | null) => {
  const key = pipeline ? runKey(database, collection, pipeline) : '';
  return useSyncExternalStore(subscribe, () => (key ? counts.get(key) : undefined));
};

export const useStale = (database: string, collection: string) =>
  useSyncExternalStore(subscribe, () => stale.has(pipelineKey(database, collection)));

export const usePreview = (database: string, collection: string) =>
  useSyncExternalStore(subscribe, () => previews.get(pipelineKey(database, collection)) ?? null);
