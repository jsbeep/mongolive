// 컬럼 헤더 아이콘 = 북마크 버튼. 평소엔 원래 아이콘(폴더·문서·{}·[]), 올리면 북마크 아이콘으로 바뀌고 누르면 넣고/뺀다.
// 북마크된 자리면 늘 노란 북마크로 보인다. location이 없으면(아직 열린 게 없음) 그냥 아이콘.
import type { ReactNode } from 'react';
import { Bookmark } from 'lucide-react';
import { bookmarkKey, toggleBookmark, useBookmarks, type BookmarkLocation } from '../../../services/bookmarks';
import { cn } from '../../../utils/cn';

interface BookmarkIconProps {
  icon: ReactNode;
  location: BookmarkLocation | null;
  // 문서·필드 북마크의 이름(문서 제목)
  title?: string;
  // 무엇을 북마크하는지(툴팁) — "this database", "this collection", "this document", "this field"
  what: string;
  // 북마크 아이콘 크기 — 원래 아이콘과 같게(바뀔 때 크기가 튀지 않게)
  size?: number;
}

export function BookmarkIcon({ icon, location, title, what, size = 14 }: BookmarkIconProps) {
  // 목록이 바뀌면 다시 그려지도록 구독(북마크 여부는 열쇠로 비교)
  const bookmarks = useBookmarks();
  if (!location) return <span className="flex shrink-0 items-center">{icon}</span>;
  const key = bookmarkKey(location);
  const marked = bookmarks.some((b) => bookmarkKey(b) === key);

  return (
    <button
      type="button"
      className={cn(
        'group/bm relative -m-1 flex shrink-0 items-center justify-center rounded-md p-1 transition-colors',
        marked ? 'text-amber-500 hover:bg-amber-50' : 'hover:bg-slate-100',
      )}
      aria-pressed={marked}
      aria-label={marked ? `Remove bookmark (${what})` : `Bookmark ${what}`}
      data-tt={marked ? `Bookmarked — click to remove` : `Bookmark ${what}`}
      onClick={(e) => {
        e.stopPropagation();
        toggleBookmark(location, title);
      }}
    >
      {marked ? (
        <Bookmark size={size} className="fill-current" />
      ) : (
        <>
          <span className="flex items-center group-hover/bm:hidden group-focus-visible/bm:hidden">{icon}</span>
          <Bookmark size={size} className="hidden text-slate-500 group-hover/bm:block group-focus-visible/bm:block" />
        </>
      )}
    </button>
  );
}
