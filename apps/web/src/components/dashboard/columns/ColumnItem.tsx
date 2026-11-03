import { useEffect, useRef } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { Pencil, ChevronRight, Zap } from 'lucide-react';
import { cn } from '../../../utils/cn';
import { SPRING_HOVER } from '../../../utils/motionPresets';
import { useHover } from '../../../hooks/useHover';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ColumnItemProps {
  label: string;
  meta?: string;
  iconLabel?: string;
  isActive: boolean;
  isLoading?: boolean;
  isHighlighted?: boolean;
  isHeavy?: boolean;
  variant: 'collection' | 'document';
  reduceMotion?: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

// ── 컴포넌트 ──────────────────────────────────────────────────────────────────

export function ColumnItem({
  label,
  meta,
  iconLabel,
  isActive,
  isLoading = false,
  isHighlighted = false,
  isHeavy = false,
  variant,
  reduceMotion = false,
  onSelect,
  onEdit,
  onDelete,
}: ColumnItemProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { hovered, hoverHandlers } = useHover();
  const hasActions = !!(onEdit || onDelete);

  useEffect(() => {
    if (!isHighlighted || !ref.current) return;
    ref.current.animate(
      [{ backgroundColor: '#d1fae5' }, { backgroundColor: 'transparent' }],
      { duration: 700, easing: 'ease-out' },
    );
  }, [isHighlighted]);

  if (isLoading) {
    return <div className="h-[58px] rounded-2xl bg-slate-100/80 animate-pulse" />;
  }

  return (
    <m.div
      ref={ref}
      layout={!reduceMotion}
      className={cn(
        'relative flex items-center gap-3 px-4 py-3.5 rounded-2xl cursor-pointer select-none transition-colors',
        isActive
          ? 'bg-emerald-50/80'
          : 'hover:bg-slate-50/80 active:bg-slate-100/50',
      )}
      {...hoverHandlers}
      onClick={onSelect}
      whileTap={{ scale: 0.99 }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
    >
      {/* 선택 인디케이터 — 왼쪽 작은 도트 (border-l 대신) */}
      <AnimatePresence>
        {isActive && (
          <m.span
            className="absolute left-1.5 -translate-y-1/2 w-1 h-8 rounded-full bg-emerald-500"
            initial={{ scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            exit={{ scaleY: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
          />
        )}
      </AnimatePresence>

      {/* 아이콘 */}
      <span
        className={cn(
          'shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-[11px] font-bold tracking-wide',
          isActive
            ? 'bg-emerald-100 text-emerald-700'
            : variant === 'collection'
              ? 'bg-slate-100 text-slate-600'
              : 'bg-slate-100 text-slate-500',
        )}
      >
        {iconLabel ?? label.slice(0, 2).toUpperCase()}
      </span>

      {/* 텍스트 */}
      <div className="flex-1 min-w-0">
        <p className={cn(
          'text-sm font-medium truncate leading-snug',
          isActive ? 'text-emerald-700 font-semibold' : 'text-slate-700',
        )}>
          {label}
        </p>
        {meta && (
          <p className={cn(
            'flex items-center gap-2 text-xs truncate mt-0.5',
            isActive ? 'text-emerald-500' : 'text-slate-400',
          )}>
            <span className="truncate">{meta}</span>
            {isHeavy && (
              <span title="Large collection — animations disabled" className="shrink-0">
                <Zap size={11} className={isActive ? 'text-emerald-400' : 'text-amber-400'} aria-hidden="true" />
              </span>
            )}
          </p>
        )}
      </div>
      
      <div className="flex items-center gap-1 shrink-0">
        <ChevronRight size={15} className={isActive ? 'text-emerald-400' : 'text-slate-300'} />
        {/* 오른쪽: [액션 버튼 width 0→auto] [chevron] */}
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {hasActions && (
            <AnimatePresence>
              {hovered && (
                <m.div
                  className="flex items-center gap-1 overflow-hidden"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 'auto', opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={SPRING_HOVER}
                >
                  {onEdit && (
                    <button
                      type="button"
                      className="p-1.5 rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                      onClick={onEdit}
                      aria-label={`Edit ${label}`}
                    >
                      <Pencil size={16} />
                    </button>
                  )}
                </m.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </div>
    </m.div>
  );
}

// ── 스켈레톤 목록 ─────────────────────────────────────────────────────────────

export function ColumnSkeletonList({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-1 p-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-[58px] rounded-2xl bg-slate-100/80 animate-pulse" />
      ))}
    </div>
  );
}
