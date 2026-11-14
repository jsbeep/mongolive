// 연결 색 → 클래스. tailwind는 코드에 그대로 적힌 클래스 이름만 CSS로 만들므로 조합하지 않고 다 적어 둔다.
// 팔레트는 tailwind.config의 CSS 변수라 다크 테마에서도 알아서 바뀐다.
import type { ConnectionColor } from '../../types/explorer';

interface ColorClasses {
  // 카드 왼쪽 띠, 색 고르기 동그라미
  bar: string;
  // 작은 점(상태 바, 목록)
  dot: string;
  // 옅은 배경 + 진한 글자(배지)
  soft: string;
  // 고른 색 동그라미의 테두리
  ring: string;
}

export const CONNECTION_COLOR_CLASSES: Record<ConnectionColor, ColorClasses> = {
  red: { bar: 'bg-red-400', dot: 'text-red-400', soft: 'bg-red-50 text-red-700', ring: 'ring-red-400' },
  orange: { bar: 'bg-orange-400', dot: 'text-orange-400', soft: 'bg-orange-50 text-orange-700', ring: 'ring-orange-400' },
  amber: { bar: 'bg-amber-400', dot: 'text-amber-400', soft: 'bg-amber-50 text-amber-700', ring: 'ring-amber-400' },
  emerald: { bar: 'bg-emerald-400', dot: 'text-emerald-400', soft: 'bg-emerald-50 text-emerald-700', ring: 'ring-emerald-400' },
  teal: { bar: 'bg-teal-400', dot: 'text-teal-400', soft: 'bg-teal-50 text-teal-700', ring: 'ring-teal-400' },
  sky: { bar: 'bg-sky-400', dot: 'text-sky-400', soft: 'bg-sky-50 text-sky-700', ring: 'ring-sky-400' },
  violet: { bar: 'bg-violet-400', dot: 'text-violet-400', soft: 'bg-violet-50 text-violet-700', ring: 'ring-violet-400' },
  rose: { bar: 'bg-rose-400', dot: 'text-rose-400', soft: 'bg-rose-50 text-rose-700', ring: 'ring-rose-400' },
};

// 색이 없는 연결
export const NO_COLOR: ColorClasses = { bar: 'bg-slate-200', dot: 'text-slate-300', soft: 'bg-slate-100 text-slate-600', ring: 'ring-slate-300' };

export const colorClasses = (color: ConnectionColor | null): ColorClasses => (color ? CONNECTION_COLOR_CLASSES[color] : NO_COLOR);
