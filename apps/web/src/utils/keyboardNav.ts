// 밀러 컬럼 키보드 탐색의 등록부.
//   컬럼: 바깥 칸에 data-nav-col="경로 번호"(컬렉션 0, 문서 1, 필드 2…) — 화면 배치가 아니라 경로 순서라
//         Tree 모드처럼 컬럼이 다른 컬럼 안에 들어가 있어도 ← → 순서가 같다
//   행:   data-nav-row + 열기/편집/삭제 동작을 여기 등록(useNavRow). 지금 펼쳐진 행은 data-nav-active
// 키 처리는 한 곳(hooks/useMillerKeyboard)에서 이 표시들만 보고 한다 — 컬럼마다 키 처리를 넣지 않는다.
import { useCallback, useRef } from 'react';

export interface NavActions {
  // Enter / → : 다음 컬럼으로 펼치기(없으면 Enter는 편집)
  open?: () => void;
  // e / F2
  edit?: () => void;
  // Delete
  remove?: () => void;
}

// 요소 → 그 행의 '지금' 동작(렌더마다 바뀌는 콜백을 따라가도록 함수로 둔다)
const registry = new WeakMap<Element, () => NavActions>();

export const navActionsOf = (el: Element): NavActions => registry.get(el)?.() ?? {};

// 행 바깥 요소에 ref로 붙인다. data-nav-row 속성은 따로 붙인다(<m.div data-nav-row ref={navRef}>)
export const useNavRow = (actions: NavActions) => {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  return useCallback((el: HTMLElement | null) => {
    if (el) registry.set(el, () => actionsRef.current);
  }, []);
};
