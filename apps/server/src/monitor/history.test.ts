import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityOps, MonitorHistory, MonitorSample } from '@mongolive/shared';
import { createRecorder, dropConnectionHistory, gapBetween, historyInfo, readJsonl, type GapRecord } from './history';
import { addSample, average, emptyRollup, mergeRollups, type Rollup } from './rollup';
import type { StatusCounters } from './serverStatus';

const MIN = 60_000;
// 이 컴퓨터 시간대의 2026-11-16 10:00
const T0 = new Date(2026, 10, 16, 10, 0, 0).getTime();

const sample = (at: number, over: { ops?: number; ping?: number; conns?: number; events?: number } = {}): MonitorSample => ({
  at,
  pingMs: over.ping ?? 1,
  rates: {
    ops: { insert: over.ops ?? 1, query: 0, update: 0, delete: 0, getmore: 0, command: 2 },
    docs: { inserted: over.ops ?? 1, updated: 0, deleted: 0, returned: 0 },
    latencyMs: { reads: null, writes: 0.5, commands: 0.1 },
    scannedKeys: 0,
    scannedDocs: 0,
    collectionScans: 0,
    newConnections: 0,
    asserts: { regular: 0, warning: 0, msg: 0, user: 0 },
    network: { inBps: 100, outBps: 200 },
  },
  gauges: { connections: { current: over.conns ?? 5, available: 95 }, memResidentMb: 150 },
  stream: { events: over.events ?? 10, lagP95Ms: 3 },
});

