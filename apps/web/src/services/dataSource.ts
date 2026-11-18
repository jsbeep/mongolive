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
  JsonObject,
  JsonValue,
  ExplainSummary,
  LiveChange,
  LiveLogEntry,
  LiveStatus,
  Diagnostics,
  ServerSettings,
  LiveView,
  MutationRequest,
  MutationResult,
  ReferenceInfo,
  MonitorSnapshot,
  MonitorTick,
  ActivityRange,
  ActivityReport,
  LastWrites,
  HistoryInfo,
  HistoryReport,
  MonitorRange,
  BackfillReport,
  OperationsReport,
  IndexesReport,
  SizesReport,
  SlowQueriesReport,
  SlowThreshold,
  TopReport,
  TransactionsReport,
  OplogReport,
  ReplicaReport,
  StartupWarningsReport,
  AlertsReport,
  MonitorAlert,
  AggregateResult,
  AggregateCounts,
  ConnectionInfo,
  ConnectionInput,
  ConnectionTestRequest,
  ConnectionTestResult,
  CollectionMetadata,
  MetadataImportResult,
} from '../types/explorer';

// Monitor 화면 구독 — 처음 한 번 최근 기록(backlog), 이후 10초마다 한 칸(sample)
export type MonitorEvent = { kind: 'backlog'; snapshot: MonitorSnapshot } | { kind: 'sample'; tick: MonitorTick };

export interface DataSource {
  // ── 저장된 연결(8-4) ──
  // 이 탭이 쓰는 연결은 services/activeConnection이 들고 있고, 데이터 소스는 요청마다 그 id를 서버에 알린다.
  // Mock(데모)은 브라우저 안 데이터 하나뿐 — 'demo' 연결 하나만 있고 추가·수정·삭제는 거절한다
  canManageConnections: boolean;
  listConnections(): Promise<ConnectionInfo[]>;
  createConnection(input: ConnectionInput): Promise<ConnectionInfo>;
  updateConnection(id: string, input: ConnectionInput): Promise<ConnectionInfo>;
  deleteConnection(id: string): Promise<void>;
  // 접속해 보고 서버 종류·버전·지연을 돌려준다(저장 안 함). 저장된 연결이면 id로 — 가린 비밀 값을 서버가 채운다
  testConnection(request: ConnectionTestRequest): Promise<ConnectionTestResult>;
  // 다른 탭·기기에서 연결을 추가·수정·삭제해도 알려 준다
  onConnections(listener: (connections: ConnectionInfo[]) => void): () => void;

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

  // ── Aggregation(읽기만, 서버 연결에서만 — Mock은 거절) ──
  // pipeline은 Canonical EJSON. counts = 스테이지 카드의 개수(들어오는 문서 + 스테이지마다 지난 문서)
  // 쿼리 바의 Explain(9-9) — find(쿼리).explain('executionStats') 요약. Mock은 실패(실제 연결에서만)
  explainQuery(database: string, collection: string, mongoFilter: JsonObject): Promise<ExplainSummary>;
  aggregate(database: string, collection: string, pipeline: JsonValue[]): Promise<AggregateResult>;
  // signal — 화면의 Cancel(요청을 끊으면 서버도 다음 스테이지부터 세지 않는다)
  aggregateCounts(database: string, collection: string, pipeline: JsonValue[], signal?: AbortSignal): Promise<AggregateCounts>;

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

