// 왼쪽 사이드바 상태 — 세 단계: 완전 접힘(collapsed) / 아이콘 레일(rail) / 전체(full).
//   넓은 화면  — 셋 다 컬럼 옆에 붙는다(컬럼을 밀어냄). 고른 단계와 전체 너비는 브라우저에 기억한다.
//   좁은 화면  — 붙는 건 접힘/레일까지. '전체'는 컬럼 위에 떠서 열리고(overlay) 닫으면 레일로 돌아간다. 기억하지 않는다.
// 가장자리를 끌면 너비에 따라 단계가 바뀐다(snapMode) — 끄는 동안에도 중간 너비 대신 그 단계 모양을 보여 준다.
import { useCallback, useEffect, useState } from 'react';

export type SidebarMode = 'collapsed' | 'rail' | 'full';

export const RAIL_WIDTH = 52;
export const FULL_MIN = 240;
export const FULL_MAX = 520;
export const FULL_DEFAULT = 300;
// 끌어서 놓은 너비 → 단계. 이보다 좁으면 접힘 / 레일
const COLLAPSE_BELOW = 28;
const RAIL_BELOW = 170;

const MODE_KEY = 'mongolive.sidebar.mode';
// 접기 전 단계 — 당김 핸들로 다시 펼칠 때 돌아갈 곳
const RESTORE_KEY = 'mongolive.sidebar.restore';
const WIDTH_KEY = 'mongolive.sidebar.width';
const OVERLAY_QUERY = '(max-width: 1023px)';

export const clampFullWidth = (w: number) => Math.min(FULL_MAX, Math.max(FULL_MIN, Math.round(w)));
export const snapMode = (raw: number): SidebarMode => (raw < COLLAPSE_BELOW ? 'collapsed' : raw < RAIL_BELOW ? 'rail' : 'full');

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장이 막혀 있어도 동작은 한다(새로고침하면 잊을 뿐)
  }
};
const isMode = (v: string | null): v is SidebarMode => v === 'collapsed' || v === 'rail' || v === 'full';

export interface SidebarState {
  mode: SidebarMode;
  // 좁은 화면이라 '전체'를 컬럼 위에 띄우는 중인가
  isOverlay: boolean;
  // 전체 단계의 너비
  width: number;
  setMode: (mode: SidebarMode) => void;
  // 접힘 → 접기 전 단계로
  restore: () => void;
  // 끌기를 놓을 때: 그 너비로 단계·너비를 정한다
  commitDrag: (raw: number) => void;
  // 키보드(←/→)·더블클릭용
  commitWidth: (w: number) => void;
}

export function useSidebar(): SidebarState {
  const [isOverlay, setIsOverlay] = useState(() => window.matchMedia(OVERLAY_QUERY).matches);
  const [wideMode, setWideMode] = useState<SidebarMode>(() => {
    const saved = read(MODE_KEY);
    return isMode(saved) ? saved : 'full';
  });
  const [narrowMode, setNarrowMode] = useState<SidebarMode>(() => (read(MODE_KEY) === 'collapsed' ? 'collapsed' : 'rail'));
  const [restoreMode, setRestoreMode] = useState<Exclude<SidebarMode, 'collapsed'>>(() => (read(RESTORE_KEY) === 'rail' ? 'rail' : 'full'));
  const [width, setWidth] = useState(() => {
    const saved = Number(read(WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampFullWidth(saved) : FULL_DEFAULT;
  });

  useEffect(() => {
    const query = window.matchMedia(OVERLAY_QUERY);
    const onChange = () => {
      setIsOverlay(query.matches);
      // 좁아질 때 떠 있던 '전체'는 레일로
      setNarrowMode((m) => (m === 'full' ? 'rail' : m));
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const mode = isOverlay ? narrowMode : wideMode;

  const setMode = useCallback((next: SidebarMode) => {
    if (next !== 'collapsed') {
      setRestoreMode(next);
      write(RESTORE_KEY, next);
    }
    if (isOverlay) {
      setNarrowMode(next);
    } else {
      setWideMode(next);
      write(MODE_KEY, next);
    }
  }, [isOverlay]);

  const restore = useCallback(() => setMode(restoreMode), [setMode, restoreMode]);

  const commitWidth = useCallback((w: number) => {
    const next = clampFullWidth(w);
    setWidth(next);
    write(WIDTH_KEY, String(next));
  }, []);

  const commitDrag = useCallback((raw: number) => {
    const next = snapMode(raw);
    if (next === 'full') commitWidth(raw);
    setMode(next);
  }, [commitWidth, setMode]);

  return { mode, isOverlay, width, setMode, restore, commitDrag, commitWidth };
}
