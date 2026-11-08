// Canonical Extended JSON v2 값 모델.
//
// 이 앱은 통신·메모리·저장 전부 Canonical EJSON 하나로 통일한다. 숫자도 항상
// {$numberInt}/{$numberDouble}/{$numberLong}/{$numberDecimal} 래퍼로 들고 있어서
// Int32/Double/Int64 구분이 왕복(읽기→편집→쓰기) 중에 절대 사라지지 않는다.
// Relaxed는 사용자가 복사/내보내기에서 고를 때만 toRelaxed로 만든다.
//
// UI/서비스 코드는 typeof로 값을 직접 판별하지 말고 여기 함수(valueKind,
// displayValue, compareKey …)만 쓴다 — 타입 규칙이 이 파일 한 곳에만 있게 하려는 것.
//
// 스펙: https://github.com/mongodb/specifications/blob/master/source/extended-json/extended-json.md

export type EjsonPrimitive = string | boolean | null;
export interface EjsonObject {
  [key: string]: EjsonValue;
}
export type EjsonValue = EjsonPrimitive | EjsonObject | EjsonValue[];

export type OidValue = { $oid: string };
export type Int32Value = { $numberInt: string };
export type DoubleValue = { $numberDouble: string };
export type LongValue = { $numberLong: string };
export type DecimalValue = { $numberDecimal: string };
export type DateValue = { $date: { $numberLong: string } };

export type ValueKind =
  | 'string' | 'boolean' | 'null'
  | 'int32' | 'double' | 'long' | 'decimal128'
  | 'oid' | 'date'
  | 'object' | 'array'
  // 앱이 해석하지 않는 BSON 타입(Binary, Timestamp, Regex, MinKey …) — 읽기 전용으로만 표시
  | 'opaque';

export const NUMERIC_KINDS: ReadonlySet<ValueKind> = new Set(['int32', 'double', 'long', 'decimal128']);

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// 래퍼 객체를 알아보는 첫 키. $ref/$id(DBRef)는 래퍼가 아니라 일반 객체로 다룬다.
const WRAPPER_KEYS = new Set([
  '$oid', '$numberInt', '$numberDouble', '$numberLong', '$numberDecimal', '$date',
  '$binary', '$uuid', '$timestamp', '$regularExpression', '$minKey', '$maxKey',
  '$symbol', '$code', '$undefined', '$dbPointer',
]);

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const singleKey = (value: Record<string, unknown>): string | undefined => {
  const keys = Object.keys(value);
  if (keys.length === 1) return keys[0];
  // $code + $scope 만 예외적으로 키 2개짜리 래퍼
  if (keys.length === 2 && keys.includes('$code') && keys.includes('$scope')) return '$code';
  return undefined;
};

export const isWrapperObject = (value: Record<string, unknown>): boolean => {
  const key = singleKey(value);
  return key !== undefined && WRAPPER_KEYS.has(key);
};

// ── 판별 ─────────────────────────────────────────────────────────────────────

// 입력은 unknown — 아직 정규화되지 않은 값(plain number, relaxed $date 문자열)도
// 관대하게 분류한다. 저장 경계에서는 toCanonical로 정규화되므로 그 뒤엔 정확한 모양만 남는다.
export const valueKind = (value: unknown): ValueKind => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX ? 'int32' : 'double';
  if (Array.isArray(value)) return 'array';
  if (!isPlainObject(value)) return 'opaque';

  const key = singleKey(value);
  if (key === undefined || !WRAPPER_KEYS.has(key)) return 'object';

  const inner = value[key];
  switch (key) {
    case '$oid':
      return typeof inner === 'string' ? 'oid' : 'opaque';
    case '$numberInt':
      return typeof inner === 'string' ? 'int32' : 'opaque';
    case '$numberDouble':
      return typeof inner === 'string' ? 'double' : 'opaque';
    case '$numberLong':
      return typeof inner === 'string' ? 'long' : 'opaque';
    case '$numberDecimal':
      return typeof inner === 'string' ? 'decimal128' : 'opaque';
    case '$date':
      return dateMs(value) !== undefined ? 'date' : 'opaque';
    default:
      return 'opaque';
  }
};

