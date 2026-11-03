// 앱이 데이터에 접근하는 유일한 표면. 컴포넌트/훅은 mock* 모듈을 직접 import하지 말고
// services/api.ts의 `api`만 쓴다 — 그래야 Mock ↔ 실제 서버 구현을 갈아끼울 수 있다.
import type {
  CollectionExport,
  CollectionSummary,
  ConnectionConfig,
  ConnectionResult,
  DatabaseSummary,
  Document,
  DocumentPage,
  DocumentQuery,
  FieldReferenceCandidate,
  FieldValueCandidate,
  JsonValue,
  LiveChange,
  LiveStatus,
  LiveView,
  MutationRequest,
  MutationResult,
  ReferenceInfo,
} from '../types/explorer';

export interface DataSource {
  // ── 연결 / 목록 ──
  connect(config: ConnectionConfig): Promise<ConnectionResult>;
  listDatabases(): Promise<DatabaseSummary[]>;
  getCollections(database: string): Promise<CollectionSummary[]>;
  // collectionId는 collectionKey(database, collection) 형식. 필터·정렬·페이지는 데이터 소스가 처리한다.
  getDocuments(collectionId: string, query?: DocumentQuery): Promise<DocumentPage>;

  // ── 문서 ──
  getDocumentById(oid: string, projectionPath?: string[]): Promise<Document>;
  getFullDocumentById(oid: string): Promise<Document>;
  getFullDocumentByIdInCollection(database: string, collection: string, documentId: string): Promise<Document>;
  exportCollection(database: string, collection: string): Promise<CollectionExport>;

  // ── 참조 ──
  checkReference(oid: string): Promise<boolean>;
  getReferenceInfo(oid: string): Promise<ReferenceInfo | null>;
  getReferenceCandidatesByField(database: string, collection: string, key: string, value: JsonValue): Promise<FieldReferenceCandidate[]>;
  getFieldValueCandidates(database: string, collection: string, key: string): Promise<FieldValueCandidate[]>;

  // ── 쓰기 ──
  mutate(op: MutationRequest): Promise<MutationResult>;
  // 직전 mutate 한 번을 되돌린다. 되돌릴 게 없으면 false.
  // (Mock은 스냅샷 복원, 실제 서버는 서버가 돌려준 역연산을 보낸다)
  undoLast(): Promise<boolean>;

  // ── 실시간 ──
  // 지금 보는 범위를 알린다 — 그 컬렉션의 문서 변경은 자세히, 같은 DB의 다른 컬렉션은 요약으로 온다.
  // Mock은 바깥에서 바뀔 일이 없으므로 아무 이벤트도 보내지 않는다.
  setLiveView(view: LiveView): void;
  // 반환값을 부르면 구독 해제
  onLiveChange(listener: (change: LiveChange) => void): () => void;
  onLiveStatus(listener: (status: LiveStatus) => void): () => void;

  // ── 메타데이터: 이 앱이 직접 만든 '고유 oid' (참조가 아닌 식별자 값) ──
  listOwnedOids(): Promise<string[]>;
  setOwnedOid(oid: string, owned: boolean): Promise<void>;
}
