// 변경 강조 — 항목 위에 덧씌우는 색 막(내 저장 = 연초록, 밖에서 온 변경 = 하늘색). 왼쪽에서 오른쪽으로 차올랐다가 다시 왼쪽으로 빠진다.
// 항목의 배경(선택=연초록, hover 등)은 건드리지 않으므로 끝나면 원래 배경이 그대로 드러나고, 선택된 행에서
// "연초록 → 강조 → 흰색 → 연초록"처럼 두 번 깜빡이는 일이 없다.
//
// 구조: 액자(둥근 모서리 + overflow-hidden) 안에서 막을 옆으로 민다(translateX).
//   - 막은 늘이지 않고 위치만 옮기므로 찌그러지지 않고, 액자가 행 모양대로 잘라 준다(움직이는 끝은 곧은 선).
//   - transform만 바뀌므로 GPU 합성으로 처리된다(매 프레임 다시 그리지 않음).
//
// 쓰는 쪽 조건: 부모가 `relative isolate`여야 한다.
//   relative — 액자(absolute)가 부모 크기에 맞게 깔린다
//   isolate  — 부모가 쌓임 맥락을 만들어, 액자(-z-10)가 부모 배경 위·글자 아래에 그려진다
//              (없으면 -z-10이 부모 배경보다도 뒤로 가서 안 보이거나, z-auto면 글자를 덮는다)
import { createContext, useContext, useEffect, useRef } from 'react';

// 지금 강조가 누구의 변경인가 — 강조는 한 번에 한 묶음이라 색도 하나다. 페이지가 한 번 넣어 주면
// 아래 모든 항목이 꺼내 쓴다(항목마다 prop으로 내려보내지 않으려고 Context를 쓴다).
export type ChangeTone = 'own' | 'external';
export const ChangeToneContext = createContext<ChangeTone>('external');

const TONE_CLASS: Record<ChangeTone, string> = {
  own: 'bg-emerald-100',
  external: 'bg-sky-100',
};

// 강조가 보이는 시간. useExplorerState의 changedPaths 유지 시간과 맞춘다.
export const CHANGE_FLASH_MS = 2000;

const HIDDEN = 'translateX(-100%)';
const SHOWN = 'translateX(0)';

export function ChangeFlash({ active }: { active: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const tone = useContext(ChangeToneContext);

  useEffect(() => {
    if (!active || !ref.current) return;
    // 차오름(20%) → 머묾 → 왼쪽으로 빠짐
    const animation = ref.current.animate(
      [
        { transform: HIDDEN, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        { transform: SHOWN, offset: 0.2 },
        { transform: SHOWN, offset: 0.6, easing: 'cubic-bezier(0.64, 0, 0.78, 0)' },
        { transform: HIDDEN },
      ],
      { duration: CHANGE_FLASH_MS },
    );
    return () => animation.cancel();
  }, [active]);

  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]">
      <span ref={ref} className={`absolute inset-0 rounded-[inherit] ${TONE_CLASS[tone]}`} style={{ transform: HIDDEN }} />
    </span>
  );
}