  // ── Monitor 화면(9단계) ──
  // 서버 연결에서만 된다 — Mock(데모)은 잴 MongoDB 서버가 없어 false
  supportsMonitor: boolean;
  // 서버가 이 연결의 지표(serverStatus + ping)를 10초마다 잰 것. 구독자가 없으면 서버도 보내지 않는다. 반환값을 부르면 해제
  onMonitor(listener: (event: MonitorEvent) => void): () => void;
  // 브라우저 ↔ mongolive 서버 왕복(ms). 2초 안에 응답이 없거나 Mock이면 null
  measureRtt(): Promise<number | null>;
  // Monitor › Collections(9-2) — changeStream으로 본 쓰기의 집계(범위: 서버 전체 / DB / 컬렉션). Mock은 null
  getActivity(scope: { database: string | null; collection: string | null }, range: ActivityRange): Promise<ActivityReport | null>;
  // 컬렉션별 마지막 쓰기(사이드바 트리, Monitor를 보는 동안). Mock은 null
  getLastWrites(): Promise<LastWrites | null>;
  // 설정 › Monitor(9-3) — 이 연결의 기록 파일 크기·가장 오래된 기록 / 전부 지우기. Mock은 null / 아무것도 안 함
  getHistoryInfo(): Promise<HistoryInfo | null>;
  // Monitor의 긴 기간(24h~All, 9-3b) — 기록 파일을 칸으로 묶은 것. writes = 컬렉션별 쓰기도(Collections 탭). Mock은 null
  getHistory(range: Exclude<MonitorRange, '5m' | '1h'>, options?: { writes?: boolean; database?: string | null; collection?: string | null }): Promise<HistoryReport | null>;
  clearHistory(): Promise<void>;
  // 빈 구간 불러오기(9-4) — 탭이 없던 동안의 쓰기를 changeStream으로 다시 읽는다. id가 없으면 전부. Mock은 null / 아무것도 안 함
  getBackfill(): Promise<BackfillReport | null>;
  startBackfill(id?: string): Promise<BackfillReport | null>;
  stopBackfill(id?: string): Promise<BackfillReport | null>;
  // 바뀔 때마다(불러오는 중엔 1초에 한 번). 반환값을 부르면 해제
  onBackfill(listener: (report: BackfillReport) => void): () => void;
  // Monitor › Operations(9-5a) — 지금 실행 중인 작업($currentOp) / 하나 멈추기(killOp). Mock은 null / 아무것도 안 함
  getOperations(scope: { database: string | null; collection: string | null }): Promise<OperationsReport | null>;
  killOperation(opid: string): Promise<void>;
  // Monitor › Operations › 느린 쿼리 — 서버가 MongoDB 로그에서 모은 것(9-5b). Mock은 null
  //   expand = 펼친 그룹 키 — 그 그룹의 실행에만 명령(command)이 실려 온다(9-10, 응답 크기)
  getSlowQueries(query: {
    database: string | null;
    collection: string | null;
    range: MonitorRange;
    min: SlowThreshold;
    expand?: string | null;
  }): Promise<SlowQueriesReport | null>;
  // Slow 카드가 떠 있는 동안 — 서버가 로그를 10초마다 읽는다(아니면 30초, 탭이 숨으면 60초). 돌려준 함수로 끝낸다. Mock은 아무것도 안 함
  watchSlowCard(): () => void;
  // Monitor › Collections의 크기(9-6a) — 서버가 1시간마다 잰 것 / 지금 재기(true = 시작함). Mock은 null / false
  getSizes(query: { database: string | null; collection: string | null; range: MonitorRange }): Promise<SizesReport | null>;
  measureSizes(): Promise<boolean>;
  // 컬렉션 범위의 Indexes 카드(9-6b) — 인덱스 정의·쓰인 횟수·크기를 그때그때. Mock은 null
  getIndexes(database: string, collection: string): Promise<IndexesReport | null>;
  // Collections의 Time spent 카드(9-6c) — top으로 본 컬렉션별 서버 시간(최근 1시간 메모리). Mock은 null
  getTop(query: { database: string | null; collection: string | null; range: '5m' | '1h' }): Promise<TopReport | null>;
  // Server 탭의 Members(9-7a) — replSetGetStatus로 본 멤버·lag·상태 변화(최근 1시간 메모리). Mock은 null
  getReplica(range: '5m' | '1h'): Promise<ReplicaReport | null>;
  // Server 탭의 Oplog·Startup warnings(9-7b) — 연결한 멤버에게 그때그때 묻는다. Mock은 null
  getOplog(): Promise<OplogReport | null>;
  getStartupWarnings(): Promise<StartupWarningsReport | null>;
  // 알림(9-8a) — 서버가 changeStream 이벤트로 찾은 대량 삭제·쓰기 폭주·삭제. Mock은 null / 아무것도 안 함
  getAlerts(query: { database: string | null; collection: string | null; range: MonitorRange }): Promise<AlertsReport | null>;
  // 새 실시간 알림 — 이 연결을 쓰는 모든 탭에 온다(앱 어디서나 토스트). 반환값을 부르면 해제
  onAlert(listener: (alert: MonitorAlert) => void): () => void;
  // 트랜잭션(9-8b) — 서버가 changeStream 이벤트로 센 것, 최근 1시간 메모리만. Mock은 null
  getTransactions(query: { database: string | null; collection: string | null; range: '5m' | '1h' }): Promise<TransactionsReport | null>;
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

  // ── 메타데이터 내보내기/가져오기(설정 › Data 백업) — 지금 연결의 제목 필드·PK·FK 선언 ──
  // 가져오기는 합치기: 받은 컬렉션만 바꾸고, 지금 연결에 없는 컬렉션은 건너뛴다(shared/metadata)
  getCollectionMetadata(): Promise<CollectionMetadata>;
  importCollectionMetadata(collections: CollectionMetadata): Promise<MetadataImportResult>;
}
