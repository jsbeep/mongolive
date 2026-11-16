import { describe, expect, it } from 'vitest';
import type { LiveChange } from '@mongolive/shared';
import { createActivityStats, MAX_KEYS_PER_SLOT, MINUTE_MS, normalizePath } from './activity';

// 시각을 정할 수 있는 시계 — 10:00:00(UTC)에서 시작
const T0 = Date.UTC(2026, 10, 16, 10, 0, 0);
const clockAt = () => {
  let now = T0;
  return { now: () => now, set: (t: number) => (now = t) };
};

let seq = 0;
const change = (over: Partial<LiveChange> & Pick<LiveChange, 'op' | 'clusterTime'>): LiveChange => ({
  id: `t${seq++}`,
  database: 'shop',
  collection: 'orders',
  detailed: true,
  serverTime: over.clusterTime,
  opTime: '',
  ...over,
});

describe('normalizePath', () => {
  it('배열 번호를 []로 묶는다', () => {
    expect(normalizePath('items.3.qty')).toBe('items.[].qty');
    expect(normalizePath('a.10.b.2')).toBe('a.[].b.[]');
    expect(normalizePath('status')).toBe('status');
  });
});

describe('createActivityStats', () => {
  it('1분 칸에 작업별로 세고, 범위 밖 컬렉션은 빼고, 많은 순으로 준다', () => {
    const clock = clockAt();
    const stats = createActivityStats(T0, clock.now);
    stats.record(change({ op: 'insert', clusterTime: T0 + 1000, documentId: 'a' }));
    stats.record(change({ op: 'update', clusterTime: T0 + 2000, documentId: 'a', updatedFields: { status: 'paid' } }));
    stats.record(change({ op: 'delete', clusterTime: T0 + MINUTE_MS + 5, documentId: 'b' }));
    stats.record(change({ op: 'insert', clusterTime: T0 + 3000, collection: 'users', documentId: 'u' }));
    stats.record(change({ op: 'insert', clusterTime: T0 + 3000, database: 'blog', collection: 'posts', documentId: 'p' }));
    clock.set(T0 + MINUTE_MS + 30_000);

    const all = stats.report({ range: '1h' });
    expect(all.timeline).toHaveLength(2); // 세기 시작(10:00) 전 칸은 없다
    expect(all.timeline[0].ops).toEqual({ insert: 3, update: 1, replace: 0, delete: 0 });
    expect(all.collections.map((c) => `${c.database}.${c.collection}`)).toEqual(['shop.orders', 'shop.users', 'blog.posts']);
    expect(all.collections[0]).toMatchObject({ total: 3, ops: { insert: 1, update: 1, delete: 1 }, trend: [2, 1] });
    expect(all.collections[0].lastWrite).toEqual({ at: T0 + MINUTE_MS + 5, op: 'delete' });

    const shop = stats.report({ database: 'shop', range: '1h' });
    expect(shop.collections.map((c) => c.collection)).toEqual(['orders', 'users']);
    expect(shop.fields).toBeUndefined();
  });

  it('컬렉션 범위면 자주 바뀐 필드(배열 번호 묶음)·문서를 준다', () => {
    const clock = clockAt();
    const stats = createActivityStats(T0, clock.now);
    for (let i = 0; i < 3; i++) stats.record(change({ op: 'update', clusterTime: T0 + i, documentId: 'a', updatedFields: { [`items.${i}.qty`]: { $numberInt: '1' }, status: 'x' } }));
    stats.record(change({ op: 'update', clusterTime: T0 + 9, documentId: 'b', removedFields: ['note'] }));
    const report = stats.report({ database: 'shop', collection: 'orders', range: '5m' });
    expect(report.fields).toEqual([
      { path: 'items.[].qty', count: 3 },
      { path: 'status', count: 3 },
      { path: 'note', count: 1 },
    ]);
    expect(report.documents).toEqual([{ id: 'a', count: 3 }, { id: 'b', count: 1 }]);
    expect(report.partial).toBeUndefined();
  });

  it('5분 범위는 최근 5분 칸만', () => {
    const clock = clockAt();
    const stats = createActivityStats(T0, clock.now);
    stats.record(change({ op: 'insert', clusterTime: T0 }));
    clock.set(T0 + 20 * MINUTE_MS);
    stats.record(change({ op: 'insert', clusterTime: T0 + 19 * MINUTE_MS }));
    const recent = stats.report({ range: '5m' });
    expect(recent.timeline).toHaveLength(5);
    expect(recent.collections[0].total).toBe(1);
    expect(stats.report({ range: '1h' }).collections[0].total).toBe(2);
  });

  it('1시간보다 오래된 칸은 버린다', () => {
    const clock = clockAt();
    const stats = createActivityStats(T0, clock.now);
    stats.record(change({ op: 'insert', clusterTime: T0 }));
    clock.set(T0 + 90 * MINUTE_MS);
    stats.record(change({ op: 'insert', clusterTime: T0 + 90 * MINUTE_MS }));
    const report = stats.report({ range: '1h' });
    expect(report.timeline).toHaveLength(60);
    expect(report.collections[0].total).toBe(1);
  });

  it('서로 다른 문서가 상한을 넘으면 더 세지 않고 partial', () => {
    const clock = clockAt();
    const stats = createActivityStats(T0, clock.now);
    for (let i = 0; i < MAX_KEYS_PER_SLOT + 10; i++) stats.record(change({ op: 'insert', clusterTime: T0 + 1, documentId: `d${i}` }));
    const report = stats.report({ database: 'shop', collection: 'orders', range: '5m' });
    expect(report.partial).toBe(true);
    // 쓰기 수 자체는 다 센다
    expect(report.collections[0].total).toBe(MAX_KEYS_PER_SLOT + 10);
  });

  it('구조 이벤트(drop)는 세지 않고 마지막 쓰기만 바꾼다', () => {
    const clock = clockAt();
    const stats = createActivityStats(T0, clock.now);
    stats.record(change({ op: 'insert', clusterTime: T0 }));
    stats.record(change({ op: 'drop', clusterTime: T0 + 5 }));
    expect(stats.lastWrites()['shop.orders']).toEqual({ at: T0 + 5, op: 'drop' });
    expect(stats.report({ range: '1h' }).collections[0].total).toBe(1);
  });

  it('불러오기(9-4)로 넣은 몫은 메모리 집계엔 들어가고 1분 기록(minuteWrites)에선 빠진다', () => {
    const clock = clockAt();
    const stats = createActivityStats(T0, clock.now);
    clock.set(T0 + 30_000);
    stats.record(change({ op: 'insert', clusterTime: T0 + 5_000 }), true);
    stats.record(change({ op: 'insert', clusterTime: T0 + 20_000 }));
    expect(stats.report({ range: '5m' }).collections[0].total).toBe(2);
    expect(stats.minuteWrites(T0)?.get('shop.orders')).toEqual({ insert: 1, update: 0, replace: 0, delete: 0 });
  });

  it('늦게 읽은 옛 이벤트가 마지막 쓰기를 덮지 않고, 세기 시작을 앞당길 수 있다', () => {
    const clock = clockAt();
    const stats = createActivityStats(T0 + MINUTE_MS, clock.now);
    clock.set(T0 + 2 * MINUTE_MS);
    stats.record(change({ op: 'update', clusterTime: T0 + 90_000 }));
    stats.record(change({ op: 'delete', clusterTime: T0 + 10_000 }), true);
    expect(stats.lastWrites()['shop.orders']).toEqual({ at: T0 + 90_000, op: 'update' });
    stats.extendSince(T0);
    expect(stats.since).toBe(T0);
    expect(stats.report({ range: '5m' }).timeline[0].at).toBe(T0);
  });
});