export const isOid = (value: unknown): value is OidValue => valueKind(value) === 'oid';
export const isDate = (value: unknown): value is DateValue => valueKind(value) === 'date';
export const isDecimal = (value: unknown): value is DecimalValue => valueKind(value) === 'decimal128';
export const isLong = (value: unknown): value is LongValue => valueKind(value) === 'long';
export const isNumeric = (value: unknown): boolean => NUMERIC_KINDS.has(valueKind(value));
// 펼쳐서 하위 키를 탐색할 수 있는 "진짜" 객체 — 래퍼는 제외
export const isEjsonObject = (value: unknown): value is EjsonObject => valueKind(value) === 'object';
export const isContainer = (value: unknown): value is EjsonObject | EjsonValue[] => {
  const kind = valueKind(value);
  return kind === 'object' || kind === 'array';
};

// ── 값 꺼내기 ────────────────────────────────────────────────────────────────

// 숫자 래퍼의 원문 문자열(정밀도 손실 없음). 숫자가 아니면 undefined.
export const numericText = (value: unknown): string | undefined => {
  if (typeof value === 'number') return String(value);
  if (!isPlainObject(value)) return undefined;
  for (const key of ['$numberInt', '$numberDouble', '$numberLong', '$numberDecimal'] as const) {
    if (typeof value[key] === 'string') return value[key] as string;
  }
  return undefined;
};

// 연산/정렬용 JS number — Long/Decimal은 정밀도가 깎일 수 있으니 비교 키에는 쓰지 말 것
export const numericValue = (value: unknown): number | undefined => {
  const text = numericText(value);
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isNaN(n) && text !== 'NaN' ? undefined : n;
};

// Canonical {$date:{$numberLong}} 외에 relaxed {$date:"ISO"} / {$date:number}도 받는다
export const dateMs = (value: unknown): number | undefined => {
  if (!isPlainObject(value) || singleKey(value) !== '$date') return undefined;
  const inner = value.$date;
  let ms: number;
  if (isPlainObject(inner) && typeof inner.$numberLong === 'string') ms = Number(inner.$numberLong);
  else if (typeof inner === 'string') ms = Date.parse(inner);
  else if (typeof inner === 'number') ms = inner;
  else return undefined;
  return Number.isFinite(ms) ? ms : undefined;
};

// ── 만들기 ───────────────────────────────────────────────────────────────────

const formatDouble = (n: number): string => {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (Object.is(n, -0)) return '-0.0';
  // bson 라이브러리와 같은 규칙 — 정수값 double은 "5.0"으로 써서 Int32와 구분된다
  return Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(1) : String(n);
};

export const makeOid = (hex: string): OidValue => ({ $oid: hex.toLowerCase() });
export const makeInt32 = (n: number): Int32Value => ({ $numberInt: String(Math.trunc(n)) });
export const makeDouble = (n: number): DoubleValue => ({ $numberDouble: formatDouble(n) });
export const makeLong = (n: number | bigint | string): LongValue => ({ $numberLong: BigInt(n).toString() });
export const makeDecimal = (text: string): DecimalValue => ({ $numberDecimal: text.trim() });
export const makeDate = (input: number | Date): DateValue => ({
  $date: { $numberLong: String(Math.trunc(input instanceof Date ? input.getTime() : input)) },
});

const isInt64Text = (text: string): boolean => {
  if (!/^[+-]?\d+$/.test(text)) return false;
  const n = BigInt(text);
  return n >= INT64_MIN && n <= INT64_MAX;
};

