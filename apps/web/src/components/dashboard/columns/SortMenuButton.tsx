// 정렬 고르기 — 드롭다운 대신 아이콘 버튼 하나(좁은 컬럼에서 검색칸 자리를 뺏지 않게).
// 아이콘은 지금 정렬의 요약(A→Z, 시계…)이고 정확한 이름은 툴팁, 누르면 전체 목록이 아이콘·이름·✓와 함께 펼쳐진다.
// 기본 순서가 아니면 초록색 — 정렬이 걸려 있다는 표시.
import { useEffect, useRef, useState } from 'react';
import { ArrowUpDown, Check, type LucideIcon } from 'lucide-react';
import { cn } from '../../../utils/cn';

export interface SortOption {
  value: string;
  label: string;
  // 이 정렬일 때 버튼에 보일 아이콘(없으면 ↑↓)
  icon?: LucideIcon;
}

interface SortMenuButtonProps {
  value: string;
  options: SortOption[];
  onChange: (value: string) => void;
}

export function SortMenuButton({ value, options, onChange }: SortMenuButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];
  const Icon = current?.icon ?? ArrowUpDown;
  const isSorted = value !== 'none';

  // 바깥을 누르거나 Esc면 메뉴만 닫는다(Esc가 찾기 패널까지 닫지 않게 먼저 가로챈다)
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sort: ${current?.label ?? ''}`}
        data-tt={`Sort: ${current?.label ?? ''}`}
        className={cn(
          'flex h-[30px] w-[30px] items-center justify-center rounded-lg border transition-colors',
          isSorted
            ? 'border-emerald-200 bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
            : 'border-slate-200 bg-white text-slate-400 hover:bg-slate-100 hover:text-slate-600',
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={14} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1.5 flex min-w-[170px] flex-col gap-0.5 rounded-xl bg-white p-1 shadow-elevated ring-1 ring-slate-100">
          {options.map((option) => {
            const OptionIcon = option.icon ?? ArrowUpDown;
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-slate-100',
                  selected ? 'text-emerald-700' : 'text-slate-600',
                )}
                onClick={() => {
                  setOpen(false);
                  onChange(option.value);
                }}
              >
                <OptionIcon size={13} className={cn('shrink-0', selected ? 'text-emerald-500' : 'text-slate-400')} />
                <span className="flex-1">{option.label}</span>
                {selected && <Check size={12} className="shrink-0 text-emerald-500" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
