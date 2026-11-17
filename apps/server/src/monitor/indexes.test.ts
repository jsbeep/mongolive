import { Long } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { keyPattern, mergeIndexes } from './indexes';

const since = new Date(2026, 10, 15, 9, 0).getTime();
const specs = [
  { v: 2, key: { _id: 1 }, name: '_id_' },
  { v: 2, key: { email: 1 }, name: 'email_1', unique: true },
  { v: 2, key: { createdAt: 1 }, name: 'createdAt_1', expireAfterSeconds: 3600 },
  { v: 2, key: { status: 1, at: -1 }, name: 'status_1_at_-1', partialFilterExpression: { status: { $eq: 'open' } }, hidden: true },
];

describe('keyPattern', () => {
  it('숫자·글자 키, 텍스트 인덱스는 필드 이름', () => {
    expect(keyPattern({ a: 1, b: -1, loc: '2dsphere' })).toEqual({ a: 1, b: -1, loc: '2dsphere' });
    expect(keyPattern({ _fts: 'text', _ftsx: 1, shop: 1 }, { title: 10, body: 1 })).toEqual({ title: 'text', body: 'text', shop: 1 });
  });
});

describe('mergeIndexes', () => {
  it('정의 + 쓰인 횟수 + 크기 — 샤드마다 온 것은 더하고 since는 늦은 쪽', () => {
    const usage = [
      { name: '_id_', accesses: { ops: Long.fromNumber(40), since: new Date(since) }, shard: 's0' },
      { name: '_id_', accesses: { ops: 2, since: new Date(since + 60_000) }, shard: 's1' },
      { name: 'email_1', accesses: { ops: 0, since: new Date(since) } },
      // 만드는 중 — listIndexes엔 아직 없다
      { name: 'tmp_1', key: { tmp: 1 }, accesses: { ops: 0, since: new Date(since) }, building: true },
    ];
    const sizes = [{ storageStats: { indexSizes: { _id_: 4096, email_1: 8192 } } }, { storageStats: { indexSizes: { _id_: 4096 } } }];
    const rows = mergeIndexes(specs, usage, sizes);
    expect(rows.map((r) => r.name)).toEqual(['_id_', 'email_1', 'createdAt_1', 'status_1_at_-1', 'tmp_1']);
    expect(rows[0]).toMatchObject({ ops: 42, since: since + 60_000, size: 8192 });
    expect(rows[1]).toMatchObject({ ops: 0, unique: true, size: 8192 });
    // $indexStats에 없는 인덱스 = 0회, 언제부터인지 모름
    expect(rows[2]).toMatchObject({ ops: 0, since: null, ttl: 3600, size: null });
    expect(rows[3]).toMatchObject({ key: { status: 1, at: -1 }, hidden: true, partial: expect.stringContaining('open') });
    expect(rows[4]).toMatchObject({ key: { tmp: 1 }, building: true });
  });

  it('권한이 없으면(usage null) 횟수·since 없이 정의·크기만', () => {
    const rows = mergeIndexes(specs.slice(0, 1), null, null);
    expect(rows).toEqual([{ name: '_id_', key: { _id: 1 }, ops: null, since: null, size: null, unique: false, sparse: false, partial: null, hidden: false, ttl: null, building: false }]);
  });
});
