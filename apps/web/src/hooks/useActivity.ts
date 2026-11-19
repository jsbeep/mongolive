// Monitor › Collections(9-2)의 데이터 — 서버가 changeStream으로 센 쓰기 집계를 10초마다 다시 받는다.
// 받는 동안에도 지난 값을 그대로 보여 준다(새로 받을 때마다 화면이 깜빡이지 않게). 범위·기간이 바뀌면 처음부터.
// 탭이 숨겨져 있으면(document.hidden) 쉬고, 다시 보이면 바로 받는다.
import { useCachedReport } from './useCachedReport';
import { useEffect, useState } from 'react';
import type { ActivityRange, ActivityReport, HistoryReport, LastWrites, MonitorPeriod } from '../types/explorer';
import { isLiveRange, isWindow } from '../types/explorer';
import { api } from '../services/api';

const POLL_MS = 10_000;
// 기록 파일(긴 기간)은 1분에 한 줄씩 늘어난다
const HISTORY_POLL_MS = 60_000;

// 보이는 동안 intervalMs마다 fetch — 겹치지 않게(이전 요청이 끝난 뒤 다음을 예약)
// 마지막 응답은 기억해 둔다(useCachedReport) — 탭을 바꿔 다시 와도 바로 그리고 뒤에서 새로 받는다
// again = 다음에도 받을까(없으면 늘). 끝난 구간(날짜로 찾기)은 한 번만
function usePoll<T>(card: string, enabled: boolean, key: string, fetch: () => Promise<T | null>, intervalMs = POLL_MS, again: () => boolean = () => true) {
  const { report, refreshing, setReport } = useCachedReport<T>(card, key);
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
        setReport(value);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
      busy = false;
      if (cancelled) return;
      setNow(Date.now());
      if (again()) timer = setTimeout(() => void run(), intervalMs);
    };
    const onVisible = () => {
      if (!document.hidden && timer === null && !busy && again()) void run();
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

  // 범위가 바뀐 직후엔 그 범위의 기억(없으면 null)만 보여 준다
  return { value: report, refreshing, error, now };
}

export interface ActivityState {
  report: ActivityReport | null;
  // 범위를 바꾼 뒤 새 값을 기다리는 중
  loading: boolean;
  // 지난 응답을 보여 주며 새로 받는 중
  refreshing: boolean;
  error: string | null;
  now: number;
}

export function useActivity(enabled: boolean, scope: { database: string | null; collection: string | null }, range: ActivityRange): ActivityState {
  const key = JSON.stringify([scope.database, scope.collection, range]);
  const { value, refreshing, error, now } = usePoll('activity', enabled, key, () => api.getActivity(scope, range));
  return { report: value, loading: value === null && error === null, refreshing, error, now };
}

export interface LastWritesState {
  data: LastWrites | null;
  now: number;
}

// 사이드바 트리의 '마지막 쓰기' — Monitor를 보는 동안만
export function useLastWrites(enabled: boolean): LastWritesState {
  const { value, now } = usePoll('last-writes', enabled, 'all', () => api.getLastWrites());
  return { data: enabled ? value : null, now };
}

export interface HistoryState {
  report: HistoryReport | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
}

// Monitor의 긴 기간(6h~All, 9-3b)·날짜로 찾기 구간(C2) — 기록 파일. 1분마다 다시 받는다(끝난 구간은 한 번만)
export function useHistory(
  enabled: boolean,
  range: MonitorPeriod,
  options: { writes?: boolean; database?: string | null; collection?: string | null } = {},
): HistoryState {
  const fileRange = isLiveRange(range) ? null : range;
  const again = () => !isWindow(range) || range.to >= Date.now() - 60_000;
  const key = JSON.stringify([fileRange, options.writes ?? false, options.database ?? null, options.collection ?? null]);
  const { value, refreshing, error } = usePoll('history', enabled && fileRange !== null, key, () => (fileRange ? api.getHistory(fileRange, options) : Promise.resolve(null)), HISTORY_POLL_MS, again);
  return { report: value, loading: value === null && error === null, refreshing, error };
}
