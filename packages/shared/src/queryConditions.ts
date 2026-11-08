// 쿼리 ↔ '조건 칩'. 실행되는 건 늘 쿼리 텍스트이고(정본), 칩은 그중 단순한 조건(필드 하나 + 연산자 하나)을
// 뽑아 보여 준 것이다. 칩을 고치거나 빌더·QBE로 조건을 더하면 쿼리 객체를 고친 뒤 formatQueryText로 텍스트를 새로 쓴다.
//
// 같은 필드에 또 걸 때(합의한 규칙):
//   - 다른 연산자면 합친다     age > 40 + age < 60 → { age: { $gt: 40, $lt: 60 } }
//   - 같은 연산자면 값만 바꾼다
//   - = (그리고 정규식)은 그 필드의 다른 조건을 전부 대신한다
import {
  dateMs,
  isPlainObject,
  isWrapperObject,
  makeDate,
  makeOid,
  parseNumberInput,
  valueKind,
  type EjsonObject,
  type EjsonValue,
} from './ejson';

export type ConditionOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'exists' | 'type' | 'size' | 'regex';

export interface Condition {
  field: string;
  op: ConditionOp;
  // exists: true(있음)/false(없음), in/nin: 값 배열, type: 타입 이름("string"), size: 숫자, regex: { $regularExpression }
  value: EjsonValue;
}

// 칩 하나 — 단순 조건이거나, 칩으로 못 나타내는 부분(텍스트에서 고친다)
export type ConditionChip = ({ kind: 'condition' } & Condition) | { kind: 'custom'; field: string };

const MONGO_OP: Record<Exclude<ConditionOp, 'eq' | 'regex'>, string> = {
  ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte', in: '$in', nin: '$nin', exists: '$exists', type: '$type', size: '$size',
};
const OP_OF: Record<string, ConditionOp> = {
  $eq: 'eq', $ne: 'ne', $gt: 'gt', $gte: 'gte', $lt: 'lt', $lte: 'lte', $in: 'in', $nin: 'nin', $exists: 'exists', $type: 'type', $size: 'size',
};

// 칩에 보일 연산자 기호
export const CONDITION_OP_LABEL: Record<ConditionOp, string> = {
  eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'in', nin: 'not in', exists: 'exists', type: 'type', size: 'size =', regex: '~',
};

// 칩으로 나타낼 수 있는 연산자 인자인가 — 아니면 그 필드는 custom 칩
const chipArgOk = (op: string, arg: EjsonValue): boolean => {
  if (op === '$exists') return typeof arg === 'boolean';
  if (op === '$in' || op === '$nin') return Array.isArray(arg);
  if (op === '$type') return typeof arg === 'string';
  return true;
};

const isRegex = (value: unknown): value is { $regularExpression: { pattern: string; options: string } } =>
  isPlainObject(value) && isPlainObject(value.$regularExpression) && typeof value.$regularExpression.pattern === 'string';

// { $gt: 1 } 같은 연산자 객체인가(EJSON 래퍼는 값)
const isOperatorObject = (value: unknown): value is Record<string, EjsonValue> =>
  isPlainObject(value) && !isWrapperObject(value) && Object.keys(value).length > 0 && Object.keys(value)[0].startsWith('$');

// ── 텍스트에서 칩 뽑기 ─────────────────────────────────────────────────────────

export const describeFilter = (filter: EjsonObject): ConditionChip[] => {
  const chips: ConditionChip[] = [];
  for (const [field, value] of Object.entries(filter)) {
    if (field.startsWith('$')) {
      chips.push({ kind: 'custom', field });
    } else if (isOperatorObject(value)) {
      const ops = Object.keys(value);
      if (ops.every((op) => op in OP_OF && chipArgOk(op, value[op]))) {
        for (const op of ops) chips.push({ kind: 'condition', field, op: OP_OF[op], value: value[op] });
      } else if (ops.length <= 2 && typeof value.$regex === 'string' && ops.every((op) => op === '$regex' || (op === '$options' && typeof value.$options === 'string'))) {
        chips.push({ kind: 'condition', field, op: 'regex', value: { $regularExpression: { pattern: value.$regex, options: (value.$options as string | undefined) ?? '' } } });
      } else {
        chips.push({ kind: 'custom', field });
      }
    } else if (isRegex(value)) {
      chips.push({ kind: 'condition', field, op: 'regex', value });
    } else {
      chips.push({ kind: 'condition', field, op: 'eq', value });
    }
  }
  return chips;
};

// ── 조건 더하기 / 빼기 ────────────────────────────────────────────────────────

