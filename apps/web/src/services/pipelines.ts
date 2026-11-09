// 컬렉션마다의 aggregation 파이프라인(스테이지 글자 + 켜짐) — 이 브라우저(localStorage)에만 둔다.
// 사용자 MongoDB엔 아무것도 남기지 않는다. 결과는 여기 두지 않는다(크고 금방 낡는다 — services/aggregateRuns가 메모리에).
// 스테이지 글자는 사용자가 쓴 그대로(줄바꿈·띄어쓰기 유지) — 적용할 때 읽어 보고 맞을 때만 저장하므로 늘 읽힌다.
import { useSyncExternalStore } from 'react';
import { formatStageText, parseStageText, stageName, validatePipelineStage, type EjsonObject } from '@mongolive/shared';

export interface PipelineStage {
  id: string;
  text: string;
  enabled: boolean;
  // 탐색하며 모아서(Collect) 새로 생긴, 아직 안 돌린 스테이지 — 카드는 점선, 실행할 땐 빼고(꺼진 것처럼), Run이 붙인다
  pending?: boolean;
}

// 출력 컬럼이 '원본 문서'(빈 파이프라인 = 컬렉션 그대로)를 보일 때의 스테이지 자리
export const INPUT_STAGE_ID = '@input';

interface SavedPipeline {
  stages: PipelineStage[];
  at: number;
}

const KEY = 'mongolive.pipelines.v1';
// 오래 안 쓴 컬렉션부터 잊는다
const MAX_TARGETS = 100;

export const pipelineKey = (database: string, collection: string) => `${database}\u0000${collection}`;

const isStage = (s: unknown): s is PipelineStage =>
  !!s && typeof s === 'object'
  && typeof (s as PipelineStage).id === 'string'
  && typeof (s as PipelineStage).text === 'string'
  && typeof (s as PipelineStage).enabled === 'boolean';

const read = (): Record<string, SavedPipeline> => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, SavedPipeline> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const v = value as SavedPipeline;
      if (v && Array.isArray(v.stages) && typeof v.at === 'number') out[key] = { stages: v.stages.filter(isStage), at: v.at };
    }
    return out;
  } catch {
    return {};
  }
};

let saved = read();
const listeners = new Set<() => void>();
const EMPTY: PipelineStage[] = [];

const write = (next: Record<string, SavedPipeline>) => {
  saved = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 저장 못 해도 이번 탭에선 쓴다
  }
  listeners.forEach((listener) => listener());
};

export const newStageId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const getPipelineStages = (database: string, collection: string): PipelineStage[] =>
  saved[pipelineKey(database, collection)]?.stages ?? EMPTY;

export const setPipelineStages = (database: string, collection: string, stages: PipelineStage[]) => {
  const key = pipelineKey(database, collection);
  const next = { ...saved };
  if (stages.length) next[key] = { stages, at: Date.now() };
  else delete next[key];
  // 너무 많아지면 오래된 것부터
  const keys = Object.keys(next);
  if (keys.length > MAX_TARGETS) {
    keys.sort((a, b) => next[a].at - next[b].at).slice(0, keys.length - MAX_TARGETS).forEach((k) => delete next[k]);
  }
  write(next);
};

// 스테이지 글자 → 값. 저장된 글자는 적용할 때 검사를 거쳤지만, 다른 탭·옛 버전에서 온 것일 수 있어 다시 본다
export const stageValue = (stage: PipelineStage): EjsonObject | null => {
  const parsed = parseStageText(stage.text);
  if (!parsed.ok || validatePipelineStage(parsed.stage)) return null;
  return parsed.stage;
};

// 켜진(그리고 이미 붙인) 스테이지만 0..upto(포함) — 그 스테이지의 '출력'을 만드는 파이프라인. 못 읽는 스테이지가 있으면 null
export const isRunnable = (stage: PipelineStage) => stage.enabled && !stage.pending;
export const prefixPipeline = (stages: PipelineStage[], upto: number): EjsonObject[] | null => {
  const out: EjsonObject[] = [];
  for (let i = 0; i <= upto && i < stages.length; i++) {
    if (!isRunnable(stages[i])) continue;
    const value = stageValue(stages[i]);
    if (!value) return null;
    out.push(value);
  }
  return out;
};

// 통 JSON 모드 — 스테이지 글자들을 배열 하나로(각 스테이지는 2칸 들여 쓴다)
export const pipelineText = (stages: PipelineStage[]): string =>
  stages.length ? `[\n${stages.map((s) => s.text.split('\n').map((line) => `  ${line}`).join('\n')).join(',\n')}\n]` : '[]';

// 통 JSON을 적용할 때 — 값이 같은 옛 스테이지는 그대로 이어받고(id·켜짐·글자 모양), 새로 생긴 것만 켜서 만든다
export const stagesFromValues = (values: EjsonObject[], previous: PipelineStage[]): PipelineStage[] => {
  const pool = previous.map((s) => ({ stage: s, key: JSON.stringify(stageValue(s)) }));
  return values.map((value) => {
    const key = JSON.stringify(value);
    const at = pool.findIndex((p) => p.key === key);
    if (at >= 0) return pool.splice(at, 1)[0].stage;
    return { id: newStageId(), text: formatStageText(value), enabled: true };
  });
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // 다른 탭에서 바꾸면 따라간다
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    saved = read();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
};

export const usePipelineStages = (database: string | null, collection: string | null): PipelineStage[] =>
  useSyncExternalStore(subscribe, () => (database && collection ? getPipelineStages(database, collection) : EMPTY));

// 출력 컬럼·breadcrumb의 이름 — "2 · $group"(번호는 1부터, 꺼진 스테이지도 센다). 원본은 'Original documents'
export const stageLabel = (stages: PipelineStage[], id: string): string => {
  if (id === INPUT_STAGE_ID) return 'Original documents';
  const i = stages.findIndex((s) => s.id === id);
  if (i < 0) return 'Stage';
  const value = stageValue(stages[i]);
  return `${i + 1} · ${value ? stageName(value) : 'stage'}`;
};
