import type { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { parseStartupWarnings, readStartupWarnings } from './startupWarnings';

describe('parseStartupWarnings', () => {
  it('JSON 줄은 나눠 읽고, 덧붙은 값은 글자로 — 옛 글자 로그는 앞부분을 떼고 빈 줄은 버린다', () => {
    const lines = [
      '{"t":{"$date":"2026-11-17T09:00:00.123+00:00"},"s":"W","c":"CONTROL","id":22120,"ctx":"initandlisten","msg":"Access control is not enabled for the database","tags":["startupWarnings"]}',
      '{"t":{"$date":{"$numberLong":"1789635600000"}},"s":"W","c":"CONTROL","id":22184,"msg":"Soft rlimits too low","attr":{"currentValue":1024,"recommendedMinimum":64000,"nested":{"a":1}}}',
      '2020-08-10T09:00:00.000+0000 I  CONTROL  [initandlisten] ** WARNING: Access control is not enabled for the database.',
      '2020-08-10T09:00:00.000+0000 I  CONTROL  [initandlisten] ',
      '',
    ];
    expect(parseStartupWarnings(lines)).toEqual([
      { at: Date.UTC(2026, 10, 17, 9, 0, 0, 123), severity: 'W', component: 'CONTROL', id: 22120, message: 'Access control is not enabled for the database', attr: {} },
      { at: 1789635600000, severity: 'W', component: 'CONTROL', id: 22184, message: 'Soft rlimits too low', attr: { currentValue: '1024', recommendedMinimum: '64000', nested: '{"a":1}' } },
      { at: Date.UTC(2020, 7, 10, 9), severity: 'I', component: 'CONTROL', id: null, message: '** WARNING: Access control is not enabled for the database.', attr: {} },
    ]);
  });
});

describe('readStartupWarnings', () => {
  const client = (reply: unknown) => async () =>
    ({
      db: () => ({
        command: async () => {
          if (reply instanceof Error) throw reply;
          return reply;
        },
      }),
    }) as unknown as MongoClient;
  const err = (code: number) => Object.assign(new Error(`code ${code}`), { code });

  it('읽기·권한 없음(13)·막힘(59)·실패', async () => {
    expect(await readStartupWarnings(client({ totalLinesWritten: 0, log: [], ok: 1 }), () => 5)).toEqual({ status: 'ok', error: null, at: 5, warnings: [] });
    expect((await readStartupWarnings(client(err(13)))).status).toBe('denied');
    expect((await readStartupWarnings(client(err(59)))).status).toBe('unsupported');
    expect(await readStartupWarnings(client(new Error('timed out')))).toMatchObject({ status: 'error', error: 'timed out' });
  });
});