export const addCondition = (filter: EjsonObject, condition: Condition): EjsonObject => {
  const { field, op, value } = condition;
  const next: EjsonObject = { ...filter };
  if (op === 'eq' || op === 'regex') {
    next[field] = value;
    return next;
  }
  const current = filter[field];
  // 지금이 '같음'(값 그대로)이나 정규식이면 새 조건과 함께 둘 수 없으니 대신한다
  const ops: EjsonObject = isOperatorObject(current) ? { ...current } : {};
  delete ops.$eq;
  delete ops.$regex;
  delete ops.$options;
  ops[MONGO_OP[op]] = value;
  next[field] = ops;
  return next;
};

export const removeCondition = (filter: EjsonObject, field: string, op?: ConditionOp): EjsonObject => {
  const next: EjsonObject = { ...filter };
  const current = filter[field];
  if (op && op !== 'eq' && op !== 'regex' && isOperatorObject(current) && MONGO_OP[op] in current) {
    const ops: EjsonObject = { ...current };
    delete ops[MONGO_OP[op]];
    if (Object.keys(ops).length) {
      next[field] = ops;
      return next;
    }
  }
  delete next[field];
  return next;
};

// ── 쿼리 객체 → 텍스트(mongosh 모양) ──────────────────────────────────────────
// parseQueryText(formatQueryText(f))가 f와 같아야 한다(테스트). 그렇게 못 쓰는 값은 Canonical JSON 그대로 쓴다
// — 파서는 그것도 그대로 받는다.

const IDENT = /^[A-Za-z_$][\w$]*$/;
const formatKey = (key: string) => (IDENT.test(key) ? key : JSON.stringify(key));

const formatRegex = (value: { $regularExpression: { pattern: string; options: string } }): string => {
  const { pattern, options } = value.$regularExpression;
  const trailingBackslashes = /\\*$/.exec(pattern)![0].length;
  if (pattern === '' || /[/\n]/.test(pattern) || trailingBackslashes % 2 === 1 || /[^imsx]/.test(options)) return JSON.stringify(value);
  return `/${pattern}/${options}`;
};

export const formatQueryValue = (value: EjsonValue): string => {
  switch (valueKind(value)) {
    case 'null':
      return 'null';
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'int32':
      return (value as { $numberInt: string }).$numberInt;
    case 'double': {
      const text = (value as { $numberDouble: string }).$numberDouble;
      // 정수처럼 보이면(5.0) 소수점을 남겨야 다시 읽을 때 Double — formatDouble이 이미 "5.0"으로 둔다
      return Number.isFinite(Number(text)) && !Object.is(Number(text), -0) ? text : JSON.stringify(value);
    }
    case 'long':
      return `NumberLong(${JSON.stringify((value as { $numberLong: string }).$numberLong)})`;
    case 'decimal128':
      return `NumberDecimal(${JSON.stringify((value as { $numberDecimal: string }).$numberDecimal)})`;
    case 'oid':
      return `ObjectId(${JSON.stringify((value as { $oid: string }).$oid)})`;
    case 'date': {
      const ms = dateMs(value)!;
      const year = new Date(ms).getUTCFullYear();
      return year >= 0 && year <= 9999 ? `ISODate(${JSON.stringify(new Date(ms).toISOString())})` : JSON.stringify(value);
    }
    case 'array':
      return `[${(value as EjsonValue[]).map(formatQueryValue).join(', ')}]`;
    case 'object': {
      const entries = Object.entries(value as EjsonObject);
      return entries.length ? `{ ${entries.map(([k, v]) => `${formatKey(k)}: ${formatQueryValue(v)}`).join(', ')} }` : '{}';
    }
    default:
      return isRegex(value) ? formatRegex(value) : JSON.stringify(value);
  }
};

// 짧으면 한 줄, 길면 맨 바깥 조건마다 한 줄
const ONE_LINE_MAX = 60;

export const formatQueryText = (filter: EjsonObject): string => {
  const parts = Object.entries(filter).map(([k, v]) => `${formatKey(k)}: ${formatQueryValue(v)}`);
  if (parts.length === 0) return '{}';
  const oneLine = `{ ${parts.join(', ')} }`;
  return parts.length === 1 || oneLine.length <= ONE_LINE_MAX ? oneLine : `{\n  ${parts.join(',\n  ')}\n}`;
};

// ── 빌더의 값 입력 ────────────────────────────────────────────────────────────

export type ConditionValueKind = 'auto' | 'string' | 'number' | 'boolean' | 'null' | 'date' | 'oid';

