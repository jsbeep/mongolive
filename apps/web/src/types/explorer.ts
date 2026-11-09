// 웹 전용 타입 + 공유 계약 재노출. 값/계약 타입의 원본은 @mongolive/shared에 있다.
import type { CollectionExport, Document, EjsonObject, EjsonValue, OidValue } from '@mongolive/shared';

export * from '@mongolive/shared';

// 기존 이름 유지용 별칭 — 값은 전부 Canonical EJSON이다
export type JsonValue = EjsonValue;
export type JsonObject = EjsonObject;
export type BsonObjectId = OidValue;

// ── Mock Storage 구조 (Mock 데이터 소스 내부 전용) ─────────────────────────────

export interface MockCollectionRecord extends CollectionExport {
  documents: Document[];
  updatedAt: number;
}

export interface MockDatabaseRecord {
  name: string;
  label: string;
  description: string;
  collections: Record<string, MockCollectionRecord>;
  updatedAt: number;
}

export interface MockSnapshot {
  version: number;
  activeDatabase: string;
  databases: Record<string, MockDatabaseRecord>;
  updatedAt: number;
}

// pipeline / output = aggregation 모드 — [collections, pipeline, output, json(결과 문서)…]
export type ColumnKind = 'collections' | 'documents' | 'json' | 'pipeline' | 'output';

export interface ActivePathComp {
  id: number;
  direction: 1 | -1;
}

interface BaseActivePath {
  columnKind: ColumnKind;
  label: string;
  comp: ActivePathComp;
}

export interface NormalActivePath extends BaseActivePath {
  kind: 'normal';
  databaseName?: string;
  collectionName?: string;
  documentOid?: string;
  projectionPath?: string[];
  // output 컬럼: 어느 스테이지까지의 출력인가(services/pipelines의 스테이지 id)
  stageId?: string;
  // aggregation 결과 문서의 루트 json 컬럼: 출력 목록에서 몇 번째(0부터) — 읽기만, documentOid 없음
  resultIndex?: number;
}

export type RefLocator =
  | { kind: 'oid'; oid: string }
  | { kind: 'field'; database: string; collection: string; key: string; value: JsonValue };

export interface ReferenceActivePath extends BaseActivePath {
  kind: 'reference';
  columnKind: 'json';
  ref: RefLocator;
  projectionPath: string[];
  chainColor: string;
  chainIndex: number;
}

export type ActivePath = NormalActivePath | ReferenceActivePath;

// ── Breadcrumb (UI) ───────────────────────────────────────────────────────────

export interface ExplorerPathSegment {
  key: string;
  label: string;
  kind: 'database' | 'collection' | 'document' | 'field' | 'pipeline' | 'stage';
  chainColor?: string;
}

// ── 연결 상태 ─────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
