import { describe, expect, it } from 'vitest';
import type { LiveLogEntry, LiveOperation } from '../../types/explorer';
import { buildItems, txnSummary, txnTotals } from './grouping';

let seq = 0;
const entry = (op: LiveOperation, collection: string, extra: Partial<LiveLogEntry> = {}): LiveLogEntry => ({
  id: `e${(seq += 1)}`,
  op,
  database: 'shop',
  collection,
  clusterTime: 0,
  serverTime: 0,
  opTime: '',
  ...extra,
});

// 최신이 앞 — 배열 순서 그대로 화면 위에서 아래
describe('buildItems', () => {
  it('같은 txn이 이어지면 한 묶음, 그 안은 기존 규칙으로', () => {
    const a = [entry('insert', 'orders', { txn: 't:1' }), entry('insert', 'orders', { txn: 't:1' }), entry('update', 'stock', { txn: 't:1', documentId: 'x' })];
    const before = entry('insert', 'orders');
    const items = buildItems([entry('insert', 'orders'), ...a, before]);
    expect(items.map((i) => i.kind)).toEqual(['group', 'txn', 'group']);
    const txn = items[1];
    expect(txn).toMatchObject({ kind: 'txn', key: `txn:${a[2].id}`, txn: 't:1' });
    if (txn.kind !== 'txn') throw new Error('txn');
    expect(txn.groups.map((g) => g.entries.length)).toEqual([2, 1]);
    // 트랜잭션이 사이에 끼면 앞뒤의 같은 컬렉션 insert도 따로
    expect(items[0].entries).toHaveLength(1);
  });

  it('쓰기 하나짜리 트랜잭션은 보통 기록처럼 이웃과 묶인다', () => {
    const items = buildItems([entry('insert', 'orders', { txn: 'a:1' }), entry('insert', 'orders', { txn: 'b:1' }), entry('insert', 'orders')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'group' });
    expect(items[0].entries).toHaveLength(3);
  });

  it('다른 트랜잭션이 연달아 오면 각각', () => {
    const items = buildItems([
      entry('insert', 'orders', { txn: 'a:2' }),
      entry('insert', 'stock', { txn: 'a:2' }),
      entry('insert', 'orders', { txn: 'a:1' }),
      entry('insert', 'stock', { txn: 'a:1' }),
    ]);
    expect(items.map((i) => (i.kind === 'txn' ? i.txn : '-'))).toEqual(['a:2', 'a:1']);
  });
});

describe('txnSummary', () => {
  it('한 DB면 컬렉션만, 쓴 차례대로 — 연산 수', () => {
    const list = [entry('delete', 'orders'), entry('replace', 'stock'), entry('update', 'stock'), entry('insert', 'orders')];
    expect(txnSummary(list)).toEqual({ where: 'shop · orders, stock', ops: '1 insert, 2 updates, 1 delete' });
  });

  it('여러 DB면 전체 이름', () => {
    const list = [entry('insert', 'users', { database: 'crm' }), entry('insert', 'orders')];
    expect(txnSummary(list).where).toBe('shop.orders, crm.users');
  });
});

describe('txnTotals', () => {
  it('트랜잭션별 개수', () => {
    const totals = txnTotals([entry('insert', 'a', { txn: 'x' }), entry('insert', 'b', { txn: 'x' }), entry('insert', 'c')]);
    expect([...totals]).toEqual([['x', 2]]);
  });
});
