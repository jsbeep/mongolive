// 개인 설정(이 브라우저에만) — 값 표시 방식 등. localStorage 한 키에 JSON으로 둔다.
// 서버 설정(안전장치 등)은 서버 파일에, 보안 설정은 .env에만 있다(설정 창은 읽기만).
// 훅(usePreferences)은 Provider 없이 어디서든 쓸 수 있게 모듈 저장소 + useSyncExternalStore로 만든다.
import { useSyncExternalStore } from 'react';

// Date 표시: local = 이 기기 시간대(오프셋 표시), utc = UTC, iso = 저장된 그대로의 ISO 문자열(…Z)
export type DateDisplay = 'local' | 'utc' | 'iso';
// ObjectId 표시: full = 24자 전부, short = 뒤 8자(생성 시각·전체 값은 툴팁에)
export type OidDisplay = 'full' | 'short';
// 삭제 확인 강도 — DB·컬렉션(되돌릴 수 없고 큼) / 문서·필드
export type DeleteConfirmLarge = 'type' | 'confirm';
export type DeleteConfirmSmall = 'confirm' | 'none';
// 되돌리기 몇 단계까지 기억할지
export const UNDO_DEPTHS = [1, 10, 30] as const;
export type UndoDepth = (typeof UNDO_DEPTHS)[number];
// 실시간 반영 간격: 즉시(변경을 0.15초 단위로 묶음) / 느슨하게(1.5초 단위 — 변경이 몰릴 때 화면·요청이 덜 바쁘다)
export type LiveBatch = 'immediate' | 'relaxed';
export const LIVE_BATCH_MS: Record<LiveBatch, number> = { immediate: 150, relaxed: 1500 };

export interface Preferences {
  dateDisplay: DateDisplay;
  // 밀리초까지 보일지(기본 끔). 보이기만의 문제 — 꺼도 툴팁엔 밀리초가 나오고, 저장 값의 밀리초는 그대로 지킨다
  showMs: boolean;
  oidDisplay: OidDisplay;
  // DB·컬렉션 삭제: 이름을 직접 쳐야 하는지(기본) / 확인 버튼만
  deleteConfirmLarge: DeleteConfirmLarge;
  // 문서·필드 삭제: 확인 버튼(기본) / 확인 없이 바로(되돌리기 토스트는 그대로 뜬다)
  deleteConfirmSmall: DeleteConfirmSmall;
  undoDepth: UndoDepth;
  liveBatch: LiveBatch;
}

const KEY = 'mongolive.preferences';
const DEFAULTS: Preferences = { dateDisplay: 'local', showMs: false, oidDisplay: 'full', deleteConfirmLarge: 'type', deleteConfirmSmall: 'confirm', undoDepth: 10, liveBatch: 'immediate' };

const load = (): Preferences => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Preferences>;
    return {
      dateDisplay: saved.dateDisplay === 'utc' || saved.dateDisplay === 'iso' || saved.dateDisplay === 'local' ? saved.dateDisplay : DEFAULTS.dateDisplay,
      showMs: typeof saved.showMs === 'boolean' ? saved.showMs : DEFAULTS.showMs,
      oidDisplay: saved.oidDisplay === 'short' || saved.oidDisplay === 'full' ? saved.oidDisplay : DEFAULTS.oidDisplay,
      deleteConfirmLarge: saved.deleteConfirmLarge === 'confirm' || saved.deleteConfirmLarge === 'type' ? saved.deleteConfirmLarge : DEFAULTS.deleteConfirmLarge,
      deleteConfirmSmall: saved.deleteConfirmSmall === 'none' || saved.deleteConfirmSmall === 'confirm' ? saved.deleteConfirmSmall : DEFAULTS.deleteConfirmSmall,
      undoDepth: (UNDO_DEPTHS as readonly number[]).includes(saved.undoDepth as number) ? (saved.undoDepth as UndoDepth) : DEFAULTS.undoDepth,
      liveBatch: saved.liveBatch === 'relaxed' || saved.liveBatch === 'immediate' ? saved.liveBatch : DEFAULTS.liveBatch,
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
