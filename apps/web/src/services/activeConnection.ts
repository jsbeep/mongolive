// 이 탭이 쓰는 연결 — sessionStorage(탭마다 따로). 새로고침해도 남고, 탭을 복제하면 같이 복사되고,
// 새 탭은 비어 있어서 웰컴 화면에서 직접 고른다. 주소(URL)에는 넣지 않는다 — 기록·공유로 새지 않게.
//
// 최근 연결은 모든 탭이 같이 보도록 localStorage(이 브라우저). 연결 id만 두고 이름·주소는 서버 목록에서 찾는다.
//
// 바꾸는 곳: 웰컴 화면·연결 패널(고르기), 상태 바(끊기), 데이터 소스(서버가 '지워진 연결'이라고 할 때).
// 바뀌면 페이지가 그 연결로 통째로 다시 만들어진다(App의 key) — 이전 연결의 화면 상태가 섞이지 않게.
import { useSyncExternalStore } from 'react';

const ACTIVE_KEY = 'mongolive.connection';
const RECENT_KEY = 'mongolive.recentConnections';
const RECENT_MAX = 9;

export interface RecentConnection {
  id: string;
  at: number;
}

const readActive = (): string | null => {
  try {
    return sessionStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
};

const readRecent = (): RecentConnection[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is RecentConnection => !!r && typeof r.id === 'string' && typeof r.at === 'number');
  } catch {
    return [];
  }
};

let active = readActive();
let recent = readRecent();
// 웰컴으로 돌아온 이유(지워진 연결 등) — 웰컴 화면이 한 번 보여 준다
let notice: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getActiveConnection = (): string | null => active;

// 연결 고르기 / 끊기(null). 같은 값이면 아무 일도 없다
export const setActiveConnection = (id: string | null): void => {
  if (id === active) return;
  active = id;
  try {
    if (id) sessionStorage.setItem(ACTIVE_KEY, id);
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    // 저장이 막혀 있어도 이번 탭에선 동작한다(새로고침하면 웰컴으로)
  }
  if (id) {
    notice = null;
    recent = [{ id, at: Date.now() }, ...recent.filter((r) => r.id !== id)].slice(0, RECENT_MAX);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      // 최근 목록은 편의 기능 — 저장이 안 돼도 괜찮다
    }
  }
  notify();
};

// 연결을 쓸 수 없게 됐을 때(지워짐) — 웰컴으로 돌아가며 이유를 남긴다
export const leaveConnection = (reason: string): void => {
  if (!active) return;
  notice = reason;
  setActiveConnection(null);
};

// 지운 연결은 최근 목록에서도 뺀다 — 서버의 연결 목록을 받을 때마다
export const pruneRecentConnections = (existing: ReadonlySet<string>): void => {
  const next = recent.filter((r) => existing.has(r.id));
  if (next.length === recent.length) return;
  recent = next;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // 무시
  }
  notify();
};

// 웰컴 화면의 안내 닫기(다른 연결을 고르면 저절로 지워진다)
export const dismissConnectionNotice = (): void => {
  if (notice === null) return;
  notice = null;
  notify();
};

export const onActiveConnectionChange = subscribe;

export const useActiveConnection = (): string | null => useSyncExternalStore(subscribe, () => active);

export const useRecentConnections = (): RecentConnection[] => useSyncExternalStore(subscribe, () => recent);

// 렌더 중에 읽으며 지우지 않는다(StrictMode는 렌더를 두 번 해서 두 번째가 빈 값을 받는다) — 구독해서 읽고, 닫기로 지운다
export const useConnectionNotice = (): string | null => useSyncExternalStore(subscribe, () => notice);
