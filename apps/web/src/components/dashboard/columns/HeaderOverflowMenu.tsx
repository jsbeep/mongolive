// 컬럼 헤더가 좁을 때 오른쪽 버튼들을 접어 넣는 '⋯' 메뉴(useHeaderFold가 접을지 정한다).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '../../../utils/cn';

export interface HeaderMenuItem {
  icon: ReactNode;
  label: string;
  // 오른쪽에 흐리게(지금 값, 개수 등)
  detail?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export function HeaderOverflowMenu({ items }: { items: HeaderMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 바깥을 누르거나 Esc면 닫는다
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
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
        aria-label="More"
        data-tt="More"
        className={cn(
          'p-1.5 rounded-lg transition-colors',
          open ? 'bg-slate-200/70 text-slate-700' : 'bg-slate-100 text-slate-400 hover:bg-slate-200/70 hover:text-slate-600',
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1.5 flex min-w-[180px] flex-col gap-0.5 rounded-xl bg-white p-1 shadow-elevated ring-1 ring-slate-100">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-slate-600 transition-colors hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className="shrink-0 text-slate-400">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.detail && <span className="max-w-[10ch] truncate font-mono text-xs text-slate-400">{item.detail}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