const OID_TEXT = /^[0-9a-fA-F]{24}$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// 글자 → 값. auto: true/false/null, 숫자, 24자리 hex(ObjectId), 날짜(2024-01-31[T09:00]), 따옴표로 감싼 글자, 나머지 = 문자열
export const parseConditionValue = (text: string, kind: ConditionValueKind = 'auto'): { ok: true; value: EjsonValue } | { ok: false; message: string } => {
  const trimmed = text.trim();
  const asDate = () => {
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : makeDate(ms);
  };
  switch (kind) {
    case 'string':
      return { ok: true, value: text };
    case 'number': {
      const n = parseNumberInput(trimmed);
      return n === null ? { ok: false, message: 'Not a number' } : { ok: true, value: n };
    }
    case 'boolean':
      return trimmed === 'true' || trimmed === 'false' ? { ok: true, value: trimmed === 'true' } : { ok: false, message: 'Type true or false' };
    case 'null':
      return { ok: true, value: null };
    case 'date': {
      const date = asDate();
      return date ? { ok: true, value: date } : { ok: false, message: 'Not a date — try 2024-01-31 or 2024-01-31T09:00:00Z' };
    }
    case 'oid':
      return OID_TEXT.test(trimmed) ? { ok: true, value: makeOid(trimmed) } : { ok: false, message: 'ObjectId is 24 hex characters' };
    default: {
      if (trimmed === 'true' || trimmed === 'false') return { ok: true, value: trimmed === 'true' };
      if (trimmed === 'null') return { ok: true, value: null };
      if (/^".*"$|^'.*'$/.test(trimmed) && trimmed.length >= 2) return { ok: true, value: trimmed.slice(1, -1) };
      const n = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? parseNumberInput(trimmed) : null;
      if (n !== null) return { ok: true, value: n };
      if (OID_TEXT.test(trimmed)) return { ok: true, value: makeOid(trimmed) };
      if (DATE_TEXT.test(trimmed)) {
        const date = asDate();
        if (date) return { ok: true, value: date };
      }
      return { ok: true, value: text };
    }
  }
};

// ── 글자 맞추기(정규식으로 만드는 조건) ─────────────────────────────────────────
// contains / starts with / ends with는 글자 그대로(특수문자 이스케이프) 대소문자 무시.
// length = n은 $expr($strLenCP) 대신 정규식 — $expr는 그 필드가 글자가 아닌 문서가 하나라도 있으면 쿼리 전체가 실패한다.
export type TextMatch =
  | { mode: 'contains' | 'startsWith' | 'endsWith'; text: string }
  | { mode: 'length'; length: number };

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unescapeRegex = (pattern: string) => pattern.replace(/\\(.)/g, '$1');

export const textMatchRegex = (match: TextMatch): EjsonValue => {
  if (match.mode === 'length') return { $regularExpression: { pattern: `^[\\s\\S]{${match.length}}$`, options: '' } };
  const body = escapeRegex(match.text);
  const pattern = match.mode === 'startsWith' ? `^${body}` : match.mode === 'endsWith' ? `${body}$` : body;
  return { $regularExpression: { pattern, options: 'i' } };
};

// 정규식이 textMatchRegex로 만든 모양이면 그 뜻(칩에 contains "kim", length = 5로). 아니면 null
export const readTextMatch = (value: EjsonValue): TextMatch | null => {
  if (!isRegex(value)) return null;
  const { pattern, options } = value.$regularExpression;
  const length = /^\^\[\\s\\S\]\{(\d+)\}\$$/.exec(pattern);
  if (length && options === '') return { mode: 'length', length: Number(length[1]) };
  if (options !== 'i') return null;
  const candidates: TextMatch[] = [];
  if (pattern.startsWith('^')) candidates.push({ mode: 'startsWith', text: unescapeRegex(pattern.slice(1)) });
  if (pattern.endsWith('$') && !pattern.endsWith('\\$')) candidates.push({ mode: 'endsWith', text: unescapeRegex(pattern.slice(0, -1)) });
  candidates.push({ mode: 'contains', text: unescapeRegex(pattern) });
  // 다시 만들어 똑같은 패턴이 나오는 것만 — 사용자가 직접 쓴 정규식(^ki[a-z])은 아니다
  return candidates.find((c) => c.mode !== 'length' && c.text !== '' && (textMatchRegex(c) as { $regularExpression: { pattern: string } }).$regularExpression.pattern === pattern) ?? null;
};

// 예전 이름(contains만)
export const containsRegex = (text: string): EjsonValue => textMatchRegex({ mode: 'contains', text });
export const containsText = (value: EjsonValue): string | null => {
  const match = readTextMatch(value);
  return match?.mode === 'contains' ? match.text : null;
};

// ── 여러 값(in / not in) ──────────────────────────────────────────────────────

