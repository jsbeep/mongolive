import { describe, expect, it } from 'vitest';
import {
  addCondition,
  parseValueList,
  readTextMatch,
  textMatchRegex,
  valueListText,
  containsRegex,
  containsText,
  describeFilter,
  formatQueryText,
  parseConditionValue,
  removeCondition,
  conditionValueText,
  fieldPaths,
  referenceKeyCandidates,
} from './queryConditions';
import { parseQueryText } from './queryParser';
import type { EjsonObject } from './ejson';

const int = (n: number) => ({ $numberInt: String(n) });
const oid = { $oid: '64b7f0c2a1b2c3d4e5f60718' };
const date = { $date: { $numberLong: String(Date.UTC(2024, 0, 31, 9)) } };

const roundTrip = (filter: EjsonObject) => {
  const text = formatQueryText(filter);
  const parsed = parseQueryText(text);
  if (!parsed.ok) throw new Error(`${text} → ${parsed.error.message}`);
  expect(parsed.filter).toEqual(filter);
  return text;
};

describe('formatQueryText — 다시 읽으면 같은 쿼리', () => {
  it('짧으면 한 줄, mongosh 모양', () => {
    expect(roundTrip({ age: { $gt: int(51) } })).toBe('{ age: { $gt: 51 } }');
    expect(roundTrip({ _id: oid })).toBe('{ _id: ObjectId("64b7f0c2a1b2c3d4e5f60718") }');
    expect(roundTrip({ 'author.name': 'kim' })).toBe('{ "author.name": "kim" }');
    expect(roundTrip({})).toBe('{}');
  });

  it('길면 조건마다 한 줄', () => {
    const text = roundTrip({ title: 'a fairly long title here', createdAt: { $gte: date }, tags: ['x', 'y'] });
    expect(text.split('\n')).toHaveLength(5);
  });

  it('숫자·날짜·정규식·그 밖의 BSON', () => {
    roundTrip({
      i: int(-3),
      d: { $numberDouble: '5.0' },
      e: { $numberDouble: '1.5e+300' },
      n: { $numberDouble: 'NaN' },
      l: { $numberLong: '9007199254740993' },
      m: { $numberDecimal: '1.10' },
      at: date,
      r: { $regularExpression: { pattern: '^ki[a-z]+$', options: 'i' } },
      slash: { $regularExpression: { pattern: 'a/b', options: '' } },
      bin: { $binary: { base64: 'AAAA', subType: '00' } },
      t: true,
      z: null,
      q: 'say "hi"\n',
      $or: [{ a: int(1) }, { b: { $exists: false } }],
    });
  });
});

describe('describeFilter — 칩으로 뽑기', () => {
  it('단순 조건', () => {
    expect(describeFilter({ age: { $gt: int(40), $lt: int(60) }, name: 'kim', email: { $exists: true } })).toEqual([
      { kind: 'condition', field: 'age', op: 'gt', value: int(40) },
      { kind: 'condition', field: 'age', op: 'lt', value: int(60) },
      { kind: 'condition', field: 'name', op: 'eq', value: 'kim' },
      { kind: 'condition', field: 'email', op: 'exists', value: true },
    ]);
  });

  it('정규식(리터럴·$regex 둘 다)', () => {
    const r = { $regularExpression: { pattern: 'ki', options: 'i' } };
    expect(describeFilter({ a: r, b: { $regex: 'ki', $options: 'i' } })).toEqual([
      { kind: 'condition', field: 'a', op: 'regex', value: r },
      { kind: 'condition', field: 'b', op: 'regex', value: r },
    ]);
  });

  it('in / not in / type', () => {
    expect(describeFilter({ tags: { $in: ['x', 'y'] }, role: { $nin: ['admin'] }, age: { $type: 'number' } })).toEqual([
      { kind: 'condition', field: 'tags', op: 'in', value: ['x', 'y'] },
      { kind: 'condition', field: 'role', op: 'nin', value: ['admin'] },
      { kind: 'condition', field: 'age', op: 'type', value: 'number' },
    ]);
  });

  it('칩으로 못 나타내는 건 custom', () => {
    expect(describeFilter({ $or: [{ a: int(1) }], tags: { $all: ['x'] }, n: { $exists: int(1) }, t: { $type: int(2) } })).toEqual([
      { kind: 'custom', field: '$or' },
      { kind: 'custom', field: 'tags' },
      { kind: 'custom', field: 'n' },
      { kind: 'custom', field: 't' },
    ]);
  });
});

