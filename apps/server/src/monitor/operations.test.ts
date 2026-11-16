import { Int32, Long, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { describeCommand, inScope, kindOf, toRunningOp } from './operations';

// promoteValues: false로 받은 $currentOp 한 줄의 모양
const op = (over: Record<string, unknown> = {}) => ({
  opid: new Int32(4242),
  op: 'query',
  ns: 'shop.orders',
  active: true,
  microsecs_running: Long.fromNumber(2_500_000),
  secs_running: Long.fromNumber(2),
  client: '10.0.0.5:51234',
  appName: 'report-job',
  currentOpTime: '2026-11-16T10:00:00.000+09:00',
  effectiveUsers: [{ user: 'app', db: 'admin' }],
  numYields: new Int32(7),
  planSummary: 'COLLSCAN',
  command: { find: 'orders', filter: { status: 'paid', userId: new ObjectId('64b7f0c2a1b2c3d4e5f60718') }, sort: { createdAt: new Int32(-1) }, lsid: { id: 'x' }, $db: 'shop' },
  ...over,
});

describe('describeCommand', () => {
  it('find — 필터·정렬을 mongosh 표기로', () => {
    expect(toRunningOp(op()).summary).toBe('find { status: "paid", userId: ObjectId("64b7f0c2a1b2c3d4e5f60718") } sort { createdAt: -1 }');
  });

  it('aggregate — 첫 $match만 내용, 나머지는 스테이지 이름', () => {
    expect(describeCommand({ aggregate: 'orders', pipeline: [{ $match: { a: { $numberInt: '1' } } }, { $group: { _id: '$b' } }, { $sort: { n: { $numberInt: '-1' } } }] }))
      .toBe('aggregate $match { a: 1 } → $group → $sort');
  });

  it('update/delete — 첫 문장 + 몇 개 더', () => {
    expect(describeCommand({ update: 'c', updates: [{ q: { x: true } }, { q: {} }] })).toBe('update { x: true } +1 more');
    expect(describeCommand({ delete: 'c', deletes: [{ q: {} }] })).toBe('delete {}');
  });

  it('MongoDB가 줄인 명령은 그 글자 그대로', () => {
    expect(describeCommand({ $truncated: '{ find: "big", filter: { ... } }' })).toBe('{ find: "big", filter: { ... } }');
  });

  it('getMore는 처음 명령 기준', () => {
    const row = toRunningOp(op({ op: 'getmore', command: { getMore: Long.fromNumber(1), collection: 'orders' }, originatingCommand: { aggregate: 'orders', pipeline: [{ $changeStream: {} }] } }));
    expect(row.summary).toBe('getMore · aggregate $changeStream');
  });
});

describe('toRunningOp', () => {
  it('숫자 타입을 풀고 세션 정보는 뺀다', () => {
    const row = toRunningOp(op());
    expect(row).toMatchObject({ opid: '4242', ms: 2500, yields: 7, user: 'app', kind: 'user', planSummary: 'COLLSCAN', waitingForLock: false });
    expect(row.startedAt).toBe(Date.parse('2026-11-16T01:00:00.000Z') - 2500);
    expect(Object.keys(row.command!)).toEqual(['find', 'filter', 'sort']);
  });

  it('샤드 opid는 글자 그대로', () => {
    expect(toRunningOp(op({ opid: 'shard01:123' })).opid).toBe('shard01:123');
  });
});

describe('kindOf', () => {
  it('이 앱 / 내부 스레드 / 복제 / 그 밖', () => {
    expect(kindOf(op({ appName: 'mongolive' }))).toBe('mongolive');
    expect(kindOf(op({ client: undefined, appName: undefined }))).toBe('system');
    expect(kindOf(op({ ns: 'local.oplog.rs', op: 'getmore' }))).toBe('system');
    expect(kindOf(op({ op: 'command', ns: 'admin.$cmd', command: { hello: new Int32(1), maxAwaitTimeMS: new Int32(10000), topologyVersion: {} } }))).toBe('system');
    expect(kindOf(op({ op: 'command', ns: 'admin.$cmd', command: { hello: new Int32(1) } }))).toBe('user');
    expect(kindOf(op())).toBe('user');
  });
});

describe('inScope', () => {
  it('DB는 접두어, 컬렉션은 정확히', () => {
    expect(inScope('shop.orders', { database: null, collection: null })).toBe(true);
    expect(inScope('shop.orders', { database: 'shop', collection: null })).toBe(true);
    expect(inScope('shopx.orders', { database: 'shop', collection: null })).toBe(false);
    expect(inScope('shop.$cmd', { database: 'shop', collection: 'orders' })).toBe(false);
    expect(inScope(null, { database: 'shop', collection: null })).toBe(false);
  });
});
