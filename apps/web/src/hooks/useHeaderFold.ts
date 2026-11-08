// 컬럼 머리 오른쪽 버튼 묶음을 '⋯' 메뉴로 접을지 — 왼쪽(아이콘·제목·개수)이 머리 너비의 절반은 늘 갖도록.
// 오른쪽에 필요한 너비(접히는 버튼들의 원래 너비 + 늘 보이는 버튼) > 절반이면 접는다.
// 접힌 동안엔 접히는 버튼이 화면에 없으므로 마지막으로 잰 원래 너비를 쓴다.
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

// 두 묶음 사이 틈(gap-2)
const GAP = 8;
// 경계에서 접혔다 펴졌다 떨지 않게 펼 때는 조금 더 여유가 있어야
const HYSTERESIS = 6;

export function useHeaderFold(
  headerRef: RefObject<HTMLElement | null>,
  foldableRef: RefObject<HTMLElement | null>,
  fixedRef: RefObject<HTMLElement | null>,
): boolean {
  const [folded, setFolded] = useState(false);
  const naturalRef = useRef(0);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const check = () => {
      const foldable = foldableRef.current;
      if (foldable) naturalRef.current = foldable.scrollWidth;
      // 제목 필드 편집 중처럼 머리 모양이 다를 때는 그대로 둔다
      if (!naturalRef.current || !fixedRef.current) return;
      const style = getComputedStyle(header);
      const inner = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const need = naturalRef.current + GAP + fixedRef.current.offsetWidth;
      const half = inner / 2 - GAP;
      setFolded((was) => (was ? need > half - HYSTERESIS : need > half));
    };
    const observer = new ResizeObserver(check);
    observer.observe(header);
    if (foldableRef.current) observer.observe(foldableRef.current);
    check();
    return () => observer.disconnect();
  }, [folded, headerRef, foldableRef, fixedRef]);

  return folded;
}
