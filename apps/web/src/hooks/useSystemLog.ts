// 시스템 기록(services/systemLog) 구독 + 실시간 연결 상태 변화를 기록에 적는다.
// 앱 전체에서 한 번만 쓴다(page.tsx). 안 본 기록이 있으면 상태바 종에 점 — 가장 심각한 수준의 색(빨강 > 주황 > 초록).
// info는 세지 않는다(파랑은 Changes의 색).

export interface UnseenSystem {
  error: number;
  warning: number;
  success: number;
}
export type SystemTone = keyof UnseenSystem;
export const SYSTEM_TONE_BG: Record<SystemTone, string> = { error: 'bg-rose-500', warning: 'bg-amber-500', success: 'bg-emerald-500' };
// 가장 심각한 수준 — 없으면 null
export const systemToneOf = (unseen: UnseenSystem): SystemTone | null =>
  unseen.error > 0 ? 'error' : unseen.warning > 0 ? 'warning' : unseen.success > 0 ? 'success' : null;
export const unseenTotal = (unseen: UnseenSystem): number => unseen.error + unseen.warning + unseen.success;
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveStatus } from '../types/explorer';
import { api, dataSourceKind } from '../services/api';
import { getPreferences } from '../services/preferences';
import { clearSystemEvents, pushSystemEvent, subscribeSystemEvents, type SystemEntry } from '../services/systemLog';

export interface SystemLog {
  entries: SystemEntry[];
  // System 탭을 마지막으로 본 뒤 생긴 기록 수(수준별)
  unseen: UnseenSystem;
  markSeen: () => void;
  clear: () => void;
}

export function useSystemLog(): SystemLog {
  const [entries, setEntries] = useState<SystemEntry[]>([]);
  const [seenAt, setSeenAt] = useState(0);

  useEffect(() => subscribeSystemEvents(setEntries), []);

  // 연결 상태가 '바뀔 때만' 적는다 — socket.io는 다시 붙으려 할 때마다 connect_error를 내서
  // 같은 상태가 몇 초마다 반복해 오기 때문
  const lastRef = useRef<{ state: LiveStatus['state']; error?: string } | null>(null);
  useEffect(() => {
    if (dataSourceKind !== 'remote') return;
    return api.onLiveStatus((status) => {
      const last = lastRef.current;
      if (last && last.state === status.state && last.error === status.error) return;
      lastRef.current = { state: status.state, error: status.error };
      // 처음 연결은 늘 있는 일 — 기록엔 남기되 종에 점을 켜지 않는다(새로고침할 때마다 초록 점이 뜨지 않게)
      const routine = () => setSeenAt((seen) => Math.max(seen, Date.now()));
      if (status.state === 'running') {
        pushSystemEvent('success', last ? 'Reconnected — live updates are back' : 'Connected — live updates on');
        if (!last) routine();
      } else if (status.state === 'polling') {
        // 단독 DB — 에러가 아니다(빨간 점 없이). 끊겼다 돌아온 거면 '다시 연결됨'
        const pace = getPreferences().standaloneRefresh;
        const how = pace === 'off' ? 'auto-refresh is off, press R to refresh' : `refreshing every ${pace} (R to refresh now)`;
        if (last && last.state !== 'polling') pushSystemEvent('success', `Reconnected — not a replica set, ${how}`);
        else pushSystemEvent('info', `Connected — not a replica set, so no live updates; ${how}`);
      } else if (status.state === 'connecting') {
        if (last) pushSystemEvent('warning', 'Connection lost — reconnecting…');
      } else {
        pushSystemEvent('error', `Live updates unavailable${status.error ? `: ${status.error}` : ''}`);
      }
    });
  }, []);

  const unseen = useMemo(() => {
    const counts: UnseenSystem = { error: 0, warning: 0, success: 0 };
    for (const e of entries) if (e.at > seenAt && e.level !== 'info') counts[e.level] += 1;
    return counts;
  }, [entries, seenAt]);
  const markSeen = useCallback(() => setSeenAt(Date.now()), []);
  const clear = useCallback(() => clearSystemEvents(), []);

  return { entries, unseen, markSeen, clear };
}
