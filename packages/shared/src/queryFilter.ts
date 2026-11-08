// 사용자가 쓴 쿼리(find의 filter)가 허용 범위 안인지 검사한다. 서버가 실행 전에 꼭 거치고,
// 브라우저도 보내기 전에 같은 검사로 바로 알려 준다. 값은 Canonical EJSON({ $oid }, { $numberInt } …).
//
// 허용 목록(allowlist) 방식 — 여기 없는 $연산자는 전부 거절한다. 서버에서 JavaScript를 돌리는 건
// $where(쿼리)와 $function·$accumulator(집계 표현식)뿐이다(MongoDB 문서: $function, security.javascriptEnabled).
// $expr 자체는 JS가 아니라 집계 표현식을 쓰는 통로라서 허용하고, 그 안을 끝까지 훑어 JS 연산자만 막는다
// (집계 표현식은 수백 개라 허용 목록 대신). 오래 걸리는 쿼리는 서버의 maxTimeMS가 끊는다.
//
// 이 검사는 Canonical EJSON 그대로(서버의 fromWire 전)에 돈다 — 변환 뒤엔 ObjectId 같은 클래스 객체가 섞여
// 연산자와 값을 가릴 수 없다. EJSON 래퍼({ $oid } 등)는 '값'으로 보고, 래퍼처럼 생겼지만 키가 둘인
// 옛 형식({ $binary, $type })은 모르는 연산자로 거절한다(보수적으로).
import { isPlainObject, isWrapperObject, valueKind, NUMERIC_KINDS } from './ejson';

// 필드에 거는 비교 — { age: { $gt: 51 } }
export const QUERY_FIELD_OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$exists', '$type', '$regex', '$options', '$not', '$elemMatch', '$size', '$all', '$mod',
] as const;

// 조건 묶기 — { $or: [ {…}, {…} ] }
export const QUERY_LOGICAL_OPERATORS = ['$and', '$or', '$nor'] as const;

// 알려진 연산자인데 막은 것 — 왜 안 되는지 알려 준다
const BLOCKED: Record<string, string> = {
  $where: 'runs JavaScript on the server',
  $function: 'runs JavaScript on the server',
  $accumulator: 'runs JavaScript on the server',
  $jsonSchema: 'is not supported yet',
  $text: 'is not supported (needs a text index)',
  $near: 'is not supported (geo queries)',
  $nearSphere: 'is not supported (geo queries)',
  $geoWithin: 'is not supported (geo queries)',
  $geoIntersects: 'is not supported (geo queries)',
};

// 어디에 있든 막는 JavaScript 실행 연산자 — $expr 안을 훑을 때 쓴다
const JS_OPERATORS = new Set(['$where', '$function', '$accumulator']);

// 이보다 깊게 중첩된 쿼리는 거절 — 사람이 쓰는 쿼리는 이만큼 깊어질 일이 없다
export const QUERY_MAX_DEPTH = 32;

export interface QueryFilterError {
  message: string;
  // 문제가 있는 자리 — "age.$gt", "$or.1.name"(빈 문자열 = 쿼리 전체)
  path: string;
}

const FIELD_OPS = new Set<string>(QUERY_FIELD_OPERATORS);
const LOGICAL_OPS = new Set<string>(QUERY_LOGICAL_OPERATORS);
// DBRef의 키는 $로 시작하지만 연산자가 아니라 값이다
const DBREF_KEYS = new Set(['$ref', '$id', '$db']);

class Invalid extends Error {
  constructor(message: string, public path: string) {
    super(message);
  }
}

const join = (path: string, key: string | number): string => (path ? `${path}.${key}` : String(key));

const isNumber = (value: unknown): boolean => NUMERIC_KINDS.has(valueKind(value));

const unknownOperator = (op: string, path: string): Invalid =>
  new Invalid(BLOCKED[op] ? `${op} ${BLOCKED[op]}` : `Unknown operator ${op}`, path);

// { $gt: 1 } 같은 '연산자 객체'인가 — EJSON 래퍼({ $oid })는 연산자가 아니라 값이다
const isOperatorObject = (value: unknown): value is Record<string, unknown> => {
  if (!isPlainObject(value) || isWrapperObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys[0].startsWith('$') && !DBREF_KEYS.has(keys[0]);
};

const checkDepth = (depth: number, path: string) => {
  if (depth > QUERY_MAX_DEPTH) throw new Invalid('Query is nested too deeply', path);
};

// 비교할 값 — 숫자·문자열·날짜·oid 같은 값이나, 그런 값으로 된 객체/배열. 안에 $연산자가 섞이면 안 된다
const checkLiteral = (value: unknown, path: string, depth: number): void => {
  checkDepth(depth, path);
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkLiteral(item, join(path, i), depth + 1));
    return;
  }
  if (!isPlainObject(value) || isWrapperObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('$') && !DBREF_KEYS.has(key)) {
      throw new Invalid(`${key} can't be used inside a value`, join(path, key));
    }
    checkLiteral(item, join(path, key), depth + 1);
  }
};