describe('addCondition / removeCondition — 같은 필드 규칙', () => {
  it('다른 연산자는 합쳐 범위로', () => {
    const f = addCondition(addCondition({}, { field: 'age', op: 'gt', value: int(40) }), { field: 'age', op: 'lt', value: int(60) });
    expect(f).toEqual({ age: { $gt: int(40), $lt: int(60) } });
  });

  it('같은 연산자는 값만', () => {
    expect(addCondition({ age: { $gt: int(40) } }, { field: 'age', op: 'gt', value: int(45) })).toEqual({ age: { $gt: int(45) } });
  });

  it('= 은 그 필드를 대신하고, = 뒤의 비교는 = 를 대신한다', () => {
    expect(addCondition({ age: { $gt: int(40), $lt: int(60) } }, { field: 'age', op: 'eq', value: int(51) })).toEqual({ age: int(51) });
    expect(addCondition({ age: int(51) }, { field: 'age', op: 'ne', value: int(3) })).toEqual({ age: { $ne: int(3) } });
  });

  it('다른 필드는 AND로 쌓이고 순서는 유지', () => {
    const f = addCondition({ a: int(1), b: int(2) }, { field: 'a', op: 'gt', value: int(0) });
    expect(Object.keys(f)).toEqual(['a', 'b']);
    expect(addCondition(f, { field: 'c', op: 'exists', value: true })).toEqual({ a: { $gt: int(0) }, b: int(2), c: { $exists: true } });
  });

  it('빼기 — 연산자 하나만, 마지막이면 필드째', () => {
    const f = { age: { $gt: int(40), $lt: int(60) }, name: 'kim' };
    expect(removeCondition(f, 'age', 'gt')).toEqual({ age: { $lt: int(60) }, name: 'kim' });
    expect(removeCondition(removeCondition(f, 'age', 'gt'), 'age', 'lt')).toEqual({ name: 'kim' });
    expect(removeCondition(f, 'name', 'eq')).toEqual({ age: { $gt: int(40), $lt: int(60) } });
    expect(removeCondition({ $or: [] }, '$or')).toEqual({});
  });

  it('원래 객체는 그대로', () => {
    const f = { age: { $gt: int(40) } };
    addCondition(f, { field: 'age', op: 'lt', value: int(9) });
    removeCondition(f, 'age', 'gt');
    expect(f).toEqual({ age: { $gt: int(40) } });
  });
});

describe('parseConditionValue — 빌더 값 입력', () => {
  const auto = (text: string) => {
    const r = parseConditionValue(text);
    if (!r.ok) throw new Error(r.message);
    return r.value;
  };
  it('auto', () => {
    expect(auto('51')).toEqual(int(51));
    expect(auto('1.5')).toEqual({ $numberDouble: '1.5' });
    expect(auto('true')).toBe(true);
    expect(auto('null')).toBeNull();
    expect(auto('64B7F0C2A1B2C3D4E5F60718')).toEqual(oid);
    expect(auto('2024-01-31T09:00:00Z')).toEqual(date);
    expect(auto('"51"')).toBe('51');
    expect(auto('kim lee')).toBe('kim lee');
  });
  it('종류 지정', () => {
    expect(parseConditionValue('51', 'string')).toEqual({ ok: true, value: '51' });
    expect(parseConditionValue('abc', 'number').ok).toBe(false);
    expect(parseConditionValue('123', 'oid').ok).toBe(false);
    expect(parseConditionValue('yes', 'boolean').ok).toBe(false);
  });
});

describe('contains', () => {
  it('특수문자는 글자 그대로, 다시 알아본다', () => {
    const r = containsRegex('a.b (c)/d');
    expect(r).toEqual({ $regularExpression: { pattern: 'a\\.b \\(c\\)/d', options: 'i' } });
    expect(containsText(r)).toBe('a.b (c)/d');
    expect(containsText({ $regularExpression: { pattern: '^ki', options: 'i' } })).toBeNull();
  });
});

