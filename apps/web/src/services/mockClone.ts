// path: src/services/mockClone.ts
import {
  isEjsonObject,
  isOid,
  makeOid,
  toCanonical,
  valueKind,
  type Document,
  type JsonObject,
  type JsonValue,
} from '../types/explorer';
import { generateObjectId } from '../utils/objectId';

// 펼칠 수 있는 진짜 객체만 true — {$oid}, {$numberInt} 같은 EJSON 래퍼는 제외
export const isJsonObject = (value: unknown): value is JsonObject => isEjsonObject(value);

// 컨테이너(객체/배열)만 새로 만들고 래퍼 리프는 참조를 그대로 둔다 — 래퍼는 절대
// 제자리 수정하지 않으므로(항상 통째로 교체) 공유해도 안전하다.
export const cloneValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }

  if (isJsonObject(value)) {
    const next: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = cloneValue(child);
    }
    return next;
  }

  return value;
};

export const cloneDocument = (document: Document): Document => cloneValue(document) as Document;

// 외부에서 들어온 문서(파일 드롭, 샘플, 편집기 입력)를 Canonical 문서로 정규화한다
export const canonicalDocument = (raw: unknown): Document => {
  const value = toCanonical(raw);
  if (!isJsonObject(value)) {
    throw new Error('Document must be a JSON object');
  }
  return value as Document;
};

// _id가 유효한 {$oid}거나 비어있지 않은 문자열/숫자면 그대로 둔다.
// 없거나 깨져있을 때: forceOid가 true면(이 컬렉션/배치에 이미 oid _id가 있어서 일관성을
// 맞춰야 할 때) 새 oid를 채우고, 아니면 손대지 않는다(plain JSON은 _id 없이 raw 그대로 —
// PK를 선언하기 전까진 식별자가 따로 필요 없다, 필요하면 배열 인덱스로 fallback).
export const ensureDocumentId = (document: Document, forceOid = false): Document => {
  const candidate = document._id;
  const kind = valueKind(candidate);
  const hasUsableId =
    isOid(candidate) ||
    (kind === 'string' && (candidate as string).trim() !== '') ||
    kind === 'int32' || kind === 'long' || kind === 'double' || kind === 'decimal128';

  if (hasUsableId) {
    return document;
  }
  if (forceOid) {
    return { ...document, _id: makeOid(generateObjectId()) };
  }
  return document;
};