// 편집기 입력 문자열 → 숫자 래퍼. prefer가 있으면 그 타입을 유지(기존 Double 필드를
// "5"로 고쳐도 Double로 남는다). 숫자가 아니면 null.
export const parseNumberInput = (text: string, prefer?: ValueKind): EjsonValue | null => {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  if (prefer === 'decimal128') {
    return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? makeDecimal(trimmed) : null;
  }
  if (prefer === 'long') {
    return isInt64Text(trimmed) ? makeLong(trimmed) : null;
  }

  const n = Number(trimmed);
  if (Number.isNaN(n) && trimmed !== 'NaN') return null;
  if (prefer === 'double') return makeDouble(n);

  // 정수 표기가 int32 범위면 Int32, 넘으면 Int64, 그 외(소수/지수)는 Double —
  // bson 라이브러리가 plain JS number를 canonical로 바꿀 때와 같은 규칙
  if (/^[+-]?\d+$/.test(trimmed)) {
    if (n >= INT32_MIN && n <= INT32_MAX) return makeInt32(n);
    if (isInt64Text(trimmed)) return makeLong(trimmed);
  }
  return makeDouble(n);
};

// ── 변환 ─────────────────────────────────────────────────────────────────────

// 아무 JSON(plain / relaxed / canonical 혼합)을 Canonical로 정규화한다. 이미 canonical인
// 입력에는 항등(멱등)이고, 결과는 입력과 참조를 공유하지 않는 새 그래프다(= 깊은 복제 겸용).
export const toCanonical = (value: unknown): EjsonValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || Object.is(value, -0)) return makeDouble(value);
    if (value >= INT32_MIN && value <= INT32_MAX) return makeInt32(value);
    if (Number.isSafeInteger(value)) return makeLong(value);
    return makeDouble(value);
  }
  if (typeof value === 'bigint') return makeLong(value);
  if (value instanceof Date) return makeDate(value);
  if (Array.isArray(value)) return value.map((item) => toCanonical(item));
  if (!isPlainObject(value)) return null;

  if (isWrapperObject(value)) {
    const key = singleKey(value);
    if (key === '$date') {
      const ms = dateMs(value);
      return ms !== undefined ? makeDate(ms) : (structuredCloneJson(value) as EjsonValue);
    }
    if (key === '$oid' && typeof value.$oid === 'string') return makeOid(value.$oid);
    if (key === '$numberLong' && typeof value.$numberLong === 'number') return makeLong(value.$numberLong);
    if (key === '$numberInt' && typeof value.$numberInt === 'number') return makeInt32(value.$numberInt);
    if (key === '$numberDouble' && typeof value.$numberDouble === 'number') return makeDouble(value.$numberDouble);
    // 나머지 래퍼(Binary, Timestamp …)는 해석하지 않고 모양 그대로 복제
    return structuredCloneJson(value) as EjsonValue;
  }

  const result: EjsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = toCanonical(child);
  }
  return result;
};

const structuredCloneJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const RELAXED_DATE_MIN = 0; // 1970-01-01
const RELAXED_DATE_MAX = Date.UTC(10000, 0, 1) - 1; // 9999-12-31

// 복사/내보내기용 Relaxed 변환. 스펙대로 손실이 생기는 값(2^53을 넘는 Long, 1970 이전 날짜,
// NaN/Infinity Double)은 canonical 모양을 그대로 남긴다.
export const toRelaxed = (value: EjsonValue): unknown => {
  const kind = valueKind(value);
  switch (kind) {
    case 'int32':
    case 'double': {
      const n = numericValue(value);
      return n !== undefined && Number.isFinite(n) ? n : value;
    }
    case 'long': {
      const n = numericValue(value);
      return n !== undefined && Number.isSafeInteger(n) ? n : value;
    }
    case 'date': {
      const ms = dateMs(value)!;
      return ms >= RELAXED_DATE_MIN && ms <= RELAXED_DATE_MAX ? { $date: new Date(ms).toISOString() } : value;
    }
    case 'array':
      return (value as EjsonValue[]).map((item) => toRelaxed(item));
    case 'object': {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as EjsonObject)) result[key] = toRelaxed(child);
      return result;
    }
    default:
      return value;
  }
};

