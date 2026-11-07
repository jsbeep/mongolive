// 연결 상태 점의 색·이름 — 헤더(새로고침 버튼)와 사이드바 아래쪽이 같이 쓴다
import type { UseExplorerStateResult } from '../../hooks/useExplorerState';

export const CONNECTION_STATUS: Record<UseExplorerStateResult['connectionStatus'], { color: string; label: string }> = {
  disconnected: { color: 'text-slate-400', label: 'Disconnected' },
  connecting: { color: 'text-amber-500', label: 'Connecting' },
  connected: { color: 'text-emerald-500', label: 'Connected' },
  error: { color: 'text-rose-500', label: 'Error' },
};
