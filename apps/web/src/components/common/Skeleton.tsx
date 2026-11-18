// 처음 불러오는 동안의 자리 표시 — 모양이 정해진 곳(표·목록·카드)에만 쓴다.
// 진행 중인 작업(Connecting…, Counting…)이나 기다리는 이유를 알려 주는 문장은 글자로 둔다.
import { Loader2 } from 'lucide-react';
import { cn } from '../../utils/cn';

const WIDTHS = ['w-11/12', 'w-3/4', 'w-5/6', 'w-2/3', 'w-4/5'];

export function SkeletonLine({ className }: { className?: string }) {
  return <span className={cn('block h-3 animate-pulse rounded bg-slate-200/70', className)} aria-hidden="true" />;
}

// 줄 여러 개 — 폭을 조금씩 달리해 글처럼 보이게
export function SkeletonRows({ rows = 3, className, label = 'Loading' }: { rows?: number; className?: string; label?: string }) {
  return (
    <div className={cn('flex flex-col gap-2.5 py-3', className)} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonLine key={i} className={WIDTHS[i % WIDTHS.length]} />
      ))}
    </div>
  );
}

// 지난 응답을 보여 주며 새로 받는 중 — 카드 제목 안, 글자 바로 뒤
export function RefreshSpinner({ show }: { show: boolean }) {
  if (!show) return null;
  return <Loader2 size={12} className="ml-1.5 inline-block shrink-0 animate-spin align-[-1px] text-slate-400" aria-label="Refreshing" />;
}
