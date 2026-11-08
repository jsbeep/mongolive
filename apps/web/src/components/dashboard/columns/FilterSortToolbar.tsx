import { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { SortMenuButton, type SortOption } from './SortMenuButton';

export type { SortOption } from './SortMenuButton';

interface FilterSortToolbarProps {
  filterText: string;
  onFilterTextChange: (value: string) => void;
  filterPlaceholder: string;
  sortValue: string;
  onSortChange: (value: string) => void;
  sortOptions: SortOption[];
  // Esc로 닫기 — 필터 버튼을 다시 누른 것과 같다(걸어 둔 필터는 그대로, 버튼의 초록 점으로 남는다)
  onClose: () => void;
  // 열릴 때 입력칸이 커서를 잡나(기본 true). 문서 컬럼의 찾기 패널은 false로 두고 focusSignal로 보낸다
  autoFocus?: boolean;
  // 바뀔 때마다 입력칸으로 커서를 보낸다(찾기 버튼·'/' 단축키)
  focusSignal?: number;
}

// 컬럼 헤더의 필터 아이콘을 토글하면 나타나는 보조 툴바 — 검색어 입력 + 정렬 기준 선택(아이콘 버튼 + 메뉴)
export function FilterSortToolbar({
  filterText,
  onFilterTextChange,
  filterPlaceholder,
  sortValue,
  onSortChange,
  sortOptions,
  onClose,
  autoFocus = true,
  focusSignal,
}: FilterSortToolbarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSignal !== undefined) inputRef.current?.focus();
  }, [focusSignal]);
  return (
    <div
      className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50/60"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="relative flex-1 min-w-0">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          type="text"
          value={filterText}
          onChange={(e) => onFilterTextChange(e.target.value)}
          placeholder={filterPlaceholder}
          className="w-full text-[13px] pl-6 pr-6 py-1.5 rounded-lg bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 transition-all"
        />
        {filterText && (
          <button
            type="button"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500"
            onClick={() => onFilterTextChange('')}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <SortMenuButton value={sortValue} options={sortOptions} onChange={onSortChange} />
      {sortValue !== 'none' && (
        <button
          type="button"
          title="Clear all filters"
          className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:bg-slate-200/70 hover:text-slate-600 transition-colors"
          onClick={() => {
            onFilterTextChange('');
            onSortChange('none');
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
