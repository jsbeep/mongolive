// Monitor › Collections(9-2)의 데이터 — 서버가 changeStream으로 센 쓰기 집계를 10초마다 다시 받는다.
// 받는 동안에도 지난 값을 그대로 보여 준다(새로 받을 때마다 화면이 깜빡이지 않게). 범위·기간이 바뀌면 처음부터.
// 탭이 숨겨져 있으면(document.hidden) 쉬고, 다시 보이면 바로 받는다.
import { useEffect, useState } from 'react';
import type { ActivityRange, ActivityReport, HistoryReport, LastWrites, MonitorRange } from '../types/explorer';
import { api } from '../services/api';

const POLL_MS = 10_000;
// 기록 파일(긴 기간)은 1분에 한 줄씩 늘어난다
const HISTORY_POLL_MS = 60_000;

// 보이는 동안 intervalMs마다 fetch — 겹치지 않게(이전 요청이 끝난 뒤 다음을 예약)
function usePoll<T>(enabled: boolean, key: string, fetch: () => Promise<T | null>, intervalMs = POLL_MS) {
  const [data, setData] = useState<{ key: string; value: T | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 받는 중 — 그 사이 탭이 다시 보여도 두 번째 고리를 만들지 않게
    let busy = false;
    const run = async () => {
      timer = null;
      if (document.hidden) return;
      busy = true;
      try {
        const value = await fetch();
        if (cancelled) return;
        setData({ key, value });
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
      busy = false;
      if (cancelled) return;
      setNow(Date.now());
      timer = setTimeout(() => void run(), intervalMs);
    };
    const onVisible = () => {
      if (!document.hidden && timer === null && !busy) void run();
    };
    void run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // fetch는 key가 같으면 같은 요청이라 의존성에서 뺀다
  }, [enabled, key]);

  // 범위가 바뀐 직후엔 지난 범위의 값을 보여 주지 않는다
  return { value: data?.key === key ? data.value : null, stale: data !== null && data.key !== key, error, now };
}

export interface ActivityState {
  report: ActivityReport | null;
  // 범위를 바꾼 뒤 새 값을 기다리는 중
  loading: boolean;
  error: string | null;
  now: number;
}

export function useActivity(enabled: boolean, scope: { database: string | null; collection: string | null }, range: ActivityRange): ActivityState {
  const key = JSON.stringify([scope.database, scope.collection, range]);
  const { value, stale, error, now } = usePoll(enabled, key, () => api.getActivity(scope, range));
  return { report: value, loading: value === null && (stale || error === null), error, now };
}

export interface LastWritesState {
  data: LastWrites | null;
  now: number;
}

// 사이드바 트리의 '마지막 쓰기' — Monitor를 보는 동안만
export function useLastWrites(enabled: boolean): LastWritesState {
  const { value, now } = usePoll(enabled, 'last-writes', () => api.getLastWrites());
  return { data: enabled ? value : null, now };
}

export interface HistoryState {
  report: HistoryReport | null;
  loading: boolean;
  error: string | null;
}

// Monitor의 긴 기간(24h~All, 9-3b) — 기록 파일. 1분마다 다시 받는다
export function useHistory(
  enabled: boolean,
  range: MonitorRange,
  options: { writes?: boolean; database?: string | null; collection?: string | null } = {},
): HistoryState {
  const fileRange = range === '5m' || range === '1h' ? null : range;
  const key = JSON.stringify([fileRange, options.writes ?? false, options.database ?? null, options.collection ?? null]);
  const { value, stale, error } = usePoll(enabled && fileRange !== null, key, () => (fileRange ? api.getHistory(fileRange, options) : Promise.resolve(null)), HISTORY_POLL_MS);
  return { report: value, loading: value === null && (stale || error === null), error };
}
