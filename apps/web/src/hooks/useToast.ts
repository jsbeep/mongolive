// path: src/hooks/useToast.ts
import { useCallback, useRef, useState } from 'react';
import { pushSystemEvent } from '../services/systemLog';

let toastIdCounter = 0;
const nextId = () => String(++toastIdCounter);

// 토스트의 버튼 하나 — 알림의 'Show'(Monitor에서 보기) 등
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastMessage {
  id: string;
  message: string;
  // warning = Monitor 알림(9-8a) — 알림 센터 System 탭엔 부른 쪽이 직접 남긴다
  type: 'success' | 'error' | 'warning';
  // Undo 버튼 — true면 마지막 편집 되돌리기(explorer의 undo), 함수면 그것(파이프라인에 모은 것 되돌리기 등)
  undoable?: boolean;
  undo?: () => void;
  action?: ToastAction;
}

export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: ToastMessage['type'], undoable: boolean | (() => void) = false, action?: ToastAction) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    const id = nextId();
    const base = { id, message, type, ...(action ? { action } : {}) };
    setToast(typeof undoable === 'function' ? { ...base, undo: undoable } : { ...base, undoable });
    // 에러는 몇 초 뒤 사라져도 알림 센터(System 탭)에 남긴다
    if (type === 'error') pushSystemEvent('error', message);
    toastTimerRef.current = setTimeout(() => setToast(null), type === 'error' ? 3000 : type === 'warning' ? 8000 : 5000);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(null);
  }, []);

  return { toast, showToast, dismissToast };
}