// "a, b, 3" → 값 배열. 쉼표가 든 글자는 따옴표로("a,b")
export const parseValueList = (text: string, kind: ConditionValueKind = 'auto'): { ok: true; value: EjsonValue[] } | { ok: false; message: string } => {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && i + 1 < text.length) {
        current += ch + text[++i];
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  const items = parts.map((p) => p.trim()).filter((p) => p !== '');
  if (!items.length) return { ok: false, message: 'Type one or more values, separated by commas' };
  const values: EjsonValue[] = [];
  for (const item of items) {
    // 따옴표로 감싼 건 종류와 상관없이 글자(이스케이프 풀기)
    if (/^".*"$|^'.*'$/.test(item) && item.length >= 2) {
      values.push(item.slice(1, -1).replace(/\\(.)/g, '$1'));
      continue;
    }
    const parsed = parseConditionValue(item, kind);
    if (!parsed.ok) return { ok: false, message: `${item}: ${parsed.message}` };
    values.push(parsed.value);
  }
  return { ok: true, value: values };
};

// 값 배열 → 입력칸 글자(칩 고치기). 객체 같은 건 못 나타내면 null
export const valueListText = (values: EjsonValue[]): { text: string; kind: ConditionValueKind } | null => {
  const texts: string[] = [];
  const kinds = new Set<ConditionValueKind>();
  for (const value of values) {
    const item = conditionValueText(value);
    if (!item) return null;
    kinds.add(item.kind);
    texts.push(item.kind === 'string' ? JSON.stringify(item.text) : item.text);
  }
  // 종류가 하나면 그 종류로, 섞였으면 auto(글자는 따옴표로 감싸 두었다)
  return { text: texts.join(', '), kind: kinds.size === 1 && !kinds.has('string') ? [...kinds][0] : 'auto' };
};

// ── 칩 고치기 · 빌더 자동완성 ─────────────────────────────────────────────────

// 값 → 빌더 입력칸의 글자와 종류(칩을 눌러 고칠 때). 객체·배열·그 밖의 BSON은 폼으로 못 고친다(null — 텍스트에서)
export const conditionValueText = (value: EjsonValue): { text: string; kind: ConditionValueKind } | null => {
  switch (valueKind(value)) {
    case 'string':
      return { text: value as string, kind: 'string' };
    case 'boolean':
      return { text: String(value), kind: 'boolean' };
    case 'null':
      return { text: '', kind: 'null' };
    case 'int32':
    case 'double':
    case 'long':
    case 'decimal128':
      return { text: Object.values(value as Record<string, string>)[0], kind: 'number' };
    case 'oid':
      return { text: (value as { $oid: string }).$oid, kind: 'oid' };
    case 'date':
      return { text: new Date(dateMs(value)!).toISOString(), kind: 'date' };
    default:
      return null;
  }
};

// 문서 하나에서 쿼리에 쓸 필드 경로 — 배열은 인덱스 없이 원소 안으로(items.name = 아무 원소의 name). 깊이 제한
export const fieldPaths = (document: EjsonObject, maxDepth = 3): string[] => {
  const out = new Set<string>();
  const walk = (value: EjsonValue, prefix: string, depth: number) => {
    const kind = valueKind(value);
    if (kind === 'array') {
      for (const item of (value as EjsonValue[]).slice(0, 20)) walk(item, prefix, depth);
      return;
    }
    if (kind !== 'object' || depth >= maxDepth) return;
    for (const [key, child] of Object.entries(value as EjsonObject)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.add(path);
      walk(child, path, depth + 1);
    }
  };
  walk(document, '', 0);
  return [...out];
};

// 참조(FK)로 선언할 만한 키 이름 — 참조 설정은 경로가 아니라 키 이름으로 맞추므로(어느 깊이든, 배열 원소는 부모 키)
// 값이 글자·숫자(또는 그 배열)인 키만, _id는 빼고. 나온 순서대로
const FK_KINDS = new Set(['string', 'int32', 'double', 'long', 'decimal128']);
export const referenceKeyCandidates = (document: EjsonObject, maxDepth = 3): string[] => {
  const out = new Set<string>();
  const walk = (value: EjsonValue, depth: number) => {
    if (depth > maxDepth) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) walk(item, depth);
      return;
    }
    if (valueKind(value) !== 'object') return;
    for (const [key, child] of Object.entries(value as EjsonObject)) {
      const kind = valueKind(child);
      const scalarArray = Array.isArray(child) && child.some((item) => FK_KINDS.has(valueKind(item)));
      if (key !== '_id' && (FK_KINDS.has(kind) || scalarArray)) out.add(key);
      walk(child, depth + 1);
    }
  };
  walk(document, 0);
  return [...out];
};
