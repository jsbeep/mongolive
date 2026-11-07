// 토스트 — VSCode 알림처럼 오른쪽 아래, 상태바 위에 뜬다. 알림 센터가 열려 있으면 그 위로 올라간다.
// 에러 토스트는 사라져도 알림 센터 System 탭에 남는다(useToast → systemLog).
import { AnimatePresence, m } from 'framer-motion';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import type { ToastMessage } from '../../hooks/useToast';
import { SPRING_SOFT } from '../../utils/motionPresets';
import { CENTER_BOTTOM, CENTER_HEIGHT } from './NotificationCenter';

interface ToastProps {
  toast: ToastMessage | null;
  // 알림 센터가 열려 있나 — 열려 있으면 그 위로
  raised: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}

const styles = {
  positioner: 'pointer-events-none fixed right-3 z-[101] flex w-[360px] max-w-[calc(100vw-1.5rem)] flex-col items-end',
  card: 'pointer-events-auto flex w-full items-start gap-2.5 rounded-lg bg-white px-3 py-2.5 shadow-elevated ring-1 ring-slate-200/80',
  message: 'min-w-0 flex-1 break-words pt-px text-[13px] leading-snug text-slate-700',
  undo: 'shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold text-emerald-600 transition-colors hover:bg-emerald-50',
  close: 'shrink-0 rounded-md p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600',
} as const;

export function Toast({ toast, raised, onUndo, onDismiss }: ToastProps) {
  return (
    <div
      className={styles.positioner}
      style={{ bottom: raised ? `calc(${CENTER_BOTTOM}px + ${CENTER_HEIGHT} + 8px)` : CENTER_BOTTOM }}
      aria-live="assertive"
    >
      <AnimatePresence>
        {toast && (
          <m.div
            key={toast.id}
            className={styles.card}
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={SPRING_SOFT}
            role={toast.type === 'error' ? 'alert' : 'status'}
            // 알림 센터가 열려 있을 때 Undo를 눌러도 센터가 닫히지 않게
            data-keeps-notifications
          >
            {toast.type === 'error'
              ? <CircleAlert size={16} className="mt-px shrink-0 text-rose-500" />
              : <CircleCheck size={16} className="mt-px shrink-0 text-emerald-500" />}
            <span className={styles.message}>{toast.message}</span>
            {toast.undoable && (
              <button type="button" className={styles.undo} onClick={onUndo}>
                Undo
              </button>
            )}
            <button type="button" className={styles.close} onClick={onDismiss} aria-label="Dismiss">
              <X size={14} />
            </button>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