// ── 표시 ─────────────────────────────────────────────────────────────────────

export const displayValue = (value: unknown): string => {
  const kind = valueKind(value);
  switch (kind) {
    case 'null':
      return 'null';
    case 'string':
      return value as string;
    case 'boolean':
      return String(value);
    case 'int32':
    case 'double':
    case 'long':
    case 'decimal128':
      return numericText(value) ?? '';
    case 'oid':
      return (value as OidValue).$oid;
    case 'date':
      return new Date(dateMs(value)!).toISOString();
    case 'array':
      return `[${(value as unknown[]).length}]`;
    case 'object':
      return '{…}';
    case 'opaque':
      return JSON.stringify(value);
  }
};

// 필터 검색용 텍스트 — 컨테이너는 relaxed JSON으로 펼쳐서 "$numberInt" 같은 래퍼 키가
// 검색어에 걸리지 않게 한다
export const searchText = (value: EjsonValue): string =>
  isContainer(value) ? JSON.stringify(toRelaxed(value)) : displayValue(value);

// 문서 식별자 문자열 — _id / PK 값으로 쓸 수 있는 스칼라만 (oid, 문자열, 숫자)
export const idString = (value: unknown): string | undefined => {
  const kind = valueKind(value);
  if (kind === 'oid') return (value as OidValue).$oid;
  if (kind === 'string') return value as string;
  if (NUMERIC_KINDS.has(kind)) return normalizeNumeric(value);
  return undefined;
};

// ── 비교 ─────────────────────────────────────────────────────────────────────

// 숫자 값을 타입과 무관한 정규 문자열로 — MongoDB 쿼리처럼 5(Int32) == 5.0(Double) == 5(Long)
const normalizeNumeric = (value: unknown): string => {
  const kind = valueKind(value);
  const text = (numericText(value) ?? '').trim();

  if (kind === 'long' || kind === 'int32') {
    try {
      return BigInt(text).toString();
    } catch {
      return text;
    }
  }

  if (kind === 'decimal128') {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
    if (match) {
      const intPart = match[2].replace(/^0+(?=\d)/, '') || '0';
      const fracPart = (match[3] ?? '').replace(/0+$/, '');
      const sign = match[1] === '-' && !(intPart === '0' && fracPart === '') ? '-' : '';
      return fracPart ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
    }
    // 지수 표기·NaN·Infinity는 double 경로로
  }

  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  if (Object.is(n, -0)) return '0';
  if (Number.isSafeInteger(n)) return BigInt(n).toString();
  return String(n);
};

// MongoDB가 equality 매칭에서 같다고 보는 값끼리 같은 문자열이 나오는 비교 키.
//   compareKey({$numberInt:"5"}) === compareKey({$numberDouble:"5.0"})  // "n:5"
//   compareKey("5") !== compareKey({$numberInt:"5"})                   // 문자열 ≠ 숫자
// 객체는 Mongo와 같이 키 순서까지 같아야 같다. Map 키로 써서 FK 조회를 O(1)로 만든다.
export const compareKey = (value: unknown): string => {
  const kind = valueKind(value);
  switch (kind) {
    case 'null':
      return 'z';
    case 'string':
      return `s:${value as string}`;
    case 'boolean':
      return `b:${String(value)}`;
    case 'int32':
    case 'double':
    case 'long':
    case 'decimal128':
      return `n:${normalizeNumeric(value)}`;
    case 'oid':
      return `o:${(value as OidValue).$oid.toLowerCase()}`;
    case 'date':
      return `d:${dateMs(value)}`;
    case 'array':
      return `a:${JSON.stringify((value as unknown[]).map(compareKey))}`;
    case 'object':
      return `O:${JSON.stringify(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, compareKey(v)]))}`;
    case 'opaque':
      return `x:${JSON.stringify(value)}`;
  }
};

export const ejsonEquals = (a: unknown, b: unknown): boolean => compareKey(a) === compareKey(b);
