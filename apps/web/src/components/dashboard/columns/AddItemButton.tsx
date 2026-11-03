import { m } from 'framer-motion';
import { Plus } from 'lucide-react';
import { SPRING_SNAPPY } from '../../../utils/motionPresets';

// Collections/Documents/JsonLevelColumn에 반복되던 "추가" 카드 버튼.
// 호출부마다 className이 미세하게 다를 수 있어 전부 props로 받는다.
interface AddItemButtonProps {
  label: string;
  onClick: () => void;
  buttonClassName: string;
  iconClassName: string;
  textClassName: string;
  reduceMotion?: boolean;
}

export function AddItemButton({
  label,
  onClick,
  buttonClassName,
  iconClassName,
  textClassName,
  reduceMotion = false,
}: AddItemButtonProps) {
  return (
    <m.button
      type="button"
      layout={!reduceMotion}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={reduceMotion ? undefined : SPRING_SNAPPY}
      className={buttonClassName}
      onClick={onClick}
    >
      <span className={iconClassName}>
        <Plus size={16} />
      </span>
      <span className={textClassName}>{label}</span>
    </m.button>
  );
}
