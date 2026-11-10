// 파이프라인 저장·기록 — 컬렉션마다, 이 브라우저(localStorage)에만. 사용자 MongoDB엔 아무것도 남기지 않는다.
//   saved   이름 붙여 저장한 것(컬렉션마다 30개까지)
//   history 붙인 파이프라인이 바뀌어 다시 셀 때마다 남는 최근 버전(같은 버전은 하나만, 최근 것이 앞 — 15개까지)
// 스테이지는 글자와 켜짐만 둔다(id는 불러올 때 새로 만든다 — 지금 파이프라인과 섞이지 않게).
import { useSyncExternalStore } from 'react';
import { getPipelineStages, INPUT_STAGE_ID, isRunnable, newStageId, pipelineKey, setPipelineStages, type PipelineStage } from './pipelines';
import { getPipelineDrafts, updatePipelineDrafts } from './pipelineDrafts';

export interface StoredStage {
  text: string;
  enabled: boolean;
}

export interface SavedPipeline {
  id: string;
  name: string;
  stages: StoredStage[];
  at: number;
}

export interface PipelineVersion {
  stages: StoredStage[];
  at: number;
}

export interface SavedPipelineStore {
  saved: Record<string, SavedPipeline[]>;
  history: Record<string, PipelineVersion[]>;
}

const KEY = 'mongolive.savedPipelines.v1';
const MAX_SAVED = 30;
const MAX_HISTORY = 15;
// 기록이 남은 컬렉션 수 — 넘으면 오래된 것부터 잊는다(저장한 것은 지우지 않는다)
const MAX_HISTORY_TARGETS = 100;

const isStored = (s: unknown): s is StoredStage =>
  !!s && typeof s === 'object' && typeof (s as StoredStage).text === 'string' && typeof (s as StoredStage).enabled === 'boolean';

const read = (): SavedPipelineStore => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<SavedPipelineStore>;
    const saved: SavedPipelineStore['saved'] = {};
    const history: SavedPipelineStore['history'] = {};
    for (const [key, list] of Object.entries(raw.saved ?? {})) {
      if (Array.isArray(list)) {
        saved[key] = list.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.stages))
          .map((p) => ({ ...p, stages: p.stages.filter(isStored) }));
      }
    }
    for (const [key, list] of Object.entries(raw.history ?? {})) {
      if (Array.isArray(list)) history[key] = list.filter((v) => v && Array.isArray(v.stages)).map((v) => ({ ...v, stages: v.stages.filter(isStored) }));
    }
    return { saved, history };
  } catch {
    return { saved: {}, history: {} };
  }
};

let store = read();
const listeners = new Set<() => void>();
const write = (next: SavedPipelineStore) => {
  store = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 저장 못 해도 이번 탭에선 쓴다
  }
  listeners.forEach((listener) => listener());
};

const toStored = (stages: PipelineStage[]): StoredStage[] =>
  stages.filter((s) => !s.pending).map((s) => ({ text: s.text, enabled: s.enabled }));
const sameStages = (a: StoredStage[], b: StoredStage[]) => JSON.stringify(a) === JSON.stringify(b);

export const savePipeline = (database: string, collection: string, name: string, stages: PipelineStage[]) => {
  const key = pipelineKey(database, collection);
  const entry: SavedPipeline = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name, stages: toStored(stages), at: Date.now() };
  // 같은 이름이면 덮어쓴다
  const list = (store.saved[key] ?? []).filter((p) => p.name !== name);
  write({ ...store, saved: { ...store.saved, [key]: [entry, ...list].slice(0, MAX_SAVED) } });
};

export const deleteSavedPipeline = (database: string, collection: string, id: string) => {
  const key = pipelineKey(database, collection);
  write({ ...store, saved: { ...store.saved, [key]: (store.saved[key] ?? []).filter((p) => p.id !== id) } });
};

// 붙인 파이프라인 한 버전 — 비었으면 남기지 않는다. 이미 있던 버전이면 맨 앞으로
export const recordPipelineVersion = (database: string, collection: string, stages: PipelineStage[]) => {
  const stored = toStored(stages);
  if (!stored.length) return;
  const key = pipelineKey(database, collection);
  const list = store.history[key] ?? [];
  if (list[0] && sameStages(list[0].stages, stored)) return;
  const history = { ...store.history, [key]: [{ stages: stored, at: Date.now() }, ...list.filter((v) => !sameStages(v.stages, stored))].slice(0, MAX_HISTORY) };
  const keys = Object.keys(history);
  if (keys.length > MAX_HISTORY_TARGETS) {
    keys.sort((a, b) => (history[a][0]?.at ?? 0) - (history[b][0]?.at ?? 0)).slice(0, keys.length - MAX_HISTORY_TARGETS).forEach((k) => delete history[k]);
  }
  write({ ...store, history });
};

// 저장한 것·최근 버전으로 그 컬렉션의 파이프라인을 통째로 바꾼다(초안·아직 안 돌린 스테이지도 비운다).
// 이미 그대로면(붙인 스테이지가 같고 바꾸던 것도 없으면) null. lastId = 보여 줄 스테이지(마지막으로 돌리는 것, 없으면 원본), undo = 바꾸기 전으로
export const replacePipeline = (database: string, collection: string, stored: StoredStage[]): { lastId: string; undo: () => void } | null => {
  const before = getPipelineStages(database, collection);
  const drafts = getPipelineDrafts(database, collection);
  const untouched = !before.some((s) => s.pending) && !Object.keys(drafts.drafts).length;
  if (untouched && sameStages(toStored(before), stored)) return null;
  const next: PipelineStage[] = stored.map((s) => ({ id: newStageId(), text: s.text, enabled: s.enabled }));
  setPipelineStages(database, collection, next);
  updatePipelineDrafts(database, collection, () => ({ drafts: {}, collected: {}, editingId: null, lastCollectedId: null, focus: null }));
  return {
    lastId: [...next].reverse().find(isRunnable)?.id ?? INPUT_STAGE_ID,
    undo: () => {
      setPipelineStages(database, collection, before);
      updatePipelineDrafts(database, collection, () => ({ ...drafts, focus: null }));
    },
  };
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    store = read();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
};

const NO_SAVED: SavedPipeline[] = [];
const NO_HISTORY: PipelineVersion[] = [];
export const useSavedPipelines = (database: string | null, collection: string | null): SavedPipeline[] =>
  useSyncExternalStore(subscribe, () => (database && collection ? store.saved[pipelineKey(database, collection)] ?? NO_SAVED : NO_SAVED));
export const usePipelineHistory = (database: string | null, collection: string | null): PipelineVersion[] =>
  useSyncExternalStore(subscribe, () => (database && collection ? store.history[pipelineKey(database, collection)] ?? NO_HISTORY : NO_HISTORY));
// 모든 컬렉션의 저장·기록(키 = pipelineKey) — 사이드바 Aggregation 패널
export const useAllSavedPipelines = (): SavedPipelineStore => useSyncExternalStore(subscribe, () => store);
