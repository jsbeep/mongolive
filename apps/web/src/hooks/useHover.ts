import { useState } from 'react';

// 호버 시 액션 버튼을 드러내는 반복 패턴(ColumnItem, JsonLevelColumn의 FieldItem)에서 공용으로 사용
export function useHover() {
  const [hovered, setHovered] = useState(false);
  return {
    hovered,
    hoverHandlers: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
    },
  };
}