const counters = (uptimeMs: number, insert: number): StatusCounters => ({
  uptimeMs,
  ops: { insert, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
  latency: { reads: { micros: 0, ops: 0 }, writes: { micros: 0, ops: 0 }, commands: { micros: 0, ops: 0 } },
  docs: { inserted: insert, updated: 0, deleted: 0, returned: 0 },
  scannedKeys: 0,
  scannedDocs: 0,
  collectionScans: 0,
  connectionsCreated: 0,
  asserts: { regular: 0, warning: 0, msg: 0, user: 0 },
  bytesIn: 0,
  bytesOut: 0,
});

describe('rollup', () => {
  it('합·개수·최대를 들고, 합치면 평균이 정확하다', () => {
    const a = emptyRollup(T0);
    addSample(a, sample(T0, { conns: 4 }), 10);
    addSample(a, sample(T0 + 10_000, { conns: 10 }), 10);
    expect(a.n).toBe(2);
    expect(average(a, 'conns')).toBe(7);
    expect(a.x.conns).toBe(10);
    expect(a.c.latReads).toBeUndefined(); // 못 잰 값은 세지 않는다
    expect(average(a, 'events')).toBe(1); // 10건 ÷ 10초

    const b = emptyRollup(T0 + MIN);
    addSample(b, sample(T0 + MIN, { conns: 1 }), 10);
    const merged = mergeRollups(T0, [a, b], 10);
    expect(merged.n).toBe(3);
    expect(average(merged, 'conns')).toBe(5); // (4 + 10 + 1) ÷ 3
    expect(merged.x.conns).toBe(10);
  });

  it('컬렉션별 쓰기는 합치고 상위 N개만', () => {
    const ops = (n: number): ActivityOps => ({ insert: n, update: 0, replace: 0, delete: 0 });
    const a: Rollup = { ...emptyRollup(T0), w: { 'shop.a': ops(5), 'shop.b': ops(1) } };
    const b: Rollup = { ...emptyRollup(T0), w: { 'shop.a': ops(2), 'shop.c': ops(3) } };
    expect(mergeRollups(T0, [a, b], 2).w).toEqual({ 'shop.a': ops(7), 'shop.c': ops(3) });
  });
});

describe('gapBetween', () => {
  it('재시작이 없으면 그동안의 합계', () => {
    const gap = gapBetween({ at: T0, counters: counters(100_000, 50) }, counters(100_000 + 600_000, 80), T0 + 600_000);
    expect(gap).toMatchObject({ from: T0, to: T0 + 600_000, restarted: false, ops: { insert: 30 }, docs: { inserted: 30 } });
  });
  it('uptime이 흐른 만큼 늘지 않았으면 재시작', () => {
    expect(gapBetween({ at: T0, counters: counters(100_000, 50) }, counters(5_000, 2), T0 + 600_000).restarted).toBe(true);
  });
});

describe('createRecorder', () => {
  let root: string;
  let now = T0;
  let retention: MonitorHistory = '90d';
  let alive = true;
  const writes = new Map<number, Map<string, ActivityOps>>();
  const make = (fp = 'rs-test-abc') =>
    createRecorder({
      connectionId: 'conn1',
      fingerprint: async () => fp,
      minuteWrites: (start) => writes.get(start),
      retention: () => retention,
      alive: () => alive,
      intervalSec: 10,
      clock: () => now,
    });
  const dir = (fp = 'rs-test-abc') => join(root, 'conn1', fp);
  const feed = (r: ReturnType<typeof make>, at: number, over?: Parameters<typeof sample>[1]) => {
    now = at;
    r.addSample(sample(at, over));
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ml-metrics-'));
    process.env.METRICS_DIR = root;
    now = T0;
    retention = '90d';
    alive = true;
    writes.clear();
  });
  afterEach(async () => {
    delete process.env.METRICS_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it('분이 바뀌면 지난 1분을 날짜 파일에 한 줄로(컬렉션별 쓰기 포함)', async () => {
    const r = make();
    writes.set(T0, new Map([['shop.orders', { insert: 3, update: 1, replace: 0, delete: 0 }]]));
    for (let i = 0; i < 6; i++) feed(r, T0 + i * 10_000);
    feed(r, T0 + MIN);
    await r.idle();
    const lines = await readJsonl<Rollup>(join(dir(), 'minutes-2026-11-16.jsonl'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ t: T0, n: 6, w: { 'shop.orders': { insert: 3, update: 1 } } });
  });

  it('시간이 끝나면 분 기록을 합쳐 시 파일에, 날이 끝나면 일 파일에', async () => {
    const r = make();
    // 23:00 ~ 다음 날 00:01 (1분에 한 칸)
    const start = new Date(2026, 10, 16, 23, 0, 0).getTime();
    for (let m = 0; m <= 61; m++) feed(r, start + m * MIN, { conns: m < 60 ? 2 : 9 });
    await r.idle();
    const hours = await readJsonl<Rollup>(join(dir(), 'hours-2026-11.jsonl'));
    expect(hours.map((h) => h.t)).toEqual([start]);
    expect(hours[0].n).toBe(60);
    expect(average(hours[0], 'conns')).toBe(2);
    const days = await readJsonl<Rollup>(join(dir(), 'days-2026.jsonl'));
    expect(days.map((d) => d.t)).toEqual([new Date(2026, 10, 16).getTime()]);
  });

  it('멈출 때 덜 찬 1분도 적는다', async () => {
    const r = make();
    feed(r, T0);
    feed(r, T0 + 10_000);
    await r.stop();
    const lines = await readJsonl<Rollup>(join(dir(), 'minutes-2026-11-16.jsonl'));
    expect(lines).toEqual([expect.objectContaining({ t: T0, n: 2 })]);
  });

  it('닫혀 있던 동안 끝난 시간은 다음에 열릴 때 따라잡아 합친다', async () => {
    const a = make();
    for (let m = 0; m < 30; m++) feed(a, T0 + m * MIN);
    await a.stop();
    expect(await readJsonl(join(dir(), 'hours-2026-11.jsonl'))).toEqual([]);

    const b = make();
    feed(b, T0 + 3 * 60 * MIN); // 3시간 뒤
    feed(b, T0 + 3 * 60 * MIN + MIN);
    await b.idle();
    const hours = await readJsonl<Rollup>(join(dir(), 'hours-2026-11.jsonl'));
    expect(hours.map((h) => h.t)).toEqual([T0]);
    expect(hours[0].n).toBe(30);
  });

  it('다시 열렸을 때 지난 누적값과 비교해 빈 구간을 남긴다', async () => {
    const a = make();
    a.addCounters(counters(1_000_000, 100), T0);
    feed(a, T0);
    await a.stop();

    const b = make();
    now = T0 + 20 * MIN;
    b.addCounters(counters(1_000_000 + 20 * MIN, 160), now);
    await b.idle();
    const gaps = await readJsonl<GapRecord>(join(dir(), 'gaps.jsonl'));
    expect(gaps).toEqual([expect.objectContaining({ from: T0, to: T0 + 20 * MIN, restarted: false, ops: expect.objectContaining({ insert: 60 }) })]);
  });

  it('주소를 바꿨다 되돌리면 옛 폴더에 이어 쓴다(신분별 폴더)', async () => {
    const a = make('rs-one');
    feed(a, T0);
    await a.stop();
    const b = make('rs-two');
    feed(b, T0 + MIN);
    await b.stop();
    const c = make('rs-one');
    feed(c, T0 + 2 * MIN);
    await c.stop();
    expect((await readJsonl<Rollup>(join(dir('rs-one'), 'minutes-2026-11-16.jsonl'))).map((l) => l.t)).toEqual([T0, T0 + 2 * MIN]);
    const info = await historyInfo('conn1', 'rs-one');
    expect(info.servers).toBe(2);
    expect(info.oldest).toBe(T0);
    expect(info.bytes).toBeGreaterThan(0);
  });

  it('오래된 분 파일·보관 기간 지난 시 파일은 통째로 지운다', async () => {
    const r = make();
    feed(r, T0);
    await r.stop();
    await writeFile(join(dir(), 'minutes-2026-11-10.jsonl'), '{}\n');
    await writeFile(join(dir(), 'hours-2026-05.jsonl'), '{}\n');
    await writeFile(join(dir(), 'hours-2026-10.jsonl'), '{}\n');
    await writeFile(join(dir(), 'days-2020.jsonl'), '{}\n');
    const b = make();
    feed(b, T0 + 60 * MIN); // 시간 경계 → 합치고 정리
    feed(b, T0 + 61 * MIN);
    await b.idle();
    const files = await readdir(dir());
    expect(files).not.toContain('minutes-2026-11-10.jsonl');
    expect(files).not.toContain('hours-2026-05.jsonl'); // 90일보다 오래됨
    expect(files).toContain('hours-2026-10.jsonl');
    expect(files).toContain('days-2020.jsonl'); // 일 기록은 지우지 않는다
  });

  it('기록 끄기면 아무 파일도, 지운 연결이면 폴더를 만들지 않는다', async () => {
    retention = 'off';
    const r = make();
    feed(r, T0);
    feed(r, T0 + MIN);
    await r.stop();
    retention = '90d';
    alive = false;
    const s = make();
    feed(s, T0);
    feed(s, T0 + MIN);
    await s.stop();
    expect(await readdir(root)).toEqual([]);
  });

  it('지우기 = 이 연결의 기록 전부', async () => {
    const r = make();
    feed(r, T0);
    feed(r, T0 + MIN);
    await r.idle();
    await r.clear();
    expect(await readdir(root)).toEqual([]);
    await dropConnectionHistory('conn1');
  });
});
