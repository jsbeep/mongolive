// 쿼리 기록(이 브라우저, 연결마다 따로) — 실행에 성공한 쿼리만. 같은 컬렉션의 같은 쿼리는 하나로(맨 위로 올린다), 최대 MAX개.
// 사이드바 Query 패널이 보여 주고, 누르면 지금 컬렉션에 다시 실행한다. 사용자 MongoDB에는 아무것도 남기지 않는다.
import { useSyncExternalStore } from 'react';
import { validateQueryFilter, type JsonObject } from '../types/explorer';
import { connectionScoped } from './connectionStorage';

export interface QueryHistoryEntry {
  id: string;
  database: string;
  collection: string;
  // 사용자가 쓴 글자 그대로(보여 주기·다시 넣기)
  text: string;
  // 실행한 쿼리(Canonical) — 다시 실행할 때 파싱 없이
  filter: JsonObject;
  at: number;
}

const storage = connectionScoped('mongolive.queryHistory');
const MAX = 50;

const read = (): QueryHistoryEntry[] => {
  try {
    const raw = JSON.parse(storage.read() ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    // 손으로 고친 값 대비 — 모양이 맞고 허용 연산자 검사를 통과한 것만
    return raw.filter((e): e is QueryHistoryEntry =>
      !!e && typeof e === 'object'
      && typeof e.id === 'string' && typeof e.database === 'string' && typeof e.collection === 'string'
      && typeof e.text === 'string' && typeof e.at === 'number'
      && !!e.filter && typeof e.filter === 'object' && !validateQueryFilter(e.filter));
  } catch {
    return [];
  }
};

let entries: QueryHistoryEntry[] = read();
const listeners = new Set<() => void>();

const save = (next: QueryHistoryEntry[]) => {
  entries = next;
  storage.write(JSON.stringify(next));
  listeners.forEach((listener) => listener());
};

// 연결이 바뀌거나 다른 탭이 이 연결의 기록을 바꾸면 다시 읽는다
storage.onChange(() => {
  entries = read();
  listeners.forEach((listener) => listener());
});

const sameQuery = (a: Pick<QueryHistoryEntry, 'database' | 'collection' | 'filter'>, b: typeof a) =>
  a.database === b.database && a.collection === b.collection && JSON.stringify(a.filter) === JSON.stringify(b.filter);

export const recordQuery = (entry: Omit<QueryHistoryEntry, 'id' | 'at'>) => {
  const rest = entries.filter((e) => !sameQuery(e, entry));
  save([{ ...entry, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now() }, ...rest].slice(0, MAX));
};

export const removeQueryHistory = (id: string) => save(entries.filter((e) => e.id !== id));
export const clearQueryHistory = () => save([]);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useQueryHistory = (): QueryHistoryEntry[] => useSyncExternalStore(subscribe, () => entries);
