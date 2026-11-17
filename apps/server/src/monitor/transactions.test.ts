import type { LiveChange, LiveOperation } from '@mongolive/shared';
import { Binary, Long } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { createTransactions, txnOf } from './transactions';

const MIN = 60_000;
const T = Date.UTC(2026, 10, 18, 9, 30, 0);
const SERVER = { database: null, collection: null };

let seq = 0;
const change = (op: LiveOperation, t: number, collection: string, txn?: string, database = 'shop'): LiveChange => ({
  id: String((seq += 1)),
  op,
  database,
  collection,
  detailed: false,
  clusterTime: t,
  serverTime: t,
  opTime: '',
  ...(txn ? { txn } : {}),
});

const setup = (since = T - 30 * MIN) => {
  let now = T;
  const tx = createTransactions({ since: () => since, clock: () => now });
  return { tx, at: (t: number) => (now = t) };
};

describe('txnOf', () => {
  it('lsid 16진수 + txnNumber, 트랜잭션 밖이면 없음', () => {
    const id = new Binary(Buffer.from('00112233445566778899aabbccddeeff', 'hex'), 4);
    expect(txnOf({ lsid: { id, uid: new Binary(Buffer.alloc(32)) }, txnNumber: Long.fromNumber(7) })).toBe('00112233445566778899aabbccddeeff:7');
    expect(txnOf({ lsid: { id }, txnNumber: 3 })).toBe('00112233445566778899aabbccddeeff:3');
    expect(txnOf({ operationType: 'insert' })).toBeUndefined();
    expect(txnOf({ lsid: { id } })).toBeUndefined();
  });
});

describe('createTransactions', () => {
  it('트랜잭션별로 모아 개수·쓰기·조합·큰 것을 센다', () => {
    const { tx, at } = setup();
    const t1 = T - 10 * MIN;
    tx.record(change('insert', t1, 'orders', 'a:1'));
    tx.record(change('update', t1, 'stock', 'a:1'));
    tx.record(change('update', t1, 'stock', 'a:1'));
    tx.record(change('insert', t1 + 1000, 'audit')); // 트랜잭션 밖 — 안 센다, a:1은 끝남
    tx.record(change('delete', t1 + 2000, 'orders', 'b:1'));
    tx.record(change('replace', t1 + 3000, 'stock', 'c:1'));
    tx.record(change('insert', t1 + 3000, 'orders', 'c:1'));
    at(T);
    const r = tx.report({ range: '1h', scope: SERVER });
    expect(r).toMatchObject({ count: 3, writes: 6, maxWrites: 3, partial: false });
    expect(r.perMinute).toBeCloseTo(3 / 30);
    expect(r.combos).toEqual([
      { namespaces: ['shop.orders', 'shop.stock'], more: 0, count: 2, writes: 5 },
      { namespaces: ['shop.orders'], more: 0, count: 1, writes: 1 },
    ]);
    expect(r.largest[0]).toEqual({
      at: t1,
      writes: 3,
      ops: { insert: 1, update: 2, delete: 0 },
      namespaces: [{ ns: 'shop.stock', writes: 2 }, { ns: 'shop.orders', writes: 1 }],
      more: 0,
    });
    expect(r.largest.map((s) => s.writes)).toEqual([3, 2, 1]);
  });

  it('범위는 그 컬렉션·DB를 건드린 트랜잭션 — 숫자는 트랜잭션 전체', () => {
    const { tx } = setup();
    const t1 = T - 2 * MIN;
    tx.record(change('insert', t1, 'orders', 'a:1'));
    tx.record(change('insert', t1, 'stock', 'a:1'));
    tx.record(change('insert', t1 + 1000, 'orders', 'b:1'));
    tx.record(change('insert', t1 + 2000, 'users', 'c:1', 'crm'));
    tx.tick();
    expect(tx.report({ range: '1h', scope: { database: 'shop', collection: 'stock' } })).toMatchObject({ count: 1, writes: 2 });
    expect(tx.report({ range: '1h', scope: { database: 'shop', collection: null } })).toMatchObject({ count: 2, writes: 3 });
    expect(tx.report({ range: '1h', scope: { database: 'crm', collection: 'orders' } }).count).toBe(0);
    // 이름 앞부분만 같은 DB는 아니다
    expect(tx.report({ range: '1h', scope: { database: 'sho', collection: null } }).count).toBe(0);
  });

  it('모으는 중인 것도 보이고, 조용해지면 끝나 1분 칸으로 — 숫자는 같다', () => {
    const { tx, at } = setup();
    tx.record(change('insert', T, 'orders', 'a:1'));
    tx.record(change('insert', T, 'stock', 'a:1'));
    expect(tx.report({ range: '5m', scope: SERVER })).toMatchObject({ count: 1, writes: 2 });
    at(T + 3000);
    tx.tick();
    expect(tx.report({ range: '5m', scope: SERVER })).toMatchObject({ count: 1, writes: 2 });
    // 같은 커밋 시각의 다른 트랜잭션은 따로
    tx.record(change('insert', T + 3000, 'orders', 'b:1'));
    tx.record(change('insert', T + 3000, 'orders', 'c:1'));
    expect(tx.report({ range: '5m', scope: SERVER })).toMatchObject({ count: 3, writes: 4 });
  });

  it('5m는 그 앞을 빼고, 1시간 지난 칸은 버린다', () => {
    const { tx, at } = setup(T - 2 * 60 * MIN);
    tx.record(change('insert', T - 20 * MIN, 'orders', 'a:1'));
    tx.record(change('insert', T - MIN, 'orders', 'b:1'));
    tx.tick();
    expect(tx.report({ range: '5m', scope: SERVER }).count).toBe(1);
    expect(tx.report({ range: '1h', scope: SERVER }).count).toBe(2);
    expect(tx.report({ range: '1h', scope: SERVER }).perMinute).toBeCloseTo(2 / 60);
    at(T + 45 * MIN);
    tx.tick();
    expect(tx.report({ range: '1h', scope: SERVER }).count).toBe(1);
  });

  it('불러온 쓰기는 따로 모은다 — 1시간보다 오래된 건 안 센다', () => {
    const { tx } = setup();
    tx.record(change('insert', T - 5000, 'orders', 'live:1'));
    // 실시간 사이에 끼어든 불러오기 — 실시간 트랜잭션을 끝내지 않고, 실시간도 이걸 끝내지 않는다
    tx.record(change('insert', T - 20 * MIN, 'orders', 'old:1'), true);
    tx.record(change('insert', T - 2 * 60 * MIN, 'orders', 'older:1'), true);
    tx.record(change('insert', T - 5000, 'stock', 'live:1'));
    tx.record(change('insert', T - 20 * MIN, 'stock', 'old:1'), true);
    const r = tx.report({ range: '1h', scope: SERVER });
    expect(r).toMatchObject({ count: 2, writes: 4 });
    expect(r.combos).toEqual([{ namespaces: ['shop.orders', 'shop.stock'], more: 0, count: 2, writes: 4 }]);
  });

  it('조합이 너무 많으면 기타로 — 좁힌 범위는 partial', () => {
    const { tx, at } = setup();
    for (let i = 0; i < 205; i += 1) tx.record(change('insert', T - MIN, `c${i}`, `t:${i}`));
    at(T + 3000);
    tx.tick();
    const all = tx.report({ range: '5m', scope: SERVER });
    expect(all).toMatchObject({ count: 205, partial: false });
    const one = tx.report({ range: '5m', scope: { database: 'shop', collection: 'c204' } });
    expect(one).toMatchObject({ count: 0, partial: true });
  });
});
