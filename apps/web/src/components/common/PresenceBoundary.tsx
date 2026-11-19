import { useContext, useMemo, type ReactNode } from 'react';
import { PresenceContext } from 'framer-motion';

const noopRegister = () => () => {};

// AnimatePresence 패널 안쪽을 패널의 퇴장과 끊는다 — 패널은 자기 퇴장 애니메이션만 끝나면 지워진다.
//
// 왜 필요한가 — AnimatePresence는 패널 안의 모든 motion 요소(필드 행 등)가 퇴장을 끝내야 패널을 지우고,
// 퇴장 중인 패널이 여럿이면 전부 끝나야 한꺼번에 지운다. 참조 컬럼처럼 열린 뒤에 내용을 받아오는 패널이
// 내용 도착 전에 닫히면, 도착한 뒤 새로 생긴 행이 '아직 안 끝남'으로 등록되고 끝났다는 신호를 영영 못 보낸다
// → 그 패널도, 뒤에 닫힌 패널도 투명한 채 남아 클릭을 막고 쌓인다(LINK 광클로 재현).
// 안쪽 요소의 개별 퇴장 효과는 패널 전체 페이드에 묻혀 보이지 않으니 잃는 것도 없다.
export function PresenceBoundary({ children }: { children: ReactNode }) {
  const parent = useContext(PresenceContext);
  const initial = parent?.initial;
  // 늘 '있음' — 안쪽 요소는 패널이 사라지는지 모른다. initial은 그대로 넘겨 첫 화면 등장 애니메이션 규칙을 유지
  const value = useMemo(
    () => (parent ? { id: parent.id, initial, isPresent: true, custom: undefined, onExitComplete: undefined, register: noopRegister } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parent?.id, initial],
  );
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}
