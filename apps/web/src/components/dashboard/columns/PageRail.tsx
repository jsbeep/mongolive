// 컬럼 오른쪽(스크롤바 옆)에 세로로 붙는 페이지 이동 레일.
// 목록을 어디까지 스크롤했든 항상 보이므로 맨 아래까지 내리지 않고도 페이지를 바꿀 수 있다.
// 페이지가 1개뿐이면 그리지 않는다.
import { useId, useRef, type ReactNode } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../../../utils/cn';

interface PageRailProps {
  // 0부터 시작
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  // 현재 경로(선택된 문서/펼쳐진 필드)가 들어 있는 페이지 — 연한 초록으로 표시
  markedPage?: number;
  // 문서 목록처럼 서버 응답을 기다리는 중이면 살짝 흐리게
  isBusy?: boolean;
  className?: string;
}

type Slot = number | 'gap-start' | 'gap-end';

// 항상 7칸(페이지가 7개 이하면 그 수만큼) — 페이지를 넘겨도 레일 높이·버튼 위치가 흔들리지 않는다
const SLOTS = 7;
const pageSlots = (page: number, count: number): Slot[] => {
  if (count <= SLOTS) return Array.from({ length: count }, (_, i) => i);
  const last = count - 1;
  if (page <= 3) return [0, 1, 2, 3, 4, 'gap-end', last];
  if (page >= last - 3) return [0, 'gap-start', last - 4, last - 3, last - 2, last - 1, last];
  return [0, 'gap-start', page - 1, page, page + 1, 'gap-end', last];
};

const styles = {
  rail: 'shrink-0 w-8 flex flex-col items-center gap-0.5 py-2 border-l border-slate-100/80 select-none',
  arrow:
    'w-6 h-6 flex items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors disabled:opacity-25 disabled:pointer-events-none',
  page: 'relative w-6 h-6 flex items-center justify-center rounded-lg text-[11px] font-mono tabular-nums transition-colors',
  pageIdle: 'text-slate-400 hover:bg-slate-100 hover:text-slate-700',
  pageMarked: 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100',
  pageActiveMarked: 'text-emerald-700 font-semibold',
  pageActive: 'text-slate-700 font-semibold',
  activeBg: 'absolute inset-0 rounded-lg bg-slate-100',
  // 색은 둘 중 하나만 붙인다 — cn은 클래스를 이어 붙이기만 해서 같은 속성(text-색)이 둘이면
  // CSS 파일 안의 순서로 승자가 정해진다(코드에 쓴 순서가 아님)
  gap: 'w-6 h-3 flex items-center justify-center text-[10px] leading-none',
  gapIdle: 'text-slate-300',
  gapMarked: 'text-emerald-500 font-bold',
} as const;

export function PageRail({ page, pageCount, onChange, markedPage, isBusy, className }: PageRailProps) {
  // 같은 화면에 레일이 여러 개(문서 목록 + 필드 목록들) 있어도 활성 표시 애니메이션이 섞이지 않게
  const layoutId = `page-rail-active-${useId()}`;
  if (pageCount <= 1) return null;

  const go = (next: number) => {
    const clamped = Math.min(Math.max(0, next), pageCount - 1);
    if (clamped !== page) onChange(clamped);
  };

  const slots = pageSlots(page, pageCount);
  const pageClass = (slot: number) => {
    const marked = slot === markedPage;
    if (slot === page) return marked ? styles.pageActiveMarked : styles.pageActive;
    return marked ? styles.pageMarked : styles.pageIdle;
  };
  // ⋮ 안에 숨은 페이지가 표시 대상이면 ⋮을 초록으로 — 양옆 숫자 사이에 있는지로 판단
  const gapHidesMarked = (index: number) => {
    if (markedPage === undefined) return false;
    const before = slots[index - 1];
    const after = slots[index + 1];
    return typeof before === 'number' && typeof after === 'number' && markedPage > before && markedPage < after;
  };

  return (
    <nav className={cn(styles.rail, isBusy && 'opacity-60', className)} aria-label="Pages">
      <button type="button" className={styles.arrow} disabled={page === 0} onClick={() => go(page - 1)} data-tt="Previous page">
        <ChevronUp size={14} />
      </button>

      {slots.map((slot, index) =>
        typeof slot === 'number' ? (
          <button
            key={slot}
            type="button"
            className={cn(styles.page, pageClass(slot))}
            aria-current={slot === page ? 'page' : undefined}
            onClick={() => go(slot)}
            data-tt={`Page ${slot + 1} of ${pageCount}`}
          >
            {slot === page && <m.span layoutId={layoutId} className={styles.activeBg} transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
            <span className="relative">{slot + 1}</span>
          </button>
        ) : (
          <span key={slot} className={cn(styles.gap, gapHidesMarked(index) ? styles.gapMarked : styles.gapIdle)} aria-hidden="true">⋮</span>
        ),
      )}

      <button type="button" className={styles.arrow} disabled={page === pageCount - 1} onClick={() => go(page + 1)} data-tt="Next page">
        <ChevronDown size={14} />
      </button>
    </nav>
  );
}

// 페이지가 바뀔 때 현재 목록을 접고(축소) 새 페이지를 펼친다(확장).
// mode="wait" — 접히는 게 끝난 뒤에 펼쳐지므로 두 페이지가 겹쳐 보이지 않는다.
// overflow는 애니메이션 중에만 숨기고 끝나면 직접 되돌린다 — height:'auto'로 가는 애니메이션에선
// transitionEnd가 적용되지 않아 hidden이 남았다. hidden인 채면 항목의 그림자·포커스 링이 잘리고,
// flex 안에서 줄어들 수 있게 돼(최소 높이 0) 목록이 스크롤되지 않고 컬럼 높이에 맞춰 잘렸다(shrink-0도 그래서)
const PAGE_TRANSITION = { duration: 0.16, ease: [0.4, 0, 0.2, 1] as const };

interface PageTransitionProps {
  pageKey: number;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}

export function PageTransition({ pageKey, className, disabled, children }: PageTransitionProps) {
  // 애니메이션을 꺼도 페이지가 바뀌면 목록을 새로 그린다(key) — 안쪽 AnimatePresence(initial={false})가
  // 새로 시작되므로 행마다 따로 사라졌다 나타나지 않고, 문서 컬럼처럼 한 번에 바뀐다
  if (disabled) return <div key={pageKey} className={cn('shrink-0', className)}>{children}</div>;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <PageBody key={pageKey} className={className}>
        {children}
      </PageBody>
    </AnimatePresence>
  );
}

function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <m.div
      ref={ref}
      className={cn('shrink-0', className)}
      initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
      transition={PAGE_TRANSITION}
      onAnimationComplete={() => {
        if (ref.current) ref.current.style.overflow = 'visible';
      }}
    >
      {children}
    </m.div>
  );
}
