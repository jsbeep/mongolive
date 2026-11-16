import { describe, expect, it } from 'vitest';
import { ratesBetween, readStatus } from './serverStatus';

// 드라이버가 큰 정수를 주는 모양(Long)
const long = (value: number) => ({ toNumber: () => value });

const status = (over: { uptimeMillis: number; insert?: number; readsMicros?: number; readsOps?: number; scans?: number | null; user?: number }) => ({
  host: 'db1:27017',
  version: '7.0.14',
  uptime: Math.floor(over.uptimeMillis / 1000),
  uptimeMillis: long(over.uptimeMillis),
  opcounters: { insert: long(over.insert ?? 0), query: 0, update: 0, delete: 0, getmore: 0, command: 10 },
  opLatencies: {
    reads: { latency: long(over.readsMicros ?? 0), ops: long(over.readsOps ?? 0) },
    writes: { latency: long(0), ops: long(0) },
    commands: { latency: long(5000), ops: long(10) },
  },
  connections: { current: 5, available: 95, totalCreated: 12 },
  asserts: { regular: 0, warning: 0, msg: 0, user: over.user ?? 0, rollovers: 0 },
  network: { bytesIn: long(1000), bytesOut: long(2000) },
  mem: { resident: 150 },
  metrics: {
    document: { inserted: long(over.insert ?? 0), updated: long(0), deleted: long(0), returned: long(4) },
    queryExecutor: {
      scanned: long(0),
      scannedObjects: long(4),
      ...(over.scans === null ? {} : { collectionScans: { total: long(over.scans ?? 0) } }),
    },
  },
});

describe('readStatus', () => {
  it('Long 값과 게이지를 숫자로 읽는다', () => {
    const reading = readStatus(status({ uptimeMillis: 60_000, insert: 3 }));
    expect(reading.counters.uptimeMs).toBe(60_000);
    expect(reading.counters.ops.insert).toBe(3);
    expect(reading.counters.latency.commands).toEqual({ micros: 5000, ops: 10 });
    expect(reading.gauges).toEqual({ connections: { current: 5, available: 95 }, memResidentMb: 150 });
    expect(reading.version).toBe('7.0.14');
    expect(reading.host).toBe('db1:27017');
  });

  it('collectionScans가 없는 옛 버전이면 null', () => {
    expect(readStatus(status({ uptimeMillis: 1000, scans: null })).counters.collectionScans).toBeNull();
  });

  it('빈 응답이어도 터지지 않는다', () => {
    const reading = readStatus({});
    expect(reading.counters.ops.insert).toBe(0);
    expect(reading.gauges.connections).toBeNull();
  });
});

describe('ratesBetween', () => {
  it('누적값의 차이 ÷ uptime 차이 = 초당 값', () => {
    const prev = readStatus(status({ uptimeMillis: 10_000, insert: 100, scans: 2 })).counters;
    const cur = readStatus(status({ uptimeMillis: 20_000, insert: 150, scans: 7, user: 3 })).counters;
    const rates = ratesBetween(prev, cur);
    expect(rates?.ops.insert).toBe(5);
    expect(rates?.docs.inserted).toBe(5);
    expect(rates?.collectionScans).toBe(0.5);
    expect(rates?.asserts.user).toBe(0.3);
    expect(rates?.newConnections).toBe(0);
  });

  it('평균 지연 = 지연 합계 차이 ÷ 작업 수 차이(ms), 작업이 없으면 null', () => {
    const prev = readStatus(status({ uptimeMillis: 10_000, readsMicros: 1000, readsOps: 1 })).counters;
    const cur = readStatus(status({ uptimeMillis: 20_000, readsMicros: 9000, readsOps: 5 })).counters;
    const rates = ratesBetween(prev, cur);
    expect(rates?.latencyMs.reads).toBe(2);
    expect(rates?.latencyMs.writes).toBeNull();
  });

  it('uptime이 줄었으면(재시작) null', () => {
    const prev = readStatus(status({ uptimeMillis: 50_000, insert: 100 })).counters;
    const cur = readStatus(status({ uptimeMillis: 5_000, insert: 3 })).counters;
    expect(ratesBetween(prev, cur)).toBeNull();
  });

  it('uptime은 늘었어도 누적값이 줄었으면(그 사이 재시작) null', () => {
    const prev = readStatus(status({ uptimeMillis: 5_000, insert: 100 })).counters;
    const cur = readStatus(status({ uptimeMillis: 9_000, insert: 3 })).counters;
    expect(ratesBetween(prev, cur)).toBeNull();
  });
});
