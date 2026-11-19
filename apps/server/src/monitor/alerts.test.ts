import type { LiveChange, LiveOperation, MonitorAlert } from '@mongolive/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Recorder } from './history';
import { createAlerts, usualOf, type AlertRules } from './alerts';

const MIN = 60_000;
// 분 경계에서 10초 앞
const T = Date.UTC(2026, 10, 18, 9, 0, 50);

let seq = 0;
const change = (op: LiveOperation, t: number, collection: string | undefined = 'orders', extra: Partial<LiveChange> = {}): LiveChange => ({
  id: String((seq += 1)),
  op,
  database: 'shop',
  collection,
  detailed: false,
  clusterTime: t,
  serverTime: t,
  opTime: '',
  ...extra,
});

const setup = (options: { rules?: Partial<AlertRules>; start?: number; settleMs?: number } = {}) => {
  let now = options.start ?? T;
  const sent: MonitorAlert[] = [];
  const alerts = createAlerts({
    connectionId: 'c1',
    recorder: () => ({}) as Recorder,
    stored: () => false,
    rules: () => ({ deletes: 1000, burst: 1000, drops: true, ...options.rules }),
    onAlert: (a) => sent.push(a),
    clock: () => now,
    settleMs: options.settleMs ?? 0,
  });
  const many = (op: LiveOperation, n: number, t: number, collection = 'orders', backfill = false) => {
    for (let i = 0; i < n; i += 1) alerts.record(change(op, t, collection), backfill);
  };
  const list = async (range: '5m' | '1h' | '24h' = '1h', scope = { database: null as string | null, collection: null as string | null }) =>
    (await alerts.report({ period: range, scope })).alerts;
  return { alerts, sent, many, list, at: (t: number) => (now = t) };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('usualOf', () => {
  it('60초 창 앞의 온전한 분들(지켜본 뒤, 최근 1시간)의 분당 평균 — 5분이 안 되면 null', () => {
    const since = T - 10 * MIN;
    const minutes = new Map<number, number>([[Date.UTC(2026, 10, 18, 8, 55), 50]]);
    // 창 시작 = 09:00:00 → 08:51 ~ 08:59의 9분(08:50:50부터 지켜봄 → 첫 온전한 분 08:51), 50 ÷ 9
    expect(usualOf(minutes, since, T)).toBe(5.6);
    expect(usualOf(minutes, T - 5 * MIN, T)).toBeNull();
  });
});

describe('mass-delete', () => {
  it('분 경계에 걸친 600 + 600도 60초 창으로 잡고, 그 뒤 삭제는 같은 건에 더한다', async () => {
    const { sent, many, list } = setup();
    many('delete', 600, T);
    many('delete', 600, T + 15_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'mass-delete', database: 'shop', collections: ['orders'], count: 1000, limit: 1000, start: T, ongoing: true, filled: false });
    const [alert] = await list();
    expect(alert).toMatchObject({ count: 1200, peak: 1200, end: T + 15_000, ongoing: true });
  });

  it('60초보다 넓게 퍼지면 안 울린다 · 한도 끔이면 안 울린다', () => {
    const spread = setup();
    spread.many('delete', 900, T);
    spread.many('delete', 900, T + 70_000);
    expect(spread.sent).toHaveLength(0);
    const off = setup({ rules: { deletes: 0 } });
    off.many('delete', 5000, T);
    expect(off.sent).toHaveLength(0);
  });

  it('5분 안에 다시 넘으면 이어 붙이고(사이 삭제도), 5분 조용하면 끝 · 그 뒤는 새 건', async () => {
    const { sent, many, list, alerts, at } = setup();
    many('delete', 1000, T);
    many('delete', 10, T + 2 * MIN);
    many('delete', 1000, T + 4 * MIN);
    expect(sent).toHaveLength(1);
    at(T + 10 * MIN);
    alerts.tick();
    expect(await list()).toMatchObject([{ count: 2010, start: T, end: T + 4 * MIN, ongoing: false }]);
    many('delete', 1000, T + 11 * MIN);
    expect(sent).toHaveLength(2);
    expect((await list()).map((a) => a.ongoing)).toEqual([true, false]);
  });
});

