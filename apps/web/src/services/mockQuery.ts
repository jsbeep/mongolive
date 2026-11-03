// path: src/services/mockQuery.ts
import {
  collectionKey,
  getDocumentId,
  INDEX_FALLBACK_PREFIX,
  summarizeDocument,
  projectDocument,
  compareKey,
  idString,
  isOid,
  type DatabaseSummary,
  type Document,
  type JsonValue,
  type MockCollectionRecord,
  type MockDatabaseRecord,
  type MockSnapshot,
} from '../types/explorer';
import { isJsonObject } from './mockClone';

export type CollectionLocation = {
  databaseName: string;
  collectionName: string;
  collection: MockCollectionRecord;
};

export type DocumentLocation = CollectionLocation & {
  documentIndex: number;
  document: Document;
};

export { collectionKey };

export const getDatabaseSummary = (databaseName: string, database: MockDatabaseRecord): DatabaseSummary => {
  let documentCount = 0;
  for (const collection of Object.values(database.collections)) {
    documentCount += collection.documents.length;
  }

  return {
    name: databaseName,
    label: database.label,
    description: database.description,
    collectionCount: Object.keys(database.collections).length,
    documentCount,
    updatedAt: database.updatedAt,
  };
};

export const estimateCollectionSizeMb = (
  documents: Document[],
): number =>
  Number(
    Math.max(
      0.01,
      new Blob([JSON.stringify(documents)]).size / 1_000_000,
    ).toFixed(2),
  );

// 문서 요약/식별자 규칙은 서버와 공유한다(@mongolive/shared/summary)
export { getDocumentId, INDEX_FALLBACK_PREFIX, summarizeDocument };

export const findCollection = (snapshot: MockSnapshot, targetCollectionId: string): CollectionLocation | undefined => {
  for (const [databaseName, database] of Object.entries(snapshot.databases)) {
    for (const [collectionName, collection] of Object.entries(database.collections)) {
      if (targetCollectionId === collectionName || targetCollectionId === collectionKey(databaseName, collectionName)) {
        return {
          databaseName,
          collectionName,
          collection,
        };
      }
    }
  }

  return undefined;
};

export const findDocument = (snapshot: MockSnapshot, oid: string): DocumentLocation | undefined => {
  for (const [databaseName, database] of Object.entries(snapshot.databases)) {
    for (const [collectionName, collection] of Object.entries(database.collections)) {
      for (let documentIndex = 0; documentIndex < collection.documents.length; documentIndex += 1) {
        const document = collection.documents[documentIndex];
        if (isOid(document._id) && document._id.$oid === oid) {
          return {
            databaseName,
            collectionName,
            collection,
            documentIndex,
            document,
          };
        }
      }
    }
  }

  return undefined;
};

// 문서 identity — plain string/number _id도 식별자로 인정한다(전역 $oid REF 시스템인
// findDocument/checkReference는 oid만 보도록 별도로 inline 비교를 쓰고 이 함수에 의존하지 않는다).
// mutate/delete/duplicate/upsert 같은 "문서 자체를 가리키는" 경로에서 쓴다.
//
export const findDocumentById = (
  snapshot: MockSnapshot,
  databaseName: string,
  collectionName: string,
  documentId: string,
): DocumentLocation | undefined => {
  const collection = snapshot.databases[databaseName]?.collections[collectionName];
  if (!collection) {
    return undefined;
  }

  for (let documentIndex = 0; documentIndex < collection.documents.length; documentIndex += 1) {
    const document = collection.documents[documentIndex];
    if (getDocumentId(document, collection.primaryKey, documentIndex) === documentId) {
      return { databaseName, collectionName, collection, documentIndex, document };
    }
  }

  return undefined;
};

// FK 값 입력 보조용 — 타겟 컬렉션의 targetKey 필드가 가질 수 있는 값 후보 목록
// (key가 '_id'면 oid든 plain이든 getDocumentId로, 그 외엔 그 필드의 원시값으로)
export const findFieldValueCandidates = (
  snapshot: MockSnapshot,
  databaseName: string,
  collectionName: string,
  key: string,
): { value: JsonValue; title: string }[] => {
  const collection = snapshot.databases[databaseName]?.collections[collectionName];
  if (!collection) {
    return [];
  }

  const candidates: { value: JsonValue; title: string }[] = [];
  for (let index = 0; index < collection.documents.length; index += 1) {
    const document = collection.documents[index];
    // '_id'면 oid든 plain이든 원래 값 그대로 후보로 낸다 — FK 필드에 저장될 값과 같은 모양이어야
    // compareKey 매칭이 맞는다(예전엔 getDocumentId 문자열을 내서 oid _id가 문자열로 바뀌어 저장됐다)
    const value = key === '_id'
      ? (document._id ?? (collection.primaryKey ? document[collection.primaryKey] : undefined))
      : document[key];
    if (value === undefined || value === null || value === '') continue;
    const summary = summarizeDocument(document, collection.updatedAt, collection.titleKey, collection.primaryKey, index);
    candidates.push({ value: value as JsonValue, title: summary.title });
  }
  return candidates;
};

// 필드 기반 참조(FK) 조회 — findDocument(oid 전역 검색)와 달리 DB/컬렉션이 이미 선언으로
// 고정돼 있고, PK 유니크를 강제하지 않으므로 매치를 전부 모아 반환한다(중복 시 후보로 노출).
export const findDocumentsByField = (
  snapshot: MockSnapshot,
  databaseName: string,
  collectionName: string,
  key: string,
  value: JsonValue,
): DocumentLocation[] => {
  const collection = snapshot.databases[databaseName]?.collections[collectionName];
  if (!collection) {
    return [];
  }

  // 값 비교는 compareKey로 — Canonical에선 숫자/oid가 전부 객체라 ===로는 절대 같지 않다.
  // MongoDB equality와 같은 규칙(5 == 5.0, "5" != 5)이라 실제 DB로 바꿔도 결과가 같다.
  //
  // '_id' 대상만 두 가지를 의도적으로 느슨하게 맞춘다(실제 서버에선 {$in:[문자열, ObjectId(문자열)]}로 재현):
  //  ① FK에 oid를 hex 문자열로 저장한 흔한 실데이터 — {$oid:"abc…"} ↔ "abc…"
  //  ② _id 없는 plain 문서 — 선언된 PK 값(getDocumentId)과 비교
  const targetKey = compareKey(value);
  const targetIdString = idString(value);
  const matchesId = (document: Document, documentIndex: number): boolean => {
    if (document._id !== undefined) {
      if (compareKey(document._id) === targetKey) return true;
      return isOid(document._id) && typeof value === 'string' && document._id.$oid === value.toLowerCase();
    }
    return targetIdString !== undefined && getDocumentId(document, collection.primaryKey, documentIndex) === targetIdString;
  };
  const matches: DocumentLocation[] = [];
  for (let documentIndex = 0; documentIndex < collection.documents.length; documentIndex += 1) {
    const document = collection.documents[documentIndex];
    const isMatch = key === '_id' ? matchesId(document, documentIndex) : compareKey(document[key]) === targetKey;
    if (isMatch) {
      matches.push({ databaseName, collectionName, collection, documentIndex, document });
    }
  }

  return matches;
};

// 프로젝션은 서버 연결(RemoteDataSource)과 공유한다(@mongolive/shared/projection)
export { projectDocument };
