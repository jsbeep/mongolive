// 컬럼 머리의 제목 + 개수 — "Comments · 31", 거르는 중이면 "Comments · 29 of 31".
// (예전엔 아이콘 모서리에 숫자를 겹쳤는데, 29/31처럼 길어지면 아이콘을 가리고 읽기 어려웠다)
import { cn } from '../../../utils/cn';

interface HeaderTitleProps {
  title: string;
  total: number;
  // 거른 뒤 개수 — 거르는 중일 때만
  matched?: number;
  titleClassName?: string;
}

export function HeaderTitle({ title, total, matched, titleClassName }: HeaderTitleProps) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span className={cn('min-w-0 truncate text-sm font-semibold text-slate-700', titleClassName)} title={title}>
        {title}
      </span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400">
        · {matched !== undefined ? `${matched} of ${total}` : total}
      </span>
    </span>
  );
}

// 필터가 켜져 있음을 알리는 점 — 버튼 모서리 바깥에 흰 테두리로(버튼 안에 들어가 아이콘과 겹치지 않게)
export const FILTER_DOT_CLASS = 'absolute -top-1 -right-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white';
