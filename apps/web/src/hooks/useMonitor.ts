// Monitor 화면의 지표 (9-1) — 서버가 10초마다 잰 칸(serverStatus + ping)을 소켓으로 받는다.
// 화면이 열려 있는 동안만 구독한다(닫으면 서버도 보내지 않는다). 처음에 최근 1시간을 한 번에 받고, 이후 한 칸씩 붙인다.
// 브라우저 ↔ 서버 왕복은 브라우저가 직접 잰다(같은 10초 간격).
import { useEffect, useState } from 'react';
import type { MonitorInfo, MonitorSample } from '../types/explorer';
import { api } from '../services/api';

// 서버가 들고 있는 만큼(1시간 = 10초 × 360)
const KEEP_SAMPLES = 360;
const RTT_INTERVAL_MS = 10_000;

export interface MonitorState {
  samples: MonitorSample[];
  info: MonitorInfo | null;
  intervalMs: number;
  // 서버에서 처음 기록을 받았는가(받기 전 = 불러오는 중)
  received: boolean;
  rttMs: number | null;
  // 차트의 '지금' — 새 칸이 안 와도 시간 축이 흐르게 10초마다 바뀐다
  now: number;
}

export function useMonitor(enabled: boolean): MonitorState {
  const [samples, setSamples] = useState<MonitorSample[]>([]);
  const [info, setInfo] = useState<MonitorInfo | null>(null);
  const [intervalMs, setIntervalMs] = useState(10_000);
  const [received, setReceived] = useState(false);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    return api.onMonitor((event) => {
      if (event.kind === 'backlog') {
        setSamples(event.snapshot.samples);
        setInfo(event.snapshot.info);
        setIntervalMs(event.snapshot.intervalMs);
      } else {
        setSamples((prev) => {
          const next = [...prev, event.tick.sample];
          return next.length > KEEP_SAMPLES ? next.slice(-KEEP_SAMPLES) : next;
        });
        setInfo(event.tick.info);
      }
      setReceived(true);
      setNow(Date.now());
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const measure = () => {
      setNow(Date.now());
      void api.measureRtt().then((ms) => {
        if (!cancelled) setRttMs(ms);
      });
    };
    measure();
    const timer = setInterval(measure, RTT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return { samples, info, intervalMs, received, rttMs, now };
}
