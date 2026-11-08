// 순서 바꾸기(배열 원소·객체 키)의 한 행 — framer-motion Reorder.Item + 손잡이.
// 행 전체가 아니라 손잡이로만 끈다(dragListener=false): 행을 누르면 펼치기, 손잡이를 누르면 끌기.
// 포인터 이벤트 기반이라 컬럼에 걸린 파일 드롭(HTML 드래그)과 섞이지 않는다.
import type { ReactNode } from 'react';
import { Reorder, useDragControls } from 'framer-motion';
import { GripVertical } from 'lucide-react';

interface ReorderRowProps {
  value: string;
  // 손잡이 없는 행(문서 맨 앞의 _id)
  locked?: boolean;
  // 손잡이를 누른 순간 — 초안을 시작한다
  onGrab: (key: string, el: HTMLElement) => void;
  // 손잡이를 받아 행을 그린다(FieldItem의 leading 자리에 넣는다)
  children: (grip: ReactNode) => ReactNode;
}

export function ReorderRow({ value, locked = false, onGrab, children }: ReorderRowProps) {
  const controls = useDragControls();
  const grip = locked ? null : (
    <span
      role="button"
      aria-label="Drag to reorder"
      data-tt="Drag to reorder"
      className="flex h-7 w-4 cursor-grab touch-none items-center justify-center rounded text-slate-400 hover:text-slate-600 active:cursor-grabbing"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onGrab(value, e.currentTarget);
        controls.start(e);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <GripVertical size={14} />
    </span>
  );
  return (
    <Reorder.Item as="div" value={value} dragListener={false} dragControls={controls} className="relative">
      {children(grip)}
    </Reorder.Item>
  );
}