describe('burst', () => {
  it('평소(분당 5)의 10배 이상이면서 한도 이상 — 5분 지켜보기 전엔, 또 평소가 많으면 안 울린다', async () => {
    const start = T - 10 * MIN;
    const { sent, many, list } = setup({ start });
    // 지켜본 지 2분: 평소를 아직 모른다
    many('insert', 1000, start + 2 * MIN, 'early');
    expect(sent).toHaveLength(0);
    for (let m = 0; m < 10; m += 1) {
      many('insert', 5, start + m * MIN + 1000);
      many('insert', 200, start + m * MIN + 1000, 'busy');
    }
    many('insert', 1000, T + 5000);
    many('insert', 1000, T + 5000, 'busy');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'burst', collections: ['orders'], count: 1000, limit: 1000 });
    expect(sent[0].usual).toBeGreaterThan(4);
    expect(sent[0].usual).toBeLessThan(6);
    expect((await list()).map((a) => a.kind)).toEqual(['burst']);
  });
});

describe('drops', () => {
  it('같은 DB의 drop은 한 건, 이어서 dropDatabase면 DB 삭제로 끝낸다 — 토스트는 잠깐 기다려 한 번', async () => {
    vi.useFakeTimers();
    const { sent, alerts, list } = setup({ settleMs: 2000 });
    alerts.record(change('drop', T, 'a'));
    alerts.record(change('drop', T + 300, 'b'));
    alerts.record(change('dropDatabase', T + 600, undefined));
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    expect(sent).toMatchObject([{ kind: 'drop-database', collections: ['a', 'b'], count: 2, ongoing: false }]);
    expect(await list()).toMatchObject([{ kind: 'drop-database', end: T + 600 }]);
  });

  it('10초 넘게 떨어진 drop은 따로 · 알린 뒤 더 묶이면 한 번 더', () => {
    vi.useFakeTimers();
    const { sent, alerts, at } = setup({ settleMs: 2000 });
    alerts.record(change('drop', T, 'c2'));
    vi.advanceTimersByTime(2000);
    alerts.record(change('drop', T + 25_000, 'c3'));
    vi.advanceTimersByTime(2000);
    expect(sent.map((a) => [a.kind, a.collections])).toEqual([['drop', ['c2']], ['drop', ['c3']]]);
    // 알린 뒤 5초 만에 이어 지움 → 같은 건이 늘어난 모습으로 한 번 더
    alerts.record(change('drop', T + 30_000, 'c4'));
    vi.advanceTimersByTime(2000);
    expect(sent[2]).toMatchObject({ kind: 'drop', collections: ['c3', 'c4'], count: 2 });
    // 10초 조용하면 박자에 끝난다
    at(T + 41_000);
    alerts.tick();
    expect(sent).toHaveLength(3);
  });

  it('이름 바꾸기는 한 건씩 · 임시 컬렉션(tmp.*)과 끔은 무시', async () => {
    const { sent, alerts, list } = setup();
    alerts.record(change('rename', T, 'old', { to: { database: 'shop', collection: 'new' } }));
    alerts.record(change('rename', T, 'tmp.agg_out.1', { to: { database: 'shop', collection: 'report' } }));
    alerts.record(change('drop', T, 'tmp.mr.x'));
    expect(sent).toMatchObject([{ kind: 'rename', collections: ['old'], to: { database: 'shop', collection: 'new' } }]);
    // 컬렉션 범위: 새 이름에서도 보인다
    expect(await list('1h', { database: 'shop', collection: 'new' })).toHaveLength(1);
    expect(await list('1h', { database: 'shop', collection: 'other' })).toHaveLength(0);
    const off = setup({ rules: { drops: false } });
    off.alerts.record(change('drop', T, 'a'));
    expect(off.sent).toHaveLength(0);
  });
});

describe('빈 구간 불러오기', () => {
  it('filled로 따로 세고 토스트는 없다 — 불러오기가 멎으면 끝', async () => {
    const { sent, many, list, alerts, at } = setup();
    many('delete', 1000, T - 30 * MIN, 'orders', true);
    expect(sent).toHaveLength(0);
    expect(await list('1h')).toMatchObject([{ kind: 'mass-delete', filled: true, ongoing: true }]);
    at(T + 20_000);
    alerts.tick();
    expect(await list('1h')).toMatchObject([{ filled: true, ongoing: false }]);
    // 일어난 때(30분 전) 기준 — 최근 5분 범위엔 안 든다
    expect(await list('5m')).toHaveLength(0);
  });
});

describe('날짜로 찾기(C2)', () => {
  it('구간과 겹친 알림만 — 구간 뒤에 시작한 건 뺀다', async () => {
    const { alerts, many } = setup();
    many('delete', 1200, T);
    const scope = { database: null, collection: null };
    const before = await alerts.report({ period: { from: T - 30 * MIN, to: T - 10 * MIN }, scope });
    expect(before.alerts).toHaveLength(0);
    const over = await alerts.report({ period: { from: T - 30 * MIN, to: T + MIN }, scope });
    expect(over.alerts.map((a) => a.kind)).toEqual(['mass-delete']);
  });
});
