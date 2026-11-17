import type { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { createTop, readTop, topDelta } from './top';

// top의 한 컬렉션 항목 — total = readLock + writeLock
const entry = (read: [number, number], write: [number, number], ops: Partial<Record<string, [number, number]>> = {}) => {
  const u = ([time, count]: [number, number]) => ({ time, count });
  const doc: Record<string, unknown> = {
    total: u([read[0] + write[0], read[1] + write[1]]),
    readLock: u(read),
    writeLock: u(write),
  };
  for (const op of ['queries', 'getmore', 'insert', 'update', 'remove', 'commands']) doc[op] = u(ops[op] ?? [0, 0]);
  return doc;
};

describe('readTop', () => {
  it('note·admin·local·config·system.*은 빼고 db.collection마다 숫자', () => {
    const map = readTop({
      note: 'all times in microseconds',
      'shop.orders': entry([100, 2], [50, 1]),
      'admin.system.version': entry([1, 1], [0, 0]),
      'local.oplog.rs': entry([1, 1], [0, 0]),
      'shop.system.profile': entry([1, 1], [0, 0]),
    });
    expect([...map.keys()]).toEqual(['shop.orders']);
    expect(map.get('shop.orders')?.slice(0, 6)).toEqual([150, 3, 100, 2, 50, 1]);
  });
});

describe('topDelta', () => {
  it('늘어난 만큼, 새 컬렉션·줄어든 카운터는 지금 값 전체, 0이면 뺀다', () => {
    const prev = readTop({ 'a.x': entry([100, 2], [0, 0]), 'a.y': entry([500, 9], [0, 0]), 'a.z': entry([10, 1], [0, 0]) });
    const cur = readTop({ 'a.x': entry([160, 5], [0, 0]), 'a.y': entry([20, 1], [0, 0]), 'a.z': entry([10, 1], [0, 0]), 'a.new': entry([7, 1], [3, 1]) });
    const delta = topDelta(prev, cur);
    expect(delta.get('a.x')?.slice(0, 2)).toEqual([60, 3]);
    expect(delta.get('a.y')?.slice(0, 2)).toEqual([20, 1]);
    expect(delta.get('a.new')?.slice(0, 2)).toEqual([10, 2]);
    expect(delta.has('a.z')).toBe(false);
  });
});

describe('createTop', () => {
  const MIN = 60_000;
  const start = Date.UTC(2026, 10, 17, 9, 0, 30);
  const setup = (readings: unknown[]) => {
    let now = start;
    let i = 0;
    const client = {
      db: () => ({
        command: async () => {
          const next = readings[Math.min(i++, readings.length - 1)];
          if (next instanceof Error) throw next;
          return { totals: next, ok: 1 };
        },
      }),
    } as unknown as MongoClient;
    const top = createTop({ client: async () => client, clock: () => now });
    return { top, advance: (ms: number) => (now += ms) };
  };

  it('첫 읽기는 기준, 그 뒤 차이를 1분 칸에 — 범위·기간으로 자르고 시간 순', async () => {
    const { top, advance } = setup([
      { 'shop.orders': entry([0, 0], [0, 0]), 'shop.users': entry([0, 0], [0, 0]) },
      { 'shop.orders': entry([1000, 10], [0, 0], { queries: [1000, 10] }), 'shop.users': entry([0, 0], [0, 0]) },
      { 'shop.orders': entry([1000, 10], [0, 0], { queries: [1000, 10] }), 'shop.users': entry([0, 0], [9000, 3], { update: [9000, 3] }), 'logs.app': entry([5, 1], [0, 0]) },
    ]);
    await top.poll();
    expect(top.report({ range: '1h', scope: { database: null, collection: null } })).toMatchObject({ status: 'ok', since: start, rows: [] });
    advance(10_000);
    await top.poll();
    // 10분 뒤 — 5m 기간엔 첫 차이가 빠진다
    advance(10 * MIN);
    await top.poll();
    const all = top.report({ range: '1h', scope: { database: null, collection: null } });
    expect(all.rows.map((r) => `${r.database}.${r.collection}`)).toEqual(['shop.users', 'shop.orders', 'logs.app']);
    expect(all.rows[0]).toMatchObject({ total: { time: 9000, count: 3 }, write: { time: 9000, count: 3 }, read: { time: 0, count: 0 } });
    expect(all.rows[0].ops.update).toEqual({ time: 9000, count: 3 });
    expect(all.rows[1].ops.queries).toEqual({ time: 1000, count: 10 });
    const recent = top.report({ range: '5m', scope: { database: 'shop', collection: null } });
    expect(recent.rows.map((r) => r.collection)).toEqual(['users']);
    expect(recent.since).toBeGreaterThan(start);
  });

  it('mongos(59)는 다시 묻지 않고, 권한 없음(13)은 기준을 버린다', async () => {
    const notFound = Object.assign(new Error('no such command: top'), { code: 59 });
    const { top: mongos } = setup([notFound, {}]);
    await mongos.poll();
    await mongos.poll();
    expect(mongos.report({ range: '1h', scope: { database: null, collection: null } })).toMatchObject({ status: 'unsupported', since: null });

    const denied = Object.assign(new Error('not authorized'), { code: 13 });
    const { top, advance } = setup([{ 'a.x': entry([0, 0], [0, 0]) }, denied]);
    await top.poll();
    advance(10_000);
    await top.poll();
    expect(top.report({ range: '1h', scope: { database: null, collection: null } })).toMatchObject({ status: 'denied', since: null });
  });
});
