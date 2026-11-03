// 웹 ↔ 데이터 소스(Mock / 실제 서버) 사이의 계약. 값은 전부 Canonical EJSON(ejson.ts).
import type { EjsonObject, EjsonValue } from './ejson';

// 문서 루트. _id는 옵션 — plain JSON 문서는 _id가 없을 수 있다(그땐 PK 선언 → 배열 인덱스 순으로 식별).
export type Document = EjsonObject & { _id?: EjsonValue };

export interface ReferenceFieldConfig {
  targetCollection: string;
  targetKey: string;
}

// ── 조회 응답 ────────────────────────────────────────────────────────────────

export interface ConnectionConfig {
  database?: string;
}

export interface DatabaseSummary {
  name: string;
  label: string;
  description: string;
  collectionCount: number;
  documentCount: number;
  updatedAt: number;
}

export interface ConnectionResult {
  status: 'connected';
  connectedAt: number;
  activeDatabase: string;
  databases: DatabaseSummary[];
}

export interface CollectionSummary {
  name: string;
  label: string;
  description: string;
  documentCount: number;
  sizeMb: number;
  updatedAt: number;
  titleKey?: string;
  primaryKey?: string;
  referenceFields?: Record<string, ReferenceFieldConfig>;
  // 문서 중 하나라도 _id가 $oid 모양이면 true — PK 버튼 잠금(=_id) 판정에 사용
  hasOidIds?: boolean;
  // 문서 중 하나라도 (선언된 PK 또는 기본값 _id) 필드가 없으면 true — PK 버튼 경고 표시에 사용
  hasPrimaryKeyGaps?: boolean;
}

export interface DocumentSummary {
  id: string;
  title: string;
  preview: string;
  fieldCount: number;
  updatedAt: number;
}

export interface ReferenceInfo {
  databaseName: string;
  collectionName: string;
  collectionLabel: string;
  documentTitle: string;
}

export interface FieldReferenceCandidate {
  database: string;
  collection: string;
  documentId: string;
  documentTitle: string;
}

export interface FieldValueCandidate {
  value: EjsonValue;
  title: string;
}

// 컬렉션 내보내기 — 메타데이터(PK/FK 선언 포함)까지 담아서 다시 가져오면 그대로 복원된다
export interface CollectionExport {
  name: string;
  label: string;
  description: string;
  documents: Document[];
  titleKey?: string;
  primaryKey?: string;
  referenceFields?: Record<string, ReferenceFieldConfig>;
}

// ── 변경 이벤트 ──────────────────────────────────────────────────────────────

export interface FriendlyPatchEvent {
  field: string;
  op: 'updated' | 'added' | 'removed';
  oldValue?: EjsonValue;
  newValue?: EjsonValue;
}

export type ChangeResponse =
  | { type: 'patch'; database: string; collection: string; patch: FriendlyPatchEvent[]; tracePath: string[] }
  | { type: 'replace'; database: string; collection: string; data: Document[]; tracePath: string[] }
  | { type: 'invalidate'; database: string; collection: string; tracePath: string[] }
  | { type: 'system'; message: string; tracePath: string[] };

// ── 변경 요청 ────────────────────────────────────────────────────────────────

export interface MutateFieldSpec {
  path: string[];
  key: string;
  action: 'add' | 'edit' | 'delete';
  value?: EjsonValue;
  nextKey?: string;
  containerType?: 'object' | 'array';
}

type CollectionSeed = {
  name: string;
  label: string;
  description: string;
  // 아직 정규화 전일 수 있는 입력(파일 드롭, 샘플 데이터) — 데이터 소스가 Canonical로 바꿔 저장한다
  documents: unknown[];
  titleKey?: string;
  primaryKey?: string;
  referenceFields?: Record<string, ReferenceFieldConfig>;
};

export type MutationRequest =
  | { type: 'createDatabase'; database: { name: string; label: string; description: string; collections?: Record<string, CollectionSeed> } }
  | { type: 'deleteDatabase'; database: string }
  | { type: 'createCollection'; database: string; collection: { name: string; label: string; description: string; documents?: unknown[] } }
  | { type: 'renameCollection'; database: string; oldName: string; newName: string; label: string }
  | { type: 'duplicateCollection'; database: string; collection: string }
  | { type: 'deleteCollection'; database: string; collection: string }
  | { type: 'setCollectionTitleKey'; database: string; collection: string; titleKey: string }
  | { type: 'setCollectionPrimaryKey'; database: string; collection: string; primaryKey: string }
  | { type: 'setCollectionReferenceField'; database: string; collection: string; field: string; targetCollection?: string; targetKey?: string }
  // document는 _id 없이 들어와도 됨 — 데이터 소스가 채운다
  | { type: 'upsertDocument'; database: string; collection: string; document: Record<string, unknown> }
  | { type: 'duplicateDocument'; database: string; collection: string; documentId: string }
  | { type: 'deleteDocument'; database: string; collection: string; documentId: string }
  | { type: 'mutateField'; database: string; collection: string; documentId: string; field: MutateFieldSpec };

export interface MutationResult {
  status: 'ok';
  changedPaths: string[];
  tracePath: string[];
  collectionKey?: string;
}

// 컬렉션 식별 키 — 구독 키, getDocuments 인자, changedPaths 접두에 공통으로 쓴다
export const collectionKey = (databaseName: string, collectionName: string): string => `${databaseName}.${collectionName}`;
