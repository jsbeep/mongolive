// 컬렉션 메타데이터(제목 필드·PK·FK 선언) 내보내기/가져오기 — 설정 › Data 백업 파일에 '이 연결의 메타데이터'로 들어간다.
//   GET  /api/meta/collections  → CollectionMetadata(지금 연결의 것 전부)
//   POST /api/meta/collections  { collections } → MetadataImportResult
// 가져오기는 '합치기': 파일에 있는 컬렉션은 그 선언으로 바꾸고, 파일에 없는 컬렉션은 그대로 둔다.
// 지금 연결에 없는 컬렉션은 건너뛴다(없는 컬렉션에 메타를 쌓지 않는다 — 선언 연산과 같은 규칙).
// '내가 만든 oid' 목록은 그 클러스터의 문서에 묶인 정보라 넣지 않는다.
import type { ReferenceFieldConfig } from './contract';

export interface CollectionMeta {
  titleKey?: string;
  primaryKey?: string;
  referenceFields?: Record<string, ReferenceFieldConfig>;
}

// 키: collectionKey "db.collection"
export type CollectionMetadata = Record<string, CollectionMeta>;

export interface MetadataImportResult {
  // 적용한 컬렉션 / 지금 연결에 없어 건너뛴 컬렉션 (collectionKey)
  applied: string[];
  skipped: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// "db.collection" → [db, collection]. DB 이름엔 '.'이 못 들어가므로 첫 '.'에서 자른다(컬렉션 이름엔 '.'이 있을 수 있다)
export const splitCollectionKey = (key: string): [string, string] | null => {
  const dot = key.indexOf('.');
  if (dot <= 0 || dot === key.length - 1) return null;
  return [key.slice(0, dot), key.slice(dot + 1)];
};

// 빈 값은 지운다 — 남는 게 없으면 undefined
export const compactCollectionMeta = (meta: CollectionMeta): CollectionMeta | undefined => {
  const out: CollectionMeta = {};
  if (meta.titleKey) out.titleKey = meta.titleKey;
  if (meta.primaryKey) out.primaryKey = meta.primaryKey;
  if (meta.referenceFields && Object.keys(meta.referenceFields).length > 0) out.referenceFields = meta.referenceFields;
  return Object.keys(out).length > 0 ? out : undefined;
};

// 바깥에서 온 값(파일·요청 본문) → CollectionMetadata. 모양이 틀린 항목·값은 버린다
export const normalizeCollectionMetadata = (raw: unknown): CollectionMetadata => {
  const result: CollectionMetadata = {};
  if (!isObject(raw)) return result;
  for (const [key, value] of Object.entries(raw)) {
    if (!splitCollectionKey(key) || !isObject(value)) continue;
    const meta: CollectionMeta = {};
    if (typeof value.titleKey === 'string' && value.titleKey.trim()) meta.titleKey = value.titleKey.trim();
    if (typeof value.primaryKey === 'string' && value.primaryKey.trim()) meta.primaryKey = value.primaryKey.trim();
    if (isObject(value.referenceFields)) {
      const refs: Record<string, ReferenceFieldConfig> = {};
      for (const [field, ref] of Object.entries(value.referenceFields)) {
        if (field && isObject(ref) && typeof ref.targetCollection === 'string' && ref.targetCollection && typeof ref.targetKey === 'string' && ref.targetKey) {
          refs[field] = { targetCollection: ref.targetCollection, targetKey: ref.targetKey };
        }
      }
      meta.referenceFields = refs;
    }
    const compacted = compactCollectionMeta(meta);
    if (compacted) result[key] = compacted;
  }
  return result;
};
