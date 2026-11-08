// 문서 컬럼의 찾기 패널(위: 글자 필터·정렬, 아래: 쿼리)이 열려 있나 + 어느 입력칸으로 커서를 보낼까.
// 컬럼 머리 버튼·breadcrumb의 쿼리 칩·단축키(/, q)가 같이 쓴다(서로 다른 곳에 있어서 모듈 저장소로).
import { useSyncExternalStore } from 'react';

export type SearchPanelFocus = 'filter' | 'query';

export interface SearchPanelState {
  open: boolean;
  focus: SearchPanelFocus;
  // 열 때마다 1씩 — 이미 열려 있어도 다시 커서를 보내라는 신호
  seq: number;
}

let state: SearchPanelState = { open: false, focus: 'filter', seq: 0 };
const listeners = new Set<() => void>();

const set = (next: SearchPanelState) => {
  state = next;
  listeners.forEach((listener) => listener());
};

export const openSearchPanel = (focus: SearchPanelFocus) => set({ open: true, focus, seq: state.seq + 1 });

export const closeSearchPanel = () => {
  if (state.open) set({ ...state, open: false });
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useSearchPanel = (): SearchPanelState => useSyncExternalStore(subscribe, () => state);
