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
  LiveLogEntry,
  LiveStatus,
  Diagnostics,
  ServerSettings,
  LiveView,
  MutationRequest,
  MutationResult,
  ReferenceInfo,
  ServerMetrics,
} from '../types/explorer';

export type ClientMetrics = ServerMetrics & { rttMs: number | null };

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
  // 가장 최근 mutate 하나를 되돌린다(여러 번 부르면 그 전 것도 — 개수는 설정 › Safety). 되돌릴 게 없으면 false.
  // (Mock은 스냅샷 복원, 실제 서버는 서버가 돌려준 역연산을 보낸다 — 문서/필드 쓰기만. 컬렉션·DB 연산을 지나면 끊긴다)
  undoLast(): Promise<boolean>;
  // 지금 되돌릴 수 있는가 — 저장 알림에 Undo 버튼을 띄울지
  canUndo(): boolean;

  // ── 실시간 ──
  // 지금 보는 범위를 알린다 — 그 컬렉션의 문서 변경은 자세히, 같은 DB의 다른 컬렉션은 요약으로 온다.
  // Mock은 바깥에서 바뀔 일이 없으므로 아무 이벤트도 보내지 않는다.
  setLiveView(view: LiveView): void;
  // 반환값을 부르면 구독 해제
  onLiveChange(listener: (change: LiveChange) => void): () => void;
  onLiveStatus(listener: (status: LiveStatus) => void): () => void;

  // ── 활동 패널 ──
  // 클러스터 전체 변경 기록(값 없이). 첫 호출엔 서버가 기억하는 최근 기록을 한 번에(isBacklog=true),
  // 이후엔 한 건씩. 구독자가 없으면 서버도 보내지 않는다. Mock은 기록이 없다.
  onActivityLog(listener: (entries: LiveLogEntry[], isBacklog: boolean) => void): () => void;
  // 서버 지표 + 브라우저↔서버 왕복 시간. Mock은 null.
  getMetrics(): Promise<ClientMetrics | null>;
  // 설정 창의 진단(서버·MongoDB·changeStream·권한·보안 설정 읽기 전용). Mock은 서버가 없으니 null.
  getDiagnostics(): Promise<Diagnostics | null>;

  // ── 안전장치(설정 창 › Safety) ──
  // remote: 서버의 settings.json(모든 브라우저 공통, /mutate가 이걸로 거절). mock: 이 브라우저의 localStorage.
  getServerSettings(): Promise<ServerSettings>;
  saveServerSettings(next: ServerSettings): Promise<ServerSettings>;
  // 다른 탭·기기에서 바꿔도 알려 준다
  onServerSettings(listener: (settings: ServerSettings) => void): () => void;

  // ── 메타데이터: 이 앱이 직접 만든 '고유 oid' (참조가 아닌 식별자 값) ──
  listOwnedOids(): Promise<string[]>;
  setOwnedOid(oid: string, owned: boolean): Promise<void>;
}
