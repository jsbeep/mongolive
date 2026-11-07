// 시스템 기록(services/systemLog) 구독 + 실시간 연결 상태 변화를 기록에 적는다.
// 앱 전체에서 한 번만 쓴다(page.tsx). '안 본 에러'가 있으면 상태바 종에 빨간 점.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveStatus } from '../types/explorer';
import { api, dataSourceKind } from '../services/api';
import { clearSystemEvents, pushSystemEvent, subscribeSystemEvents, type SystemEntry } from '../services/systemLog';

export interface SystemLog {
  entries: SystemEntry[];
  // System 탭을 마지막으로 본 뒤 생긴 에러 수
  unseenErrors: number;
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
      if (status.state === 'running') {
        pushSystemEvent('success', last ? 'Reconnected — live updates are back' : 'Connected — live updates on');
      } else if (status.state === 'connecting') {
        if (last) pushSystemEvent('warning', 'Connection lost — reconnecting…');
      } else {
        pushSystemEvent('error', `Live updates unavailable${status.error ? `: ${status.error}` : ''}`);
      }
    });
  }, []);

  const unseenErrors = useMemo(() => entries.filter((e) => e.level === 'error' && e.at > seenAt).length, [entries, seenAt]);
  const markSeen = useCallback(() => setSeenAt(Date.now()), []);
  const clear = useCallback(() => clearSystemEvents(), []);

  return { entries, unseenErrors, markSeen, clear };
}
