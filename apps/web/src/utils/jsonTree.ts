// path: src/utils/jsonTree.ts
import { isContainer, valueKind, type Document, type JsonValue } from '../types/explorer';

// UI가 쓰는 필드 타입. Int32/Double은 화면에서 'number' 하나로 다루고(편집기가 원래
// 숫자 타입을 유지한다), Long/Decimal128은 정밀도 때문에 별도 타입으로 둔다.
// 'opaque'는 앱이 해석하지 않는 BSON 타입(Binary, Timestamp …) — 읽기 전용.
export type JsonFieldType =
  | 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object'
  | 'oid' | 'date' | 'decimal128' | 'long' | 'opaque';

// 자동 EJSON 모드 감지의 신호로 쓰는 타입 — oid도 MongoDB/EJSON 데이터임을 보여주는 신호이므로 포함
const EXTENDED_TYPES: JsonFieldType[] = ['oid', 'date', 'decimal128', 'long', 'opaque'];

export const getFieldType = (v: JsonValue): JsonFieldType => {
  const kind = valueKind(v);
  if (kind === 'int32' || kind === 'double') return 'number';
  return kind;
};

// node(및 그 하위 전체)에 ObjectId/Date/Decimal128/Long 중 하나라도 있으면 true —
// 새 컬럼이 마운트될 때 EJSON 토글의 자동 기본값으로 쓴다.
export const hasExtendedTypes = (node: JsonValue): boolean => {
  const type = getFieldType(node);
  if (EXTENDED_TYPES.includes(type)) return true;
  if (type !== 'object' && type !== 'array') return false;
  return getEntries(node).some(({ value }) => hasExtendedTypes(value));
};

// 래퍼({$numberInt} 등)는 리프다 — 그 안으로는 내려가지 않는다
export const resolveAtPath = (doc: Document, path: string[]): JsonValue => {
  let node: JsonValue = doc;
  for (const seg of path) {
    if (!isContainer(node)) return null;
    if (Array.isArray(node)) {
      node = node[Number(seg)] ?? null;
    } else {
      node = node[seg] ?? null;
    }
  }
  return node;
};

export const isExpandableType = (t: JsonFieldType): boolean => t === 'object' || t === 'array';

export const getEntries = (node: JsonValue): { key: string; value: JsonValue }[] => {
  if (!isContainer(node)) return [];
  if (Array.isArray(node)) {
    return node.map((v, i) => ({ key: String(i), value: v }));
  }
  return Object.entries(node).map(([k, v]) => ({ key: k, value: v }));
};
