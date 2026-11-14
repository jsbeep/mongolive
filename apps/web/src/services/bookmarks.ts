// 경로 북마크(이 브라우저, 연결마다 따로) — DB / 컬렉션 / 문서(+ 그 안의 필드 경로). 컬럼 헤더 아이콘으로 넣고 빼며,
// 사이드바 Bookmarks 패널이 DB별로 보여 준다. 사용자 MongoDB에는 아무것도 남기지 않는다(설정 내보내기에는 들어간다).
import { useSyncExternalStore } from 'react';
import { connectionScoped } from './connectionStorage';

export interface BookmarkLocation {
  database: string;
  collection?: string;
  // 문서 식별자(summary.getDocumentId 규칙) — collection이 있을 때만
  documentId?: string;
  // 문서 안 경로(["likes", "0"]) — documentId가 있을 때만, 없으면 문서 자체
  path?: string[];
}

export interface Bookmark extends BookmarkLocation {
  id: string;
  // 문서 제목(문서·필드 북마크) — 패널에 보일 이름. 저장할 때의 제목이라 나중에 바뀌었을 수 있다
  title?: string;
  at: number;
}

export const BOOKMARKS_KEY = 'mongolive.bookmarks';
const storage = connectionScoped(BOOKMARKS_KEY);
const MAX = 200;

// 같은 자리인가를 가리는 열쇠
export const bookmarkKey = (loc: BookmarkLocation): string =>
  JSON.stringify([loc.database, loc.collection ?? null, loc.documentId ?? null, loc.path?.length ? loc.path : null]);

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

const read = (): Bookmark[] => {
  try {
    const raw = JSON.parse(storage.read() ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((b): b is Bookmark =>
      !!b && typeof b === 'object'
      && typeof b.id === 'string' && typeof b.database === 'string' && typeof b.at === 'number'
      && (b.collection === undefined || typeof b.collection === 'string')
      && (b.documentId === undefined || typeof b.documentId === 'string')
      && (b.path === undefined || isStrings(b.path))
      && (b.title === undefined || typeof b.title === 'string'));
  } catch {
    return [];
  }
};

let bookmarks: Bookmark[] = read();
let keys = new Set(bookmarks.map(bookmarkKey));
const listeners = new Set<() => void>();

const save = (next: Bookmark[]) => {
  bookmarks = next;
  keys = new Set(next.map(bookmarkKey));
  storage.write(JSON.stringify(next));
  listeners.forEach((listener) => listener());
};

// 연결이 바뀌거나 다른 탭이 이 연결의 북마크를 바꾸면 다시 읽는다
storage.onChange(() => {
  bookmarks = read();
  keys = new Set(bookmarks.map(bookmarkKey));
  listeners.forEach((listener) => listener());
});

export const isBookmarked = (loc: BookmarkLocation): boolean => keys.has(bookmarkKey(loc));

// 있으면 빼고 없으면 넣는다. 반환값 = 이제 북마크인가
export const toggleBookmark = (loc: BookmarkLocation, title?: string): boolean => {
  const key = bookmarkKey(loc);
  if (keys.has(key)) {
    save(bookmarks.filter((b) => bookmarkKey(b) !== key));
    return false;
  }
  const entry: Bookmark = {
    database: loc.database,
    ...(loc.collection ? { collection: loc.collection } : {}),
    ...(loc.collection && loc.documentId ? { documentId: loc.documentId } : {}),
    ...(loc.documentId && loc.path?.length ? { path: loc.path } : {}),
    ...(title ? { title } : {}),
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
  };
  save([entry, ...bookmarks].slice(0, MAX));
  return true;
};

export const removeBookmark = (id: string) => save(bookmarks.filter((b) => b.id !== id));

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useBookmarks = (): Bookmark[] => useSyncExternalStore(subscribe, () => bookmarks);
