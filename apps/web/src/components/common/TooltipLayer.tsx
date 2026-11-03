// path: src/components/common/TooltipLayer.tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// ── 툴팁 레이어 ───────────────────────────────────────────────────────────────
// 앱 전체에 하나만 마운트되는 툴팁. 각 컨트롤은 `data-tt="설명"` 속성만 달면 되고
// (옵션: data-tt-side="top", data-tt-align="left") 여기서 이벤트 위임으로 처리한다.
//
// 왜 CSS ::after가 아니라 portal인가 —
//   ① 컬럼(MillerColumns)이 inline zIndex:99를 쓰는데 그 부모가 stacking context를
//      만들지 않아서, 헤더 안에 그려진 툴팁이 z-index를 올려도 컬럼에 가린다.
//   ② 컬럼은 layout 애니메이션 때문에 transform이 걸린 overflow-hidden 요소라
//      containing block이 된다 — position:fixed로도 클리핑을 못 벗어난다.
// 둘 다 "조상 밖으로 나가야" 풀리는 문제라서 body portal이 유일한 해법이다.

const SHOW_DELAY_MS = 650;
const GAP = 6; // 앵커와 툴팁 사이 간격
const EDGE = 8; // 뷰포트 가장자리 최소 여백

interface TipState {
  text: string;
  anchor: DOMRect;
  side: 'top' | 'bottom';
  align: 'left' | 'right';
}

export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  // 실제 좌표는 툴팁을 한 번 그려서 크기를 재야 정해진다 — 그 전엔 화면 밖에 숨겨둔다.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  // 현재 띄워둔(또는 띄우기로 예약한) 앵커. pointerover는 앵커 안의 자식 위를 지날
  // 때마다 다시 발생하므로, 이게 없으면 같은 버튼 안에서 마우스만 움직여도
  // 타이머와 좌표가 계속 리셋돼 툴팁이 깜빡인다.
  const anchorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const hide = () => {
      clearTimer();
      anchorRef.current = null;
      setTip(null);
      setPos(null);
    };

    const findAnchor = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element ? (node.closest('[data-tt]') as HTMLElement | null) : null;

    const handleOver = (event: PointerEvent) => {
      const anchor = findAnchor(event.target);
      const text = anchor?.dataset.tt;
      if (!anchor || !text) return;
      // 같은 앵커 안에서 자식 사이를 이동한 것뿐이면 그대로 둔다
      if (anchor === anchorRef.current) return;

      clearTimer();
      anchorRef.current = anchor;
      setPos(null);
      timerRef.current = window.setTimeout(() => {
        setTip({
          text,
          anchor: anchor.getBoundingClientRect(),
          side: anchor.dataset.ttSide === 'top' ? 'top' : 'bottom',
          align: anchor.dataset.ttAlign === 'left' ? 'left' : 'right',
        });
      }, SHOW_DELAY_MS);
    };

    const handleOut = (event: PointerEvent) => {
      const anchor = findAnchor(event.target);
      if (!anchor) return;
      // 자식 요소로 이동한 것뿐이면 계속 띄워둔다
      if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;
      hide();
    };

    document.addEventListener('pointerover', handleOver);
    document.addEventListener('pointerout', handleOut);
    document.addEventListener('pointerdown', hide);
    // 캡처 단계로 받아야 컬럼 내부 스크롤까지 잡힌다 (스크롤되면 앵커 좌표가 무효)
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);

    return () => {
      clearTimer();
      document.removeEventListener('pointerover', handleOver);
      document.removeEventListener('pointerout', handleOut);
      document.removeEventListener('pointerdown', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!tip || !el) return;

    const { width, height } = el.getBoundingClientRect();
    const { anchor } = tip;

    const preferredLeft = tip.align === 'left' ? anchor.left : anchor.right - width;
    const left = Math.min(Math.max(preferredLeft, EDGE), window.innerWidth - width - EDGE);

    const below = anchor.bottom + GAP;
    const above = anchor.top - height - GAP;
    let top = tip.side === 'top' ? above : below;
    // 선호 방향에 공간이 없으면 반대쪽으로 뒤집는다
    if (top + height > window.innerHeight - EDGE) top = above;
    if (top < EDGE) top = below;

    setPos({ left, top });
  }, [tip]);

  if (!tip) return null;

  return createPortal(
    <div
      ref={tipRef}
      role="tooltip"
      className="fixed z-[900] max-w-[216px] rounded-lg bg-slate-900 px-2 py-1.5 text-[11px] font-medium leading-snug text-slate-50 shadow-elevated pointer-events-none transition-opacity duration-100"
      style={{
        // 좌표를 재기 전(pos === null)엔 화면 밖에 둔다 — opacity만 0으로 두면
        // 전환 중인 프레임이 (0,0)에 잠깐 보인다.
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        opacity: pos ? 1 : 0,
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
