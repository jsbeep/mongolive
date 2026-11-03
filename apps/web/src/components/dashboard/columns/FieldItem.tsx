// path: src/components/dashboard/columns/FieldItem.tsx
import type { ReactNode } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { ChevronRight, Pencil } from 'lucide-react';
import { cn } from '../../../utils/cn';
import { SPRING_SNAPPY, SPRING_HOVER } from '../../../utils/motionPresets';
import { useHover } from '../../../hooks/useHover';

export interface FieldItemProps {
  fieldKey: string;
  isId: boolean;
  isExpandable: boolean;
  isEditable: boolean;
  isHighlighted: boolean;
  isActive?: boolean;
  reduceMotion?: boolean;
  // 값이 여러 줄로 늘어나는 타입(문자열 등)에서, hover 시 edit 아이콘이 폭을 밀며
  // 값이 줄었다 늘었다 rewrap되는 걸 막는다 — 펜슬 자리를 항상 예약해 값의 기본
  // 너비를 hover 상태와 동일하게 고정하고, 아이콘은 opacity만 토글한다.
  reserveEditWidth?: boolean;
  onEdit: () => void;
  onClick: (() => void) | null;
  children: ReactNode;
}

export function FieldItem({
  fieldKey, isId, isExpandable, isEditable, isHighlighted, isActive = false, reduceMotion = false,
  reserveEditWidth = false,
  onEdit, onClick, children,
}: FieldItemProps) {
  const { hovered, hoverHandlers } = useHover();

  return (
    <m.div
      layout={!reduceMotion}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={SPRING_SNAPPY}
      className={cn(
        'relative flex items-center gap-3 px-4 py-3.5 rounded-2xl',
        onClick ? 'cursor-pointer hover:bg-slate-50/80 active:bg-slate-100/60' : 'cursor-default',
        isActive ? 'bg-emerald-50/70' : isHighlighted ? 'bg-emerald-50/40' : '',
      )}
      {...hoverHandlers}
      onClick={onClick ?? undefined}
    >
      {/* 현재 펼쳐진 경로(다음 컬럼으로 이어지는 필드) 표시용 좌측 인디케이터 */}
      <AnimatePresence>
        {isActive && (
          <m.span
            className="absolute left-1.5 -translate-y-1/2 w-0.5 h-8 rounded-full bg-emerald-500"
            initial={{ scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            exit={{ scaleY: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
          />
        )}
      </AnimatePresence>

      {/* 부모는 items-center지만 key/컨트롤만 self-start로 올려, 값이 여러 줄로
          길어질 때 문자열 첫 줄과 나란히 상단 정렬한다(한 줄일 땐 center와 동일). */}
      <span className={cn(
        'text-[13px] py-1.5 font-mono font-medium shrink-0 w-[20%] truncate self-start',
        isActive ? 'text-emerald-700' : isId ? 'text-slate-400' : 'text-slate-500',
      )}>
        {fieldKey}
      </span>

      <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
        {children}
      </div>

      <div className={cn("flex items-center shrink-0", reserveEditWidth && 'self-start')}>
        {isExpandable && (
          <m.span
            animate={{ x: hovered && isEditable ? 2 : 0 }}
            transition={SPRING_HOVER}
            className="mr-1"
          >
            <ChevronRight size={15} className={isActive ? 'text-emerald-400' : 'text-slate-300'} />
          </m.span>
        )}
        {isEditable && (reserveEditWidth ? (
          // 폭은 항상 예약(값 기본 너비 = hover 시 너비 → reflow 없음)하되, 슬라이드
          // 인은 레이아웃에 영향 없는 x transform으로 재현한다(width 애니메이션과 달리
          // 옆 값을 밀지 않음). 숨김 상태에선 클릭/포커스가 안 잡히게 pointer-events/tabIndex off.
          <m.div
            className="flex items-center"
            animate={{ opacity: hovered ? 1 : 0, x: hovered ? 0 : 16 }}
            transition={SPRING_HOVER}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className={cn(
                'p-1.5 rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors',
                hovered ? '' : 'pointer-events-none',
              )}
              tabIndex={hovered ? 0 : -1}
              onClick={onEdit}
            >
              <Pencil size={16} />
            </button>
          </m.div>
        ) : (
          <AnimatePresence>
            {hovered && (
              <m.div
                className="flex items-center overflow-hidden"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 'auto', opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={SPRING_HOVER}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="p-1.5 rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                  onClick={onEdit}
                >
                  <Pencil size={16} />
                </button>
              </m.div>
            )}
          </AnimatePresence>
        ))}
      </div>
    </m.div>
  );
}
