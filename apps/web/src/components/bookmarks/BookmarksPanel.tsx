// 사이드바 Bookmarks 버튼으로 여는 패널 — 북마크한 자리를 DB별로(References 패널처럼 접고 펼친다).
//   누르기 = 그 자리로 이동(DB / 컬렉션 / 문서 / 필드까지), × = 북마크 빼기. 고르면 닫힌다.
// 북마크는 컬럼 헤더 아이콘(폴더·문서·{})에 올리면 나오는 북마크 버튼으로 넣는다.
import { useState } from 'react';
import { Bookmark as BookmarkGlyph, Braces, ChevronRight, Database, FileText, Folder, X } from 'lucide-react';
import type { DatabaseSummary } from '../../types/explorer';
import { removeBookmark, type Bookmark } from '../../services/bookmarks';
import { cn } from '../../utils/cn';
import { SidebarPopover } from '../layout/SidebarPopover';

interface BookmarksPanelProps {
  anchor: DOMRect;
  bookmarks: Bookmark[];
  // 그룹 순서(사이드바 트리 순서) — 없는 DB의 북마크는 맨 뒤에
  databases: DatabaseSummary[];
  onOpen: (bookmark: Bookmark) => void;
  onClose: () => void;
}

const kindOf = (b: Bookmark) => (!b.collection ? 'database' : !b.documentId ? 'collection' : b.path?.length ? 'field' : 'document');

const ICON = { database: Database, collection: Folder, document: FileText, field: Braces } as const;

export function BookmarksPanel({ anchor, bookmarks, databases, onOpen, onClose }: BookmarksPanelProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (db: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(db)) next.delete(db);
      else next.add(db);
      return next;
    });

  const order = new Map(databases.map((d, i) => [d.name, i]));
  const groups = [...bookmarks.reduce<Map<string, Bookmark[]>>((map, b) => map.set(b.database, [...(map.get(b.database) ?? []), b]), new Map())]
    .sort(([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || a.localeCompare(b));

  const row = (b: Bookmark) => {
    const kind = kindOf(b);
    const Icon = ICON[kind];
    const primary = kind === 'database' ? 'Whole database' : kind === 'collection' ? b.collection! : b.title || b.documentId!;
    const secondary = kind === 'document' || kind === 'field' ? `${b.collection}${b.path?.length ? ` › ${b.path.join('.')}` : ''}` : null;
    return (
      <li key={b.id} className="group relative">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 pr-8 text-left transition-colors hover:bg-slate-100"
          data-tt="Open this place"
          onClick={() => onOpen(b)}
        >
          <Icon size={13} className="shrink-0 text-amber-500" />
          <span className="flex min-w-0 flex-col">
            <span className={cn('truncate text-[13px] text-slate-700', kind === 'collection' && 'font-mono text-xs')}>{primary}</span>
            {secondary && <span className="truncate font-mono text-[11px] text-slate-400">{secondary}</span>}
          </span>
        </button>
        <button
          type="button"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-400 opacity-0 transition-opacity hover:bg-slate-200/70 hover:text-slate-600 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label="Remove bookmark"
          data-tt="Remove bookmark"
          onClick={() => removeBookmark(b.id)}
        >
          <X size={12} />
        </button>
      </li>
    );
  };

  return (
    <SidebarPopover anchor={anchor} title="Bookmarks" icon={<BookmarkGlyph size={14} />} onClose={onClose}>
      {bookmarks.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs leading-5 text-slate-400">
          No bookmarks yet.
          <br />
          Hover a column’s icon (
          <Folder size={12} className="inline align-[-2px]" aria-label="collections" />{' '}
          <FileText size={12} className="inline align-[-2px]" aria-label="documents" />{' '}
          <Braces size={12} className="inline align-[-2px]" aria-label="fields" />
          ) and click <BookmarkGlyph size={12} className="inline align-[-2px]" aria-label="bookmark" /> to save that place.
        </p>
      ) : (
        groups.map(([database, items]) => {
          const isOpen = !collapsed.has(database);
          return (
            <section key={database}>
              <button
                type="button"
                className="sticky -top-1.5 z-10 flex w-full items-center gap-2 bg-white px-2 py-1.5 text-left"
                onClick={() => toggle(database)}
                aria-expanded={isOpen}
              >
                <ChevronRight size={13} className={cn('shrink-0 text-slate-400 transition-transform', isOpen && 'rotate-90')} />
                <Database size={13} className="shrink-0 text-slate-400" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-slate-800">{database}</span>
                <span className="shrink-0 text-[11px] text-slate-400">{items.length}</span>
              </button>
              {isOpen && <ul className="flex flex-col gap-0.5 pb-2 pl-4">{items.map(row)}</ul>}
            </section>
          );
        })
      )}
    </SidebarPopover>
  );
}
