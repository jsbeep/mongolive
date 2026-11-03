// path: src/hooks/useToast.ts
import { useCallback, useRef, useState } from 'react';

let toastIdCounter = 0;
const nextId = () => String(++toastIdCounter);

export interface ToastMessage {
  id: string;
  message: string;
  type: 'success' | 'error';
  undoable?: boolean;
}

export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: ToastMessage['type'], undoable = false) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    const id = nextId();
    setToast({ id, message, type, undoable });
    toastTimerRef.current = setTimeout(() => setToast(null), type === 'error' ? 3000 : 5000);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(null);
  }, []);

  return { toast, showToast, dismissToast };
}
