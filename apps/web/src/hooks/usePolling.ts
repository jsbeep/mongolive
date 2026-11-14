// 단독 MongoDB(replica set 아님)엔 실시간(change stream)이 없다 — 보이는 범위를 주기적으로 다시 받는다(8-6).
//   쉬는 때: 편집 중·충돌 창일 때(paused), 다른 창(모달)이 떠 있을 때, 탭이 안 보일 때 — 그 차례는 건너뛴다
//   겹치지 않게: 받기가 끝난 뒤에야 다음 타이머를 건다
//   직접 새로 고침(R·⟳)하면 resetKey가 바뀌어 처음부터 다시 센다
//   탭이 숨어 있는 동안 차례를 건너뛰었으면, 다시 보일 때 바로 한 번 받는다
import { useEffect, useRef } from 'react';

interface PollingOptions {
  enabled: boolean;
  // 0 = 끔(직접 새로 고침만)
  intervalMs: number;
  paused: boolean;
  poll: () => Promise<void>;
  resetKey: number;
}

export function usePolling({ enabled, intervalMs, paused, poll, resetKey }: PollingOptions) {
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let running = false;
    // 탭이 숨어 있어서 건너뛴 차례가 있다
    let missed = false;

    const schedule = () => {
      timer = setTimeout(() => void tick(), intervalMs);
    };
    const tick = async () => {
      timer = null;
      if (cancelled) return;
      if (document.hidden) {
        missed = true;
        schedule();
        return;
      }
      if (pausedRef.current || document.querySelector('[aria-modal="true"]')) {
        schedule();
        return;
      }
      missed = false;
      running = true;
      try {
        await pollRef.current();
      } catch {
        // 실패는 연결 상태(하트비트)가 따로 알린다 — 다음 차례에 다시
      } finally {
        running = false;
      }
      if (!cancelled) schedule();
    };
    const onVisibility = () => {
      if (document.hidden || !missed || running || cancelled) return;
      if (timer) clearTimeout(timer);
      void tick();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs, resetKey]);
}
