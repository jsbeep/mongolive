import { Search, X } from 'lucide-react';

export interface SortOption {
  value: string;
  label: string;
}

interface FilterSortToolbarProps {
  filterText: string;
  onFilterTextChange: (value: string) => void;
  filterPlaceholder: string;
  sortValue: string;
  onSortChange: (value: string) => void;
  sortOptions: SortOption[];
}

// 컬럼 헤더의 필터 아이콘을 토글하면 나타나는 보조 툴바 — 검색어 입력 + 정렬 기준 선택
export function FilterSortToolbar({
  filterText,
  onFilterTextChange,
  filterPlaceholder,
  sortValue,
  onSortChange,
  sortOptions,
}: FilterSortToolbarProps) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50/60">
      <div className="relative flex-1 min-w-0">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          autoFocus
          type="text"
          value={filterText}
          onChange={(e) => onFilterTextChange(e.target.value)}
          placeholder={filterPlaceholder}
          className="w-full text-xs pl-6 pr-6 py-1.5 rounded-lg bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 transition-all"
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
      <select
        className="text-xs px-2 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 transition-all font-mono shrink-0"
        value={sortValue}
        onChange={(e) => onSortChange(e.target.value)}
      >
        {sortOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
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
