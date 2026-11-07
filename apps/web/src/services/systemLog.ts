// 시스템 기록 — 알림 센터의 System 탭에 쌓이는 것들: 에러 토스트, 실시간 연결이 끊김/복구된 시점.
// 브라우저 메모리에만 둔다(새로고침하면 비워짐). 변경 기록(useActivityLog)과 달리 서버에 원본이 없다 —
// 연결이 끊긴 동안엔 서버가 아무것도 보낼 수 없으니, 브라우저가 직접 보고 적는다.
// 토스트(useToast)는 훅이라 아무 데서나 부를 수 없어서, 모듈 하나에 모아 두고 구독하게 한다.

export type SystemLevel = 'error' | 'warning' | 'success' | 'info';

export interface SystemEntry {
  id: number;
  at: number;
  level: SystemLevel;
  message: string;
}

const MAX_ENTRIES = 200;
let entries: SystemEntry[] = [];
let nextId = 1;
const listeners = new Set<(entries: SystemEntry[]) => void>();

const emit = () => listeners.forEach((listener) => listener(entries));

export const pushSystemEvent = (level: SystemLevel, message: string) => {
  // 최신이 앞
  entries = [{ id: nextId++, at: Date.now(), level, message }, ...entries].slice(0, MAX_ENTRIES);
  emit();
};

export const clearSystemEvents = () => {
  entries = [];
  emit();
};

export const subscribeSystemEvents = (listener: (entries: SystemEntry[]) => void) => {
  listeners.add(listener);
  listener(entries);
  return () => {
    listeners.delete(listener);
  };
};
