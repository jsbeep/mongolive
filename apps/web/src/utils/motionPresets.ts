// 컴포넌트마다 동일한 값으로 반복되던 Framer Motion spring transition 프리셋
export const SPRING_SNAPPY = { type: 'spring' as const, stiffness: 400, damping: 35 };
export const SPRING_HOVER = { type: 'spring' as const, stiffness: 400, damping: 30 };
export const SPRING_SOFT = { type: 'spring' as const, stiffness: 300, damping: 28 };
export const SPRING_SHARP = { type: 'spring' as const, stiffness: 600, damping: 28 };

// 컬렉션 용량이 이 값(MB)을 넘으면 layout 애니메이션 비용을 줄이기 위해 애니메이션을 끈다
export const ANIMATION_DISABLE_THRESHOLD_MB = 0.5;
