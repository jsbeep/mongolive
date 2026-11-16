// 서버 샘플러 — 연결(피드) 하나의 지표를 10초마다 직접 잰다 (9-1)
//
// 예전 Metrics 탭은 브라우저가 탭을 열었을 때만 물어봤다. 기록을 쌓으려면 서버가 직접 물어봐야 한다.
// 피드와 함께 시작·종료한다 = 그 연결을 쓰는 탭이 있는 동안만 돈다. 최근 1시간(360칸)을 메모리에 둔다.
//
// 한 칸 = ping 1번 + serverStatus 1번(필요한 섹션만, 약 4KB). 둘 다 읽기 전용이고 아주 가볍다.
// 다음 칸은 이번 칸이 끝난 뒤에 예약한다 — MongoDB가 느려도 요청이 겹쳐 쌓이지 않는다.
import type { MongoClient } from 'mongodb';
import type { MongoTopology, MonitorInfo, MonitorProblem, MonitorSample, MonitorSnapshot, MonitorTick } from '@mongolive/shared';
import { ratesBetween, readStatus, STATUS_COMMAND, STATUS_COMMAND_FULL_METRICS, type StatusCounters } from './serverStatus';

export const SAMPLE_INTERVAL_MS = 10_000;
const KEEP_SAMPLES = 360;
// 명령 하나를 기다리는 최대 시간 — MongoDB가 응답 없이 멈춰도(프로세스 정지·네트워크 끊김) 샘플러는 다음 칸으로 간다.
// 드라이버 7의 명령별 timeoutMS는 효과가 없어서 직접 건다(늦게 온 응답은 버린다)
const COMMAND_TIMEOUT_MS = 5000;

export const withTimeout = <T>(promise: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), COMMAND_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

export interface SamplerHooks {
  // 이 연결의 클라이언트 — 피드가 붙잡아 두고 있다
  client: () => Promise<MongoClient>;
  topology: () => MongoTopology;
  // 이 칸 동안 받은 changeStream 이벤트 수·지연 — 부르면 비운다
  drainStream: () => MonitorSample['stream'];
  onSample: (tick: MonitorTick) => void;
  // serverStatus의 누적값을 읽을 때마다 — 기록 파일이 빈 구간 합계를 내는 데 쓴다(monitor/history)
  onReading?: (counters: StatusCounters, at: number) => void;
  // 로그에 붙일 이름(연결 id)
  label: string;
}

export interface Sampler {
  start: () => void;
  stop: () => void;
  // 다른 클러스터일 수 있을 때(연결 주소가 바뀜) — 지난 기록을 버린다
  reset: () => void;
  snapshot: () => MonitorSnapshot;
}

const errorCode = (e: unknown) => (e as { codeName?: string }).codeName;
const round1 = (value: number) => Math.round(value * 10) / 10;

export const createSampler = (hooks: SamplerHooks): Sampler => {
  let samples: MonitorSample[] = [];
  let prev: StatusCounters | null = null;
  let info: MonitorInfo = { version: null, uptimeSec: null, host: null, topology: 'unknown' };
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  // 재는 중에 reset/stop되면 그 결과는 버린다
  let generation = 0;
  // metrics 하위 항목 빼기를 못 알아들으면(옛 버전) 통째로 받는다
  let fullMetrics = false;
  let lastProblem: MonitorProblem | undefined;

  const readServerStatus = async (client: MongoClient) => {
    const admin = client.db('admin');
    try {
      return await withTimeout(admin.command(fullMetrics ? STATUS_COMMAND_FULL_METRICS : STATUS_COMMAND));
    } catch (e) {
      const code = errorCode(e);
      if (fullMetrics || code === 'Unauthorized' || code === undefined) throw e;
      // 명령 모양을 못 알아들은 에러(권한·네트워크가 아님) — 한 번만 통째로 다시
      fullMetrics = true;
      return withTimeout(admin.command(STATUS_COMMAND_FULL_METRICS));
    }
  };

  const measure = async (): Promise<MonitorSample> => {
    const at = Date.now();
    const failed = (problem: MonitorProblem, pingMs: number | null): MonitorSample => ({
      at,
      problem,
      pingMs,
      rates: null,
      gauges: null,
      stream: hooks.drainStream(),
    });

    let client: MongoClient;
    try {
      client = await withTimeout(hooks.client());
    } catch {
      return failed('unreachable', null);
    }

    let pingMs: number | null = null;
    try {
      const started = performance.now();
      await withTimeout(client.db('admin').command({ ping: 1 }));
      pingMs = round1(performance.now() - started);
    } catch {
      // 닿지 않으면 아래 serverStatus도 실패한다 — 거기서 이유를 정한다
    }

    try {
      const reading = readStatus(await readServerStatus(client));
      const rates = prev ? ratesBetween(prev, reading.counters) : null;
      prev = reading.counters;
      hooks.onReading?.(reading.counters, at);
      info = { version: reading.version, uptimeSec: reading.uptimeSec, host: reading.host, topology: hooks.topology() };
      return { at, pingMs, rates, gauges: reading.gauges, stream: hooks.drainStream() };
    } catch (e) {
      info = { ...info, topology: hooks.topology() };
      if (errorCode(e) === 'Unauthorized') return failed('denied', pingMs);
      return failed(pingMs === null ? 'unreachable' : 'error', pingMs);
    }
  };

  const tick = async () => {
    timer = null;
    const mine = generation;
    const started = Date.now();
    const sample = await measure();
    if (!running || mine !== generation) return;

    // 상태가 바뀔 때만 서버 콘솔에 남긴다(10초마다 같은 에러를 찍지 않게)
    if (sample.problem !== lastProblem) {
      if (sample.problem) console.warn(`[monitor] ${hooks.label} 지표를 못 읽음: ${sample.problem}`);
      else if (lastProblem) console.log(`[monitor] ${hooks.label} 지표 다시 읽음`);
      lastProblem = sample.problem;
    }

    samples.push(sample);
    if (samples.length > KEEP_SAMPLES) samples = samples.slice(-KEEP_SAMPLES);
    hooks.onSample({ sample, info });
    timer = setTimeout(() => void tick(), Math.max(0, SAMPLE_INTERVAL_MS - (Date.now() - started)));
  };

  return {
    start() {
      if (running) return;
      running = true;
      void tick();
    },
    stop() {
      running = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    reset() {
      generation += 1;
      samples = [];
      prev = null;
      fullMetrics = false;
      lastProblem = undefined;
      info = { version: null, uptimeSec: null, host: null, topology: 'unknown' };
      if (running) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    },
    snapshot: () => ({ intervalMs: SAMPLE_INTERVAL_MS, samples, info }),
  };
};
