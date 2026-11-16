import { describe, expect, it } from 'vitest';
import type { MongoClient } from 'mongodb';
import type { Recorder } from './history';
import { addToBucket, bandOf, createSlowLog, parseSlowLine, summarize, type SlowBucketLine, type SlowEntry, type SlowLine } from './slowQueries';

// MongoDB 7.0이 실제로 남긴 줄(테스트 컨테이너에서 받은 것, locks 등은 줄임)
const line = (t: string, c: 'COMMAND' | 'WRITE', ctx: string, attr: Record<string, unknown>) =>
  JSON.stringify({ t: { $date: t }, s: 'I', c, id: 51803, ctx, msg: 'Slow query', attr });

const FIND = line('2026-11-16T15:01:55.747+00:00', 'COMMAND', 'conn15', {
  type: 'command',
  ns: 'shop.orders',
  appName: 'mongosh 2.8.3',
  command: { find: 'orders', filter: { $where: 'sleep(120)||true', s: 'x' }, sort: { a: -1 }, limit: 5, lsid: { id: { $uuid: 'e7d0ad15-1b29-47b9-b440-9b57ec9dbb71' } }, $db: 'shop' },
  planSummary: 'COLLSCAN',
  keysExamined: 0,
  docsExamined: 3,
  nreturned: 1,
  queryHash: '16EED7F8',
  remote: '127.0.0.1:60218',
  durationMillis: 121,
});
const UPDATE_WRITE = line('2026-11-16T15:01:56.487+00:00', 'WRITE', 'conn15', {
  type: 'update',
  ns: 'shop.orders',
  appName: 'mongosh 2.8.3',
  command: { q: { $where: 'sleep(120)||true' }, u: { $set: { b: 1 } }, multi: true, upsert: false },
  planSummary: 'COLLSCAN',
  keysExamined: 0,
  docsExamined: 3,
  nMatched: 3,
  nModified: 3,
  remote: '127.0.0.1:60218',
  durationMillis: 362,
});
const UPDATE_COMMAND = line('2026-11-16T15:01:56.488+00:00', 'COMMAND', 'conn15', {
  type: 'command',
  ns: 'shop.$cmd',
  appName: 'mongosh 2.8.3',
  command: { update: 'orders', updates: [{ q: { $where: 'sleep(120)||true' }, u: { $set: { b: 1 } }, multi: true }], ordered: true, $db: 'shop' },
  remote: '127.0.0.1:60218',
  durationMillis: 362,
});
const REMOVE_WRITE = line('2026-11-16T15:01:57.242+00:00', 'WRITE', 'conn15', {
  type: 'remove',
  ns: 'shop.orders',
  command: { q: { $where: 'sleep(150)||true', a: 3 }, limit: 1 },
  planSummary: 'COLLSCAN',
  docsExamined: 3,
  ndeleted: 1,
  remote: '127.0.0.1:60218',
  durationMillis: 171,
});

const at = (iso: string) => Date.parse(iso);