const checkArray = (value: unknown, op: string, path: string): unknown[] => {
  if (!Array.isArray(value)) throw new Invalid(`${op} needs an array`, path);
  return value;
};

// 필드 하나에 거는 조건 — 값 그대로(같음) 또는 연산자 객체
const checkCondition = (value: unknown, path: string, depth: number): void => {
  checkDepth(depth, path);
  if (!isOperatorObject(value)) {
    checkLiteral(value, path, depth);
    return;
  }
  for (const [op, arg] of Object.entries(value)) {
    const at = join(path, op);
    if (!op.startsWith('$')) throw new Invalid(`Can't mix operators and fields in one object ("${op}")`, at);
    if (!FIELD_OPS.has(op)) throw unknownOperator(op, at);
    switch (op) {
      case '$eq': case '$ne': case '$gt': case '$gte': case '$lt': case '$lte':
        checkLiteral(arg, at, depth + 1);
        break;
      case '$in': case '$nin': case '$all':
        checkArray(arg, op, at).forEach((item, i) => checkLiteral(item, join(at, i), depth + 2));
        break;
      case '$exists':
        if (typeof arg !== 'boolean' && !isNumber(arg)) throw new Invalid('$exists needs true or false', at);
        break;
      case '$type': {
        const ok = (t: unknown) => typeof t === 'string' || isNumber(t);
        if (Array.isArray(arg) ? !arg.every(ok) : !ok(arg)) throw new Invalid('$type needs a type name like "string" or "date"', at);
        break;
      }
      case '$regex':
        if (typeof arg !== 'string' && !(isPlainObject(arg) && '$regularExpression' in arg)) {
          throw new Invalid('$regex needs a pattern string', at);
        }
        break;
      case '$options':
        if (typeof arg !== 'string') throw new Invalid('$options needs a string like "i"', at);
        if (!('$regex' in value)) throw new Invalid('$options only works next to $regex', at);
        break;
      case '$not':
        // { $not: { $gt: 5 } } 또는 { $not: /정규식/ }
        if (isPlainObject(arg) && '$regularExpression' in arg) break;
        if (!isOperatorObject(arg)) throw new Invalid('$not needs an operator like { $gt: 5 }', at);
        checkCondition(arg, at, depth + 1);
        break;
      case '$elemMatch':
        if (!isPlainObject(arg) || isWrapperObject(arg)) throw new Invalid('$elemMatch needs an object', at);
        // 원소가 값이면 { $gt: 5 }, 원소가 객체면 { name: "a", qty: { $gt: 1 } }
        if (isOperatorObject(arg) && !Object.keys(arg).some((k) => LOGICAL_OPS.has(k))) checkCondition(arg, at, depth + 1);
        else checkFilter(arg, at, depth + 1);
        break;
      case '$size':
        if (!isNumber(arg)) throw new Invalid('$size needs a number', at);
        break;
      case '$mod': {
        const pair = checkArray(arg, op, at);
        if (pair.length !== 2 || !pair.every(isNumber)) throw new Invalid('$mod needs [divisor, remainder]', at);
        break;
      }
    }
  }
};

// $expr 안(집계 표현식) — 연산자 이름은 MongoDB가 검사하게 두고, JS 연산자만 어디에 있든 막는다
const checkExpression = (value: unknown, path: string, depth: number): void => {
  checkDepth(depth, path);
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkExpression(item, join(path, i), depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const at = join(path, key);
    if (JS_OPERATORS.has(key)) throw new Invalid(`${key} runs JavaScript on the server`, at);
    checkExpression(item, at, depth + 1);
  }
};

// 쿼리 객체(또는 $and/$or 안의 한 조건) — { 필드: 조건, $or: [...] }
const checkFilter = (filter: unknown, path: string, depth: number): void => {
  checkDepth(depth, path);
  if (!isPlainObject(filter) || isWrapperObject(filter)) {
    throw new Invalid('A query must be an object like { field: value }', path);
  }
  for (const [key, value] of Object.entries(filter)) {
    const at = join(path, key);
    if (LOGICAL_OPS.has(key)) {
      const items = checkArray(value, key, at);
      if (items.length === 0) throw new Invalid(`${key} needs at least one condition`, at);
      items.forEach((item, i) => checkFilter(item, join(at, i), depth + 2));
    } else if (key === '$expr') {
      checkExpression(value, at, depth + 1);
    } else if (key.startsWith('$')) {
      if (FIELD_OPS.has(key)) throw new Invalid(`${key} goes inside a field, like { age: { ${key}: … } }`, at);
      throw unknownOperator(key, at);
    } else if (key === '') {
      throw new Invalid('Field name is empty', at);
    } else {
      checkCondition(value, at, depth + 1);
    }
  }
};

// 문제가 없으면 null
export const validateQueryFilter = (filter: unknown): QueryFilterError | null => {
  try {
    checkFilter(filter, '', 0);
    return null;
  } catch (e) {
    if (e instanceof Invalid) return { message: e.message, path: e.path };
    throw e;
  }
};
