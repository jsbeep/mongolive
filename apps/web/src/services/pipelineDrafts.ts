// 파이프라인의 '아직 적용 안 한 것' — 컬렉션마다(이 탭 메모리에만). Pipeline 컬럼과 '모으기'(필드 메뉴)가 같이 쓴다.
//   drafts         스테이지 id → 고친 글자(편집기에서 쓰거나 모아서 쌓인 것). 카드에 주황 점
//   collected      스테이지 id → 모아서 바뀐 횟수(카드의 +N). 적용·되돌리기·Run이면 지운다
//   editingId      편집기가 열린 카드(모으는 자리 1순위)
//   lastCollectedId 마지막으로 모은 스테이지 — Run 뒤 그 출력을 본다
//   focus          편집기 입력칸으로 커서를 보내 달라는 한 번짜리 요청(새로 만든 $lookup의 as 자리 등)
import { useSyncExternalStore } from 'react';
import { pipelineKey } from './pipelines';

export interface PipelineDrafts {
  drafts: Record<string, string>;
  collected: Record<string, number>;
  editingId: string | null;
  lastCollectedId: string | null;
  focus: { id: string; seq: number; range: [number, number] | null } | null;
}

const EMPTY: PipelineDrafts = { drafts: {}, collected: {}, editingId: null, lastCollectedId: null, focus: null };
const states = new Map<string, PipelineDrafts>();
const listeners = new Set<() => void>();

export const getPipelineDrafts = (database: string, collection: string): PipelineDrafts =>
  states.get(pipelineKey(database, collection)) ?? EMPTY;

export const updatePipelineDrafts = (database: string, collection: string, update: (current: PipelineDrafts) => PipelineDrafts) => {
  const key = pipelineKey(database, collection);
  states.set(key, update(states.get(key) ?? EMPTY));
  listeners.forEach((listener) => listener());
};

// 편집기로 커서를(range가 있으면 그 글자를 골라) — 그 편집기가 받으면 focus를 비운다
export const requestEditorFocus = (database: string, collection: string, id: string, range: [number, number] | null = null) =>
  updatePipelineDrafts(database, collection, (s) => ({ ...s, focus: { id, seq: (s.focus?.seq ?? 0) + 1, range } }));

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const usePipelineDrafts = (database: string | null, collection: string | null): PipelineDrafts =>
  useSyncExternalStore(subscribe, () => (database && collection ? getPipelineDrafts(database, collection) : EMPTY));

// 바뀐 카드 수(고친 글자 + 아직 안 붙인 스테이지) — Run 버튼의 숫자
export const pendingChangeCount = (drafts: PipelineDrafts, pendingIds: string[]): number =>
  new Set([...Object.keys(drafts.drafts), ...pendingIds]).size;