describe('parseSlowLine', () => {
  it('reads a slow find — summary, plan, counts, no session noise', () => {
    const e = parseSlowLine(FIND, new Map()) as SlowEntry;
    expect(e).toMatchObject({ op: 'find', ns: 'shop.orders', kind: 'user', queryHash: '16EED7F8', plan: 'COLLSCAN', docsExamined: 3, returned: 1, ms: 121 });
    expect(e.at).toBe(at('2026-11-16T15:01:55.747Z'));
    expect(e.summary).toBe('find { $where: "sleep(120)||true", s: "x" } sort { a: -1 } limit 5');
    expect(Object.keys(e.command ?? {})).toEqual(['find', 'filter', 'sort', 'limit']);
    expect(e.key).toBe('user|shop.orders|find|16EED7F8');
  });

  it('counts an update once — the WRITE line, not the COMMAND line after it', () => {
    const writes = new Map<string, number>();
    const w = parseSlowLine(UPDATE_WRITE, writes) as SlowEntry;
    expect(parseSlowLine(UPDATE_COMMAND, writes)).toBeNull();
    expect(w).toMatchObject({ op: 'update', ns: 'shop.orders', returned: 3, plan: 'COLLSCAN' });
    expect(w.summary).toBe('update { $where: "sleep(120)||true" }');
    expect(w.key.startsWith('user|shop.orders|update|s')).toBe(true);
  });

  it('keeps an update COMMAND line with no WRITE line (a batch slow overall) under its collection', () => {
    const e = parseSlowLine(UPDATE_COMMAND, new Map()) as SlowEntry;
    expect(e).toMatchObject({ op: 'update', ns: 'shop.orders' });
  });

  it('names remove lines delete and uses ndeleted', () => {
    const e = parseSlowLine(REMOVE_WRITE, new Map()) as SlowEntry;
    expect(e).toMatchObject({ op: 'delete', returned: 1, kind: 'user' });
    expect(e.summary).toBe('delete { $where: "sleep(150)||true", a: 3 }');
  });

  it('describes getMore by the command that opened the cursor', () => {
    const e = parseSlowLine(
      line('2026-11-16T15:02:00.000+00:00', 'COMMAND', 'conn3', {
        type: 'command',
        ns: 'shop.orders',
        command: { getMore: 123, collection: 'orders' },
        originatingCommand: { find: 'orders', filter: { s: 'x' } },
        remote: '1.2.3.4:5',
        durationMillis: 300,
      }),
      new Map(),
    ) as SlowEntry;
    expect(e.op).toBe('getMore');
    expect(e.summary).toBe('getMore · find { s: "x" }');
  });

  it('sorts out mongolive’s own and internal work', () => {
    const own = line('2026-11-16T15:02:00.000+00:00', 'COMMAND', 'c1', { ns: 'admin.$cmd', appName: 'mongolive', command: { getLog: 'global' }, remote: 'x:1', durationMillis: 150 });
    const ttl = line('2026-11-16T15:02:00.000+00:00', 'WRITE', 'TTLMonitor', { type: 'remove', ns: 'app.sessions', command: { q: {} }, durationMillis: 150 });
    expect(parseSlowLine(own, new Map())?.kind).toBe('mongolive');
    expect(parseSlowLine(ttl, new Map())?.kind).toBe('system');
  });

  it('groups commands without a queryHash by shape — values and $in length don’t matter', () => {
    const cmd = (filter: unknown) =>
      parseSlowLine(line('2026-11-16T15:02:00.000+00:00', 'COMMAND', 'c', { ns: 'a.b', command: { count: 'b', query: filter }, remote: 'x:1', durationMillis: 200 }), new Map())?.key;
    expect(cmd({ a: 1, b: { $in: [1, 2] } })).toBe(cmd({ a: 7, b: { $in: [3, 4, 5] } }));
    expect(cmd({ a: 1 })).not.toBe(cmd({ c: 1 }));
  });

  it('skips drivers’ awaitable hello — waiting, not work', () => {
    const wait = line('2026-11-16T15:02:00.000+00:00', 'COMMAND', 'c1', { ns: 'admin.$cmd', appName: 'app', command: { hello: 1, maxAwaitTimeMS: 10000, topologyVersion: {} }, remote: 'x:1', durationMillis: 686 });
    const handshake = line('2026-11-16T15:02:00.000+00:00', 'COMMAND', 'c1', { ns: 'admin.$cmd', appName: 'app', command: { hello: 1 }, remote: 'x:1', durationMillis: 150 });
    expect(parseSlowLine(wait, new Map())).toBeNull();
    expect(parseSlowLine(handshake, new Map())?.kind).toBe('system');
  });

  it('ignores other log lines', () => {
    expect(parseSlowLine('{"t":{"$date":"2026-11-16T15:02:00.000+00:00"},"id":22943,"msg":"Connection accepted"}', new Map())).toBeNull();
  });
});

