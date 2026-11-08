import { describe, expect, it } from 'vitest';
import { parseQueryText } from './queryParser';

const parsed = (text: string) => {
  const result = parseQueryText(text);
  if (!result.ok) throw new Error(`parse failed: ${result.error.message}`);
  return result.filter;
};
const failed = (text: string) => {
  const result = parseQueryText(text);
  if (result.ok) throw new Error(`expected failure: ${text}`);
  return result.error;
};

describe('parseQueryText — mongosh 모양 → Canonical EJSON', () => {
  it('빈 입력 = 조건 없음', () => {
    expect(parsed('')).toEqual({});
    expect(parsed('   \n ')).toEqual({});
    expect(parsed('{}')).toEqual({});
  });

  it('따옴표 없는 키·작은따옴표·점 경로·끝 쉼표', () => {
    expect(parsed(`{ name: 'kim', "x y": "a", author.name: "lee", }`)).toEqual({ name: 'kim', 'x y': 'a', 'author.name': 'lee' });
  });

  it('숫자 타입 규칙(int32 / long / double)', () => {
    expect(parsed('{ a: 51, b: -3, c: 1.5, d: 3000000000, e: 1e3 }')).toEqual({
      a: { $numberInt: '51' },
      b: { $numberInt: '-3' },
      c: { $numberDouble: '1.5' },
      d: { $numberLong: '3000000000' },
      e: { $numberDouble: '1000.0' },
    });
  });

  it('연산자와 중첩', () => {
    expect(parsed('{ age: { $gt: 51, $lte: 80 }, $or: [{ a: true }, { b: null }] }')).toEqual({
      age: { $gt: { $numberInt: '51' }, $lte: { $numberInt: '80' } },
      $or: [{ a: true }, { b: null }],
    });
  });

  it('도우미 함수', () => {
    expect(parsed('{ _id: ObjectId("64B7F0C2A1B2C3D4E5F60718") }')).toEqual({ _id: { $oid: '64b7f0c2a1b2c3d4e5f60718' } });
    expect(parsed('{ at: ISODate("2024-01-01T00:00:00Z") }')).toEqual({ at: { $date: { $numberLong: String(Date.UTC(2024, 0, 1)) } } });
    expect(parsed('{ at: new Date("2024-01-01T00:00:00Z") }')).toEqual(parsed('{ at: ISODate("2024-01-01T00:00:00Z") }'));
    expect(parsed('{ n: NumberLong("9007199254740993"), i: NumberInt(5), d: NumberDecimal("1.10") }')).toEqual({
      n: { $numberLong: '9007199254740993' },
      i: { $numberInt: '5' },
      d: { $numberDecimal: '1.10' },
    });
  });

  it('정규식 리터럴', () => {
    expect(parsed('{ name: /^ki\\/m[/]x/im }')).toEqual({ name: { $regularExpression: { pattern: '^ki\\/m[/]x', options: 'im' } } });
  });

  it('이미 Canonical인 입력은 그대로', () => {
    const canonical = { _id: { $oid: '64b7f0c2a1b2c3d4e5f60718' }, n: { $numberInt: '5' } };
    expect(parsed(JSON.stringify(canonical))).toEqual(canonical);
  });

  it('문자열 이스케이프', () => {
    expect(parsed(`{ a: "x\\"y\\n\\u00e9", b: 'it\\'s' }`)).toEqual({ a: 'x"y\né', b: "it's" });
  });

  it('"__proto__" 키는 그냥 필드', () => {
    const filter = parsed('{ "__proto__": { a: 1 } }');
    expect(Object.getPrototypeOf(filter)).toBe(Object.prototype);
    expect(Object.keys(filter)).toEqual(['__proto__']);
  });
});

describe('parseQueryText — 오류와 위치', () => {
  it('객체로 시작해야', () => {
    expect(failed('age: 51').message).toMatch(/starts with "\{"/);
    expect(failed('[1]').message).toMatch(/starts with/);
  });

  it('닫는 괄호·따옴표', () => {
    expect(failed('{ a: 1').message).toMatch(/Missing "\}"/);
    expect(failed('{ a: [1, 2 }').message).toMatch(/"," or "\]"/);
    expect(failed('{ a: "abc }').message).toMatch(/Unclosed string/);
    expect(failed('{ a: /abc }').message).toMatch(/Unclosed regex/);
  });

  it('줄·칸 위치', () => {
    const error = failed('{\n  age: 51,\n  name kim\n}');
    expect(error.line).toBe(3);
    expect(error.column).toBe(8);
    expect(error.message).toMatch(/Expected ":"/);
  });

  it('따옴표 없는 문자열·모르는 함수', () => {
    expect(failed('{ name: kim }').message).toMatch(/Unknown value "kim".*quotes/);
    expect(failed('{ a: eval("x") }').message).toMatch(/Unknown value "eval"/);
  });

  it('도우미 인자 검사', () => {
    expect(failed('{ _id: ObjectId("123") }').message).toMatch(/24-character/);
    expect(failed('{ at: ISODate("not a date") }').message).toMatch(/valid date/);
    expect(failed('{ i: NumberInt(1.5) }').message).toMatch(/32-bit/);
  });

  it('중복 키·뒤에 남은 글자·정규식 플래그', () => {
    expect(failed('{ a: 1, a: 2 }').message).toMatch(/Duplicate key "a"/);
    expect(failed('{ a: 1 } x').message).toMatch(/after the query/);
    expect(failed('{ a: /x/g }').message).toMatch(/flags/);
  });
});
