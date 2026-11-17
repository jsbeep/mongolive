import { Long, Timestamp, type MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { entryTime, fillsIn, readOplog } from './oplog';

const HOUR = 3_600_000;
const T = Date.UTC(2026, 10, 17, 9, 0, 0);

describe('fillsIn', () => {
  it('지금까지의 평균 속도로 남은 크기를 채우는 시간 — 찼거나 모르면 null', () => {
    // 10시간에 100MB → 남은 900MB는 90시간
    expect(fillsIn(T, T + 10 * HOUR, 100, 1000)).toBe(90 * HOUR);
    expect(fillsIn(T, T + 10 * HOUR, 950, 1000)).toBeNull();
    expect(fillsIn(T, T, 100, 1000)).toBeNull();
    expect(fillsIn(null, T, 100, 1000)).toBeNull();
    expect(fillsIn(T, T + HOUR, 100, null)).toBeNull();
  });
});

describe('entryTime', () => {
  it('wall(ms)이 있으면 그것, 없으면 ts의 초', () => {
    expect(entryTime({ wall: new Date(T + 123), ts: new Timestamp({ t: T / 1000, i: 1 }) })).toBe(T + 123);
    expect(entryTime({ ts: new Timestamp({ t: T / 1000, i: 1 }) })).toBe(T);
    expect(entryTime(null)).toBeNull();
  });
});

describe('readOplog', () => {
  const client = (first: unknown[], last: unknown[], stats: unknown[] | Error) =>
    async () =>
      ({
        db: () => ({
          collection: () => ({
            find: (_f: unknown, opts: { sort: { $natural: number } }) => ({ toArray: async () => (opts.sort.$natural === 1 ? first : last) }),
            aggregate: () => ({
              toArray: async () => {
                if (stats instanceof Error) throw stats;
                return stats;
              },
            }),
          }),
        }),
      }) as unknown as MongoClient;
  const err = (code: number) => Object.assign(new Error(`code ${code}`), { code });

  it('창·크기·찰 때까지 — Long도 읽는다', async () => {
    const report = await readOplog(
      client([{ wall: new Date(T - 10 * HOUR) }], [{ wall: new Date(T) }], [{ storageStats: { size: Long.fromNumber(100), maxSize: Long.fromNumber(1000) } }]),
      () => T,
    );
    expect(report).toEqual({ status: 'ok', error: null, at: T, first: T - 10 * HOUR, last: T, usedBytes: 100, maxBytes: 1000, full: false, fillsInMs: 90 * HOUR });
  });

  it('standalone(없음 26)·권한 없음(13)·그 밖의 실패', async () => {
    expect((await readOplog(client([], [], err(26)))).status).toBe('none');
    expect((await readOplog(client([], [], err(13)))).status).toBe('denied');
    expect(await readOplog(client([], [], new Error('timed out')))).toMatchObject({ status: 'error', error: 'timed out', first: null });
    // 컬렉션도 크기도 없음
    expect((await readOplog(client([], [], []))).status).toBe('none');
  });
});