const entry = (ms: number, atMs: number, over: Partial<SlowEntry> = {}): SlowEntry => ({
  key: 'user|shop.orders|find|H1',
  kind: 'user',
  ns: 'shop.orders',
  op: 'find',
  queryHash: 'H1',
  at: atMs,
  ms,
  app: 'app',
  client: '1.2.3.4:5',
  plan: 'COLLSCAN',
  docsExamined: 100,
  keysExamined: 0,
  returned: 1,
  summary: `find ${ms}`,
  command: { find: 'orders' },
  ...over,
});

describe('buckets and summary', () => {
  const T0 = at('2026-11-16T15:00:00.000Z');
  const scope = { database: null, collection: null };

  it('bands match the filter chips', () => {
    expect([50, 100, 499, 500, 999, 1000, 4999, 5000].map(bandOf)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
  });

  it('filters by the chip exactly and keeps the slowest run as the summary', () => {
    const buckets = new Map<string, SlowBucketLine>();
    for (const e of [entry(150, T0 + 1000), entry(700, T0 + 2000), entry(6000, T0 + 3000), entry(120, T0 + 61_000)]) addToBucket(buckets, e);
    const lines = [...buckets.values()];
    const all = summarize(lines, { from: null, scope, min: 100 });
    expect(all.groups).toHaveLength(1);
    expect(all.groups[0]).toMatchObject({ count: 4, totalMs: 6970, maxMs: 6000, summary: 'find 6000', docsExamined: 400, last: T0 + 61_000 });
    // 분마다·구간마다 가장 느린 것 하나씩, 최근 것부터
    expect(all.groups[0].runs.map((r) => r.ms)).toEqual([120, 6000, 700, 150]);
    const half = summarize(lines, { from: null, scope, min: 500 });
    expect(half.groups[0]).toMatchObject({ count: 2, totalMs: 6700 });
    expect(half.hidden).toBe(2);
    expect(summarize(lines, { from: null, scope, min: 5000 }).groups[0].count).toBe(1);
  });

  it('applies the time range and the scope', () => {
    const buckets = new Map<string, SlowBucketLine>();
    addToBucket(buckets, entry(200, T0));
    addToBucket(buckets, entry(200, T0 + 600_000, { key: 'user|blog.posts|find|H2', ns: 'blog.posts' }));
    const lines = [...buckets.values()];
    expect(summarize(lines, { from: T0 + 300_000, scope, min: 100 }).groups.map((g) => g.ns)).toEqual(['blog.posts']);
    expect(summarize(lines, { from: null, scope: { database: 'shop', collection: null }, min: 100 }).groups.map((g) => g.ns)).toEqual(['shop.orders']);
  });

  it('merges back-to-back missed stretches', () => {
    const missed: SlowLine[] = [
      { t: T0 + 600_000, from: T0, missed: 500 },
      { t: T0 + 1_200_000, from: T0 + 610_000, missed: 300 },
      { t: T0 + 9_000_000, from: T0 + 8_000_000, missed: 10 },
    ];
    expect(summarize(missed, { from: null, scope, min: 100 }).missed).toEqual([
      { from: T0, to: T0 + 1_200_000, lines: 800 },
      { from: T0 + 8_000_000, to: T0 + 9_000_000, lines: 10 },
    ]);
  });
});

// getLog 응답을 차례로 돌려주는 가짜 클라이언트 + 줄만 모으는 가짜 기록기
const harness = (opts: { stored?: boolean; cursor?: number | null } = {}) => {
  let now = at('2026-11-16T15:01:58.000Z');
  const responses: unknown[] = [];
  const appended: { lines: { t: number }[]; cursor: number | null }[] = [];
  const client = {
    db: () => ({
      command: async (cmd: Record<string, unknown>) => {
        if ('profile' in cmd) return { was: 0, slowms: 100 };
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    }),
  } as unknown as MongoClient;
  const recorder = {
    slowCursor: async () => opts.cursor ?? null,
    appendSlow: async (lines: { t: number }[], cursor: number | null) => {
      appended.push({ lines, cursor });
    },
    currentFingerprint: () => null,
  } as unknown as Recorder;
  const slow = createSlowLog({ connectionId: 'test', client: async () => client, recorder: () => recorder, stored: () => opts.stored ?? true, clock: () => now });
  return {
    slow,
    appended,
    respond: (...r: unknown[]) => responses.push(...r),
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const filler = (n: number, iso = '2026-11-16T15:02:30.000+00:00') =>
  Array.from({ length: n }, (_, i) => `{"t":{"$date":"${iso}"},"s":"I","c":"NETWORK","id":22943,"ctx":"listener","msg":"Connection accepted","attr":{"n":${i}}}`);

describe('createSlowLog', () => {
  it('writes finished minutes only, once, and after the cursor from last time', async () => {
    const h = harness({ cursor: at('2026-11-16T15:01:55.800Z') });
    // 처음: 지난번에 적은 find(커서 앞)는 건너뛰고 update만
    h.respond({ totalLinesWritten: 3, log: [FIND, UPDATE_WRITE, UPDATE_COMMAND] });
    await h.slow.poll();
    expect(h.appended).toEqual([]); // 15:01 분이 아직 안 끝남
    h.advance(10_000); // 15:02:08 — 15:01 분이 끝났다
    h.respond({ totalLinesWritten: 4, log: [FIND, UPDATE_WRITE, UPDATE_COMMAND, REMOVE_WRITE] });
    await h.slow.poll();
    expect(h.appended).toHaveLength(1);
    const ops = h.appended[0].lines.map((l) => (l as SlowBucketLine).op).sort();
    expect(ops).toEqual(['delete', 'update']);
    expect(h.appended[0].cursor).toBe(at('2026-11-16T15:01:57.242Z'));
  });

  it('marks a missed stretch when the log moved past what one read returns', async () => {
    const h = harness({ stored: false });
    h.respond({ totalLinesWritten: 100, log: filler(3, '2026-11-16T15:01:50.000+00:00') });
    await h.slow.poll();
    h.advance(10_000);
    h.respond({ totalLinesWritten: 2100, log: filler(1000) });
    await h.slow.poll();
    h.advance(10_000);
    h.respond({ totalLinesWritten: 2101, log: [...filler(999), REMOVE_WRITE.replace('15:01:57.242', '15:02:17.000')] });
    await h.slow.poll();
    const report = await h.slow.report({ range: '1h', scope: { database: null, collection: null }, min: 100 });
    expect(report.missed).toEqual([{ from: at('2026-11-16T15:01:50.000Z'), to: at('2026-11-16T15:02:30.000Z'), lines: 1000 }]);
    // 메모리 모드 — 아직 안 끝난 분의 줄도 보인다
    expect(report.groups.map((g) => g.op)).toEqual(['delete']);
    expect(report.slowms).toBe(100);
    expect(report.stored).toBe(false);
  });

  it('reports denied and unsupported servers without throwing', async () => {
    const h = harness();
    h.respond(Object.assign(new Error('not authorized'), { code: 13 }));
    await h.slow.poll();
    expect((await h.slow.report({ range: '1h', scope: { database: null, collection: null }, min: 100 })).status).toBe('denied');
    const old = harness();
    old.respond({ totalLinesWritten: 1, log: ['Mon Nov 16 15:00:00.000 I COMMAND [conn1] command shop.orders ... 300ms'] });
    await old.slow.poll();
    expect((await old.slow.report({ range: '1h', scope: { database: null, collection: null }, min: 100 })).status).toBe('unsupported');
  });

  it('stop writes the unfinished minute too', async () => {
    const h = harness();
    h.respond({ totalLinesWritten: 1, log: [FIND] });
    await h.slow.poll();
    await h.slow.stop();
    expect(h.appended).toHaveLength(1);
    expect((h.appended[0].lines[0] as SlowBucketLine).op).toBe('find');
  });
});
