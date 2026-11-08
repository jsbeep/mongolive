import { describe, expect, it } from 'vitest';
import { BSON, MongoNetworkError, MongoServerError } from 'mongodb';
import { HttpError } from './names';
import { toQueryHttpError, toValueHttpError } from './queryErrors';

// 실제 서버가 돌려주는 오류 모양을 흉내 낸다(코드·이름은 실제 MongoDB 7에서 확인한 값).
// 이 앱은 promoteValues: false로 조회해서 code가 number가 아니라 Int32로 온다 — 둘 다 확인한다
const serverError = (code: number, codeName: string, errmsg: string, asInt32 = true) =>
  new MongoServerError({ ok: 0, code: (asInt32 ? new BSON.Int32(code) : code) as never, codeName, errmsg, message: errmsg });

const asHttp = (e: unknown) => {
  expect(e).toBeInstanceOf(HttpError);
  return e as HttpError;
};

describe('toQueryHttpError — 쿼리를 고치면 되는 오류는 400', () => {
  it('시간 초과(50) → timeout 메시지', () => {
    const e = asHttp(toQueryHttpError(serverError(50, 'MaxTimeMSExpired', 'operation exceeded time limit'), 5000));
    expect(e.status).toBe(400);
    expect(e.message).toBe('Query took longer than 5s — narrow it down');
    expect(e.body).toEqual({ reason: 'timeout' });
  });

  it('code가 plain number여도 같다(promoteValues 기본값으로 조회한 경우)', () => {
    expect(asHttp(toQueryHttpError(serverError(50, 'MaxTimeMSExpired', 'x', false), 5000)).body).toEqual({ reason: 'timeout' });
    expect(asHttp(toQueryHttpError(serverError(2, 'BadValue', 'x', false), 5000)).status).toBe(400);
  });

  it.each([
    [2, 'BadValue', 'unknown operator: $foo'],
    [14, 'TypeMismatch', '$add only supports numeric or date types, not string'],
    [168, 'InvalidPipelineOperator', "Unrecognized expression '$nope'"],
    [51091, 'Location51091', 'Regular expression is invalid: missing closing parenthesis'],
  ])('%i %s → 400 + MongoDB 메시지', (code, codeName, errmsg) => {
    const e = asHttp(toQueryHttpError(serverError(code, codeName, errmsg), 5000));
    expect(e.status).toBe(400);
    expect(e.message).toBe(`Query failed: ${errmsg}`);
  });
});

describe('toQueryHttpError — 입력 탓이 아닌 오류는 그대로(→ 500)', () => {
  it.each([
    [13, 'Unauthorized', 'not authorized on db to execute command'],
    [18, 'AuthenticationFailed', 'Authentication failed.'],
    [189, 'PrimarySteppedDown', 'primary stepped down'],
    [11600, 'InterruptedAtShutdown', 'interrupted at shutdown'],
  ])('%i %s', (code, codeName, errmsg) => {
    const original = serverError(code, codeName, errmsg);
    expect(toQueryHttpError(original, 5000)).toBe(original);
  });

  it('연결 오류·일반 오류', () => {
    const network = new MongoNetworkError('connection reset');
    expect(toQueryHttpError(network, 5000)).toBe(network);
    const plain = new Error('boom');
    expect(toQueryHttpError(plain, 5000)).toBe(plain);
  });
});

describe('toValueHttpError — EJSON 값 변환 실패', () => {
  const des = (v: unknown) => BSON.EJSON.deserialize({ v } as never, { relaxed: false });
  const caught = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    throw new Error('did not throw');
  };

  it('잘못된 $oid / $date → 400', () => {
    expect(asHttp(toValueHttpError(caught(() => des({ $oid: 'zzz' })))).status).toBe(400);
    expect(asHttp(toValueHttpError(caught(() => des({ $date: { $numberLong: 'abc' } })))).status).toBe(400);
  });

  it('다른 오류는 그대로', () => {
    const plain = new Error('boom');
    expect(toValueHttpError(plain)).toBe(plain);
  });
});
