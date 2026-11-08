import { describe, expect, it } from 'vitest';
import { validateQueryFilter } from './queryFilter';

const int = (n: number) => ({ $numberInt: String(n) });
const oid = { $oid: '64b7f0c2a1b2c3d4e5f60718' };

const ok = (filter: unknown) => expect(validateQueryFilter(filter)).toBeNull();
const bad = (filter: unknown, path: string, message?: RegExp) => {
  const error = validateQueryFilter(filter);
  expect(error).not.toBeNull();
  expect(error!.path).toBe(path);
  if (message) expect(error!.message).toMatch(message);
};

describe('validateQueryFilter — 허용', () => {
  it('빈 쿼리와 같음 비교', () => {
    ok({});
    ok({ age: int(51) });
    ok({ name: 'kim', active: true, deletedAt: null });
    ok({ _id: oid });
    ok({ 'author.name': 'kim' });
  });

  it('비교 연산자', () => {
    ok({ age: { $gt: int(51), $lte: int(80) } });
    ok({ age: { $ne: int(51) } });
    ok({ createdAt: { $gte: { $date: { $numberLong: '0' } } } });
    ok({ tags: { $in: ['a', 'b'] }, role: { $nin: ['admin'] } });
    ok({ tags: { $all: ['a', 'b'] }, likes: { $size: int(3) } });
    ok({ age: { $mod: [int(2), int(0)] } });
  });

  it('존재·타입·정규식·부정', () => {
    ok({ email: { $exists: true } });
    ok({ email: { $exists: int(1) } });
    ok({ age: { $type: 'int' } });
    ok({ age: { $type: ['int', 'double'] } });
    ok({ name: { $regex: '^ki', $options: 'i' } });
    ok({ name: { $regularExpression: { pattern: '^ki', options: 'i' } } });
    ok({ name: { $not: { $regularExpression: { pattern: '^ki', options: '' } } } });
    ok({ age: { $not: { $gt: int(5) } } });
  });

  it('논리 연산자와 $elemMatch', () => {
    ok({ $or: [{ age: int(1) }, { age: { $gt: int(60) } }] });
    ok({ $and: [{ $nor: [{ a: int(1) }] }, { b: 'x' }] });
    ok({ scores: { $elemMatch: { $gt: int(80), $lt: int(90) } } });
    ok({ items: { $elemMatch: { name: 'pen', qty: { $gt: int(1) } } } });
    ok({ items: { $elemMatch: { $or: [{ name: 'pen' }, { name: 'ink' }] } } });
  });

  it('$expr — 집계 표현식은 통과(연산자 이름 검사는 MongoDB 몫)', () => {
    ok({ $expr: { $gt: ['$viewer', '$critic'] } });
    ok({ $or: [{ $expr: { $eq: [{ $size: '$tags' }, int(2)] } }, { a: int(1) }] });
    ok({ $expr: { $eq: ['$where', 'x'] } }); // 문자열 '$where'는 필드 경로일 뿐
  });

  it('객체 통째 비교와 DBRef', () => {
    ok({ address: { city: 'Seoul', zip: '04524' } });
    ok({ owner: { $ref: 'users', $id: oid } });
  });
});

describe('validateQueryFilter — 거절', () => {
  it('JavaScript 실행', () => {
    bad({ $where: 'sleep(10000)' }, '$where', /JavaScript/);
    bad({ $expr: { $function: { body: 'f', args: [], lang: 'js' } } }, '$expr.$function', /JavaScript/);
    bad({ $expr: { $and: [{ $gt: ['$a', int(1)] }, { $function: {} }] } }, '$expr.$and.1.$function', /JavaScript/);
    bad({ $expr: { $let: { vars: { x: { $accumulator: {} } }, in: '$$x' } } }, '$expr.$let.vars.x.$accumulator', /JavaScript/);
    bad({ $or: [{ $where: '1' }] }, '$or.0.$where', /JavaScript/);
  });

  it('옛 EJSON 형식은 연산자로 보고 거절', () => {
    bad({ data: { $binary: 'AAAA', $type: '00' } }, 'data.$binary', /Unknown operator/);
    bad({ a: { $eq: { $regex: 'x', $options: '' } } }, 'a.$eq.$regex', /inside a value/);
  });

  it('EJSON 래퍼는 값', () => {
    ok({ _id: { $in: [oid, { $oid: '64b7f0c2a1b2c3d4e5f60719' }] } });
    ok({ n: { $gte: { $numberLong: '9007199254740993' } }, d: { $numberDecimal: '1.5' } });
  });

  it('쿼리 모양이 아님', () => {
    bad([], '', /object/);
    bad('age', '', /object/);
    bad(null, '', /object/);
    bad(oid, '', /object/);
  });

  it('연산자 자리', () => {
    bad({ $gt: int(5) }, '$gt', /inside a field/);
    bad({ age: { $foo: 1 } }, 'age.$foo', /Unknown operator/);
    bad({ age: { $gt: int(5), name: 'x' } }, 'age.name', /mix/);
    bad({ address: { city: 'Seoul', $gt: int(1) } }, 'address.$gt', /inside a value/);
    bad({ age: { $eq: { $gt: int(1) } } }, 'age.$eq.$gt', /inside a value/);
  });

  it('연산자 인자', () => {
    bad({ tags: { $in: 'a' } }, 'tags.$in', /array/);
    bad({ $or: [] }, '$or', /at least one/);
    bad({ $or: [{ a: int(1) }, 'x'] }, '$or.1', /object/);
    bad({ a: { $exists: 'yes' } }, 'a.$exists');
    bad({ a: { $options: 'i' } }, 'a.$options', /\$regex/);
    bad({ a: { $not: int(5) } }, 'a.$not');
    bad({ a: { $mod: [int(2)] } }, 'a.$mod');
    bad({ a: { $size: 'three' } }, 'a.$size');
    bad({ '': int(1) }, '', /empty/);
  });

  it('너무 깊은 중첩', () => {
    let filter: unknown = { a: int(1) };
    for (let i = 0; i < 40; i++) filter = { $and: [filter] };
    expect(validateQueryFilter(filter)?.message).toMatch(/deeply/);
  });
});
