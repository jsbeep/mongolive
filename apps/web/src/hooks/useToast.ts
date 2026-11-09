// path: src/hooks/useToast.ts
import { useCallback, useRef, useState } from 'react';
import { pushSystemEvent } from '../services/systemLog';

let toastIdCounter = 0;
const nextId = () => String(++toastIdCounter);

export interface ToastMessage {
  id: string;
  message: string;
  type: 'success' | 'error';
  // Undo 버튼 — true면 마지막 편집 되돌리기(explorer의 undo), 함수면 그것(파이프라인에 모은 것 되돌리기 등)
  undoable?: boolean;
  undo?: () => void;
}

export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: ToastMessage['type'], undoable: boolean | (() => void) = false) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    const id = nextId();
    setToast(typeof undoable === 'function' ? { id, message, type, undo: undoable } : { id, message, type, undoable });
    // 에러는 몇 초 뒤 사라져도 알림 센터(System 탭)에 남긴다
    if (type === 'error') pushSystemEvent('error', message);
    toastTimerRef.current = setTimeout(() => setToast(null), type === 'error' ? 3000 : 5000);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(null);
  }, []);

  return { toast, showToast, dismissToast };
}
