// 연결마다 따로 두는 브라우저 저장(localStorage) — 키 뒤에 "@연결 id"를 붙인다: "mongolive.bookmarks@env".
// 같은 DB·컬렉션 이름이 다른 클러스터에도 있을 수 있어서, 북마크·쿼리 기록·파이프라인·필터 기억 등은 연결마다 따로 둔다.
//
// 지금 연결은 탭마다 다르다(activeConnection, sessionStorage). 연결이 바뀌면 이 모듈이 알려 주고,
// 각 저장소가 새 연결의 값을 다시 읽는다. 연결 전(웰컴 화면)에는 읽으면 비어 있고, 써도 버린다.
//
// 마이그레이션: 연결을 나누기 전의 값(키에 "@"가 없는 것)은 처음 읽을 때 기본 연결의 것으로 한 번 옮긴다 —
// 서버 모드는 .env 연결, 데모는 데모 연결. 옮길 자리에 이미 값이 있으면 그쪽을 두고 옛 값은 지운다.
import { ENV_CONNECTION_ID } from '../types/explorer';
import { getActiveConnection, onActiveConnectionChange } from './activeConnection';

export const DEMO_CONNECTION_ID = 'demo';

// 연결 나누기 전의 값을 받을 연결
export const LEGACY_CONNECTION_ID = import.meta.env.VITE_DATA_SOURCE === 'remote' ? ENV_CONNECTION_ID : DEMO_CONNECTION_ID;

export const scopedKey = (base: string, connectionId: string) => `${base}@${connectionId}`;

// "mongolive.bookmarks@<id>" → id. 그 base의 연결별 키가 아니면 null
export const connectionIdOfKey = (base: string, key: string): string | null => {
  const prefix = `${base}@`;
  if (!key.startsWith(prefix)) return null;
  const id = key.slice(prefix.length);
  return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
};

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// 옛 키(연결 구분 없음) → 기본 연결의 키로 한 번 옮긴다
export const migrateLegacyKey = (storage: KeyValueStorage, base: string, owner = LEGACY_CONNECTION_ID): void => {
  const legacy = storage.getItem(base);
  if (legacy === null) return;
  const target = scopedKey(base, owner);
  if (storage.getItem(target) === null) storage.setItem(target, legacy);
  storage.removeItem(base);
};

export interface ConnectionScoped {
  // 지금 연결의 값(연결 전이거나 없으면 null)
  read(): string | null;
  // 지금 연결에 쓴다(연결 전이면 버린다)
  write(value: string): void;
  remove(): void;
  // 연결이 바뀌었거나 다른 탭이 이 연결의 값을 바꿨을 때 — 다시 읽으라는 신호
  onChange(listener: () => void): void;
}

export const connectionScoped = (base: string): ConnectionScoped => {
  try {
    migrateLegacyKey(localStorage, base);
  } catch {
    // 저장이 막혀 있으면 옮길 것도 없다
  }
  const keyNow = () => {
    const id = getActiveConnection();
    return id ? scopedKey(base, id) : null;
  };
  let key = keyNow();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  onActiveConnectionChange(() => {
    const next = keyNow();
    if (next === key) return;
    key = next;
    notify();
  });
  // 다른 탭에서 같은 연결의 값을 바꾸면 따라간다
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (key && e.key === key) notify();
    });
  }

  return {
    read: () => {
      if (!key) return null;
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write: (value) => {
      if (!key) return;
      try {
        localStorage.setItem(key, value);
      } catch {
        // 저장 못 해도 이번 탭에선 보인다
      }
    },
    remove: () => {
      if (!key) return;
      try {
        localStorage.removeItem(key);
      } catch {
        // 무시
      }
    },
    onChange: (listener) => {
      listeners.add(listener);
    },
  };
};

// 이 탭의 연결이 바뀔 때 — 메모리에만 두는 것(초안·실행 결과)을 비우는 곳에서 쓴다
export const onConnectionSwitch = (listener: () => void): void => {
  let current = getActiveConnection();
  onActiveConnectionChange(() => {
    const next = getActiveConnection();
    if (next === current) return;
    current = next;
    listener();
  });
};

// 연결을 지웠을 때 — 이 브라우저에 남은 그 연결의 값을 모두 지운다(연결 id는 다시 쓰지 않는다)
export const forgetConnectionStorage = (connectionId: string): void => {
  try {
    const suffix = `@${connectionId}`;
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('mongolive.') && key.endsWith(suffix)) doomed.push(key);
    }
    doomed.forEach((key) => localStorage.removeItem(key));
  } catch {
    // 못 지우면 남을 뿐 — 보이지 않는다
  }
};