describe('conditionValueText / fieldPaths', () => {
  it('값 → 입력 글자', () => {
    expect(conditionValueText(int(51))).toEqual({ text: '51', kind: 'number' });
    expect(conditionValueText(oid)).toEqual({ text: '64b7f0c2a1b2c3d4e5f60718', kind: 'oid' });
    expect(conditionValueText(date)).toEqual({ text: '2024-01-31T09:00:00.000Z', kind: 'date' });
    expect(conditionValueText('kim')).toEqual({ text: 'kim', kind: 'string' });
    expect(conditionValueText({ a: int(1) })).toBeNull();
    // 다시 읽으면 같은 값
    for (const v of [int(51), oid, date, 'kim', true, null]) {
      const t = conditionValueText(v)!;
      expect(parseConditionValue(t.text, t.kind)).toEqual({ ok: true, value: v });
    }
  });

  it('문서 → 경로(배열은 원소 안으로, 래퍼는 끝)', () => {
    expect(fieldPaths({ _id: oid, name: 'a', author: { name: 'k', at: date }, items: [{ sku: 'x' }, { qty: int(1) }], tags: ['a'] })).toEqual([
      '_id', 'name', 'author', 'author.name', 'author.at', 'items', 'items.sku', 'items.qty', 'tags',
    ]);
  });
});

describe('글자 맞추기(정규식)', () => {
  const regex = (pattern: string, options = 'i') => ({ $regularExpression: { pattern, options } });
  it('만들기', () => {
    expect(textMatchRegex({ mode: 'startsWith', text: 'a.b' })).toEqual(regex('^a\\.b'));
    expect(textMatchRegex({ mode: 'endsWith', text: '$5' })).toEqual(regex('\\$5$'));
    expect(textMatchRegex({ mode: 'length', length: 5 })).toEqual(regex('^[\\s\\S]{5}$', ''));
  });
  it('다시 알아보기 — 만든 모양만', () => {
    for (const m of [
      { mode: 'contains', text: 'kim (x)' },
      { mode: 'startsWith', text: '^up' },
      { mode: 'endsWith', text: 'end$' },
      { mode: 'length', length: 12 },
    ] as const) {
      expect(readTextMatch(textMatchRegex(m))).toEqual(m);
    }
    expect(readTextMatch(regex('^ki[a-z]'))).toBeNull();
    expect(readTextMatch(regex('^kim$'))).toBeNull();
    expect(readTextMatch(regex('kim', ''))).toBeNull();
  });
  it('텍스트로 쓰고 다시 읽어도 같다', () => {
    roundTrip({ a: textMatchRegex({ mode: 'length', length: 3 }), b: textMatchRegex({ mode: 'endsWith', text: 'x/y' }) });
  });
});

describe('여러 값(in)', () => {
  it('쉼표로 나누고 따옴표 안의 쉼표는 지킨다', () => {
    expect(parseValueList('draft, review, 3')).toEqual({ ok: true, value: ['draft', 'review', int(3)] });
    expect(parseValueList('"a,b", \'c\'')).toEqual({ ok: true, value: ['a,b', 'c'] });
    expect(parseValueList('1, 2', 'string')).toEqual({ ok: true, value: ['1', '2'] });
    expect(parseValueList(' , ').ok).toBe(false);
    expect(parseValueList('1, x', 'number').ok).toBe(false);
  });
  it('값 배열 → 글자 → 같은 값', () => {
    for (const values of [['draft', 'a,b'], [int(1), int(2)], [oid, oid], ['x', int(1)]]) {
      const t = valueListText(values)!;
      expect(parseValueList(t.text, t.kind)).toEqual({ ok: true, value: values });
    }
    expect(valueListText([{ a: int(1) }])).toBeNull();
  });
});

describe('referenceKeyCandidates', () => {
  it('글자·숫자(와 그 배열) 키 이름만, 어느 깊이든, _id 빼고', () => {
    expect(referenceKeyCandidates({
      _id: oid,
      writerId: 'u1',
      count: int(3),
      author: { _id: 'x', id: int(7), at: date },
      kids: ['a', 'b'],
      items: [{ sku: 'x', qty: int(1) }],
      flags: [true],
      createdAt: date,
    })).toEqual(['writerId', 'count', 'id', 'kids', 'sku', 'qty']);
  });
});
