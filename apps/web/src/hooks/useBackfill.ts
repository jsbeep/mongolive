// 빈 구간 불러오기(9-4) — 탭이 없던 동안의 쓰기를 서버가 changeStream으로 다시 읽는다.
// 처음 한 번 받고(GET), 그다음은 서버가 바뀔 때마다 보내 준다(소켓 'monitor:backfill', 불러오는 중엔 1초에 한 번).
// 연결을 바꾸면 처음부터.
import { useCallback, useEffect, useState } from 'react';
import type { BackfillReport } from '../types/explorer';
import { api } from '../services/api';
import { useActiveConnection } from '../services/activeConnection';

export interface BackfillState {
  report: BackfillReport | null;
  error: string | null;
  // 불러오기·멈춤 요청을 보내는 중인 구간(id, 전부면 '*')
  sending: string | null;
  start: (id?: string) => void;
  stop: (id?: string) => void;
}

export function useBackfill(enabled: boolean): BackfillState {
  const connection = useActiveConnection();
  const [report, setReport] = useState<BackfillReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    setError(null);
    if (!enabled || !connection) return;
    let cancelled = false;
    // 소켓이 먼저 오면 GET 응답(더 오래된 값)으로 덮지 않는다
    let pushed = false;
    const off = api.onBackfill((next) => {
      pushed = true;
      if (!cancelled) setReport(next);
    });
    api.getBackfill().then(
      (next) => !cancelled && !pushed && setReport(next),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled, connection]);

  const send = useCallback((action: 'start' | 'stop', id?: string) => {
    setSending(id ?? '*');
    setError(null);
    const call = action === 'start' ? api.startBackfill(id) : api.stopBackfill(id);
    call
      .then((next) => next && setReport(next))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSending(null));
  }, []);

  return {
    report,
    error,
    sending,
    start: useCallback((id?: string) => send('start', id), [send]),
    stop: useCallback((id?: string) => send('stop', id), [send]),
  };
}
