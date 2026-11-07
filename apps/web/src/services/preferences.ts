// 개인 설정(이 브라우저에만) — 값 표시 방식 등. localStorage 한 키에 JSON으로 둔다.
// 서버 설정(안전장치 등)은 서버 파일에, 보안 설정은 .env에만 있다(설정 창은 읽기만).
// 훅(usePreferences)은 Provider 없이 어디서든 쓸 수 있게 모듈 저장소 + useSyncExternalStore로 만든다.
import { useSyncExternalStore } from 'react';

// Date 표시: local = 이 기기 시간대(오프셋 표시), utc = UTC, iso = 저장된 그대로의 ISO 문자열(…Z)
export type DateDisplay = 'local' | 'utc' | 'iso';
// ObjectId 표시: full = 24자 전부, short = 뒤 8자(생성 시각·전체 값은 툴팁에)
export type OidDisplay = 'full' | 'short';

export interface Preferences {
  dateDisplay: DateDisplay;
  oidDisplay: OidDisplay;
}

const KEY = 'mongolive.preferences';
const DEFAULTS: Preferences = { dateDisplay: 'local', oidDisplay: 'full' };

const load = (): Preferences => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Preferences>;
    return {
      dateDisplay: saved.dateDisplay === 'utc' || saved.dateDisplay === 'iso' || saved.dateDisplay === 'local' ? saved.dateDisplay : DEFAULTS.dateDisplay,
      oidDisplay: saved.oidDisplay === 'short' || saved.oidDisplay === 'full' ? saved.oidDisplay : DEFAULTS.oidDisplay,
    };
  } catch {
    return DEFAULTS;
  }
};

let current = load();
const listeners = new Set<() => void>();

export const getPreferences = (): Preferences => current;

export const setPreference = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // 저장이 막혀 있어도 이번 탭에선 적용된다
  }
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const usePreferences = (): Preferences => useSyncExternalStore(subscribe, getPreferences);
