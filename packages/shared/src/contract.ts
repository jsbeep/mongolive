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
}

export interface DocumentSummary {
  id: string;
  title: string;
  preview: string;
  fieldCount: number;
  updatedAt: number;
}

// ── 문서 목록 페이지 ──────────────────────────────────────────────────────────

// 한 페이지(문서 목록)·한 화면(필드 목록)에 보여 줄 개수. 둘이 같은 단위를 쓴다.
export const PAGE_SIZE = 10;

export type DocumentSort =
  | 'none'
  | 'title-asc'
  | 'title-desc'
  | 'fields-desc'
  | 'fields-asc'
  | 'updated-desc'
  | 'updated-asc';

export interface DocumentQuery {
  // 0부터 시작
  page?: number;
  pageSize?: number;
  // 제목/미리보기에 포함된 글자(대소문자 무시)
  filter?: string;
  sort?: DocumentSort;
  // 이 id의 문서가 들어 있는 페이지를 달라 — 참조를 따라 다른 페이지의 문서로 이동할 때.
  // 그 문서가 (필터 결과에) 없으면 page를 그대로 쓴다.
  aroundId?: string;
  // 이 id의 문서가 몇 페이지에 있는지 알려 달라(응답의 markedPage) — 현재 선택된 문서의 페이지를 레일에 표시
  markId?: string;
  // 사용자가 쓴 쿼리(MongoDB find의 filter, Canonical EJSON). 서버 연결에서만 된다 —
  // validateQueryFilter(queryFilter.ts)를 통과해야 하고, filter(글자 검색)는 이 결과에 한 번 더 걸린다
  mongoFilter?: EjsonObject;
}

export interface DocumentPage {
  items: DocumentSummary[];
  page: number;
  pageSize: number;
  // 필터 적용 후 개수
  total: number;
  // 필터 적용 전 컬렉션 전체 개수(쿼리가 있으면 컬렉션 메타데이터의 추정치)
  totalUnfiltered: number;
  // markId 문서가 있는 페이지(필터 결과에 없으면 없음)
  markedPage?: number;
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

// ── 실시간(서버 changeStream → socket.io) ─────────────────────────────────────
// 소켓 이벤트: 클라이언트 → 서버 'connection:use'(연결 id, 먼저) 다음 'view'(LiveView)
//              서버 → 클라이언트 'change'(LiveChange)·'status'(LiveStatus)·'connections'(ConnectionInfo[])
// 실시간은 연결마다 따로다 — 'connection:use'로 고른 연결의 변경·상태만 받는다

export type LiveOperation =
  | 'insert' | 'update' | 'replace' | 'delete'      // 문서
  | 'create' | 'drop' | 'rename' | 'dropDatabase';  // 컬렉션/DB 구조

// 지금 보고 있는 범위 — 서버는 이 컬렉션의 문서 변경은 자세히, 같은 DB의 다른 컬렉션 변경은 요약만 보낸다
export interface LiveView {
  database: string | null;
  collection: string | null;
}

export interface LiveChange {
  // resume token — 이벤트마다 고유. 로그/중복 제거용
  id: string;
  op: LiveOperation;
  database: string;
  collection?: string;
  // 문서 이벤트: 대상 문서의 식별자 문자열(summary.getDocumentId 규칙)
  documentId?: string;
  // update 이벤트 + 지금 보고 있는 컬렉션일 때만: 바뀐 경로("a.b.0") → 새 값(Canonical)
  updatedFields?: Record<string, EjsonValue>;
  removedFields?: string[];
  truncatedArrays?: { field: string; newSize: number }[];
  // rename 이벤트: 바뀐 이름
  to?: { database: string; collection: string };
  // 트랜잭션 안의 쓰기: 세션 id(lsid, 16진수) + ':' + 그 세션의 트랜잭션 번호(txnNumber) — 같은 값이면 한 트랜잭션(9-8b)
  txn?: string;
  // false = 요약본(updatedFields 등 생략) — 보고 있지 않은 컬렉션의 변경
  detailed: boolean;
  // MongoDB에 기록된 시각 / 서버가 받은 시각(ms) — 지연 측정(PerformanceMetrics)용
  clusterTime: number;
  serverTime: number;
  // 이 쓰기의 시각 도장(MongoDB clusterTime, 쓰기마다 고유) — 내 저장 응답의 opTime과 같으면 '내 변경'
  opTime: string;
  // 브라우저가 붙인다(서버는 안 보냄): 이 탭이 한 저장의 메아리인가
  own?: boolean;
}

export interface LiveStatus {
  // polling = 단독 MongoDB(replica set 아님) — change stream이 없어 실시간은 못 받는다. 브라우저가 주기적으로 다시 받는다
  state: 'connecting' | 'running' | 'polling' | 'error';
  error?: string;
  // true면 이벤트를 놓쳤을 수 있다 — 화면을 전부 다시 받아야 한다
  resync?: boolean;
  // 이 탭이 못 따라와서(회선이 느려 서버 송신 버퍼가 넘침) 서버가 보내지 않고 건너뛴 변경 수 — resync와 같이 온다.
  // 서버는 따라잡은 뒤 이 탭에만 보내고, 활동 패널을 구독 중이면 log:backlog도 다시 보낸다
  skipped?: number;
  // true면 이 탭이 쓰던 연결이 지워졌다 — 화면은 연결 고르기(웰컴)로 돌아간다
  gone?: boolean;
}

// ── 활동 패널(ChangeStreamLogs) ──────────────────────────────────────────────
// 소켓: 클라이언트 → 'log:subscribe' / 'log:unsubscribe', 'rtt'(ack로 응답)
//       서버 → 'log:backlog'(LiveLogEntry[]), 'log'(LiveLogEntry)

// 로그 한 줄 — 값은 빼고 '어디서 무엇이' 바뀌었는지만(패널이 클러스터 전체 변경을 받으므로 가볍게)
export interface LiveLogEntry {
  id: string;
  op: LiveOperation;
  database: string;
  collection?: string;
  documentId?: string;
  // update: 바뀐 경로 / 지운 경로
  paths?: string[];
  removed?: string[];
  to?: { database: string; collection: string };
  // 트랜잭션 안의 쓰기 — LiveChange.txn과 같다
  txn?: string;
  clusterTime: number;
  serverTime: number;
  opTime: string;
  // 브라우저가 붙인다: 이 탭이 한 저장인가(안 읽음으로 세지 않는다)
  own?: boolean;
}

// ── Monitor 화면(9단계) ──────────────────────────────────────────────────────
// 서버가 연결(피드)마다 10초에 한 번 serverStatus + ping을 재서 최근 1시간을 들고 있다(피드가 열려 있는 동안만).
// 소켓: 클라이언트 → 'monitor:subscribe' / 'monitor:unsubscribe'
//       서버 → 'monitor:backlog'(MonitorSnapshot), 'monitor:sample'(MonitorTick)

export type MonitorOp = 'insert' | 'query' | 'update' | 'delete' | 'getmore' | 'command';

// 한 칸을 못 잰 이유 — denied: serverStatus 권한(clusterMonitor) 없음, unreachable: MongoDB에 닿지 않음
export type MonitorProblem = 'denied' | 'unreachable' | 'error';

// 지난 칸과의 차이로 낸 초당 값(serverStatus는 MongoDB가 켜진 뒤의 누적값을 준다)
export interface MonitorRates {
  // 요청 수 — updateMany 하나는 update 1
  ops: Record<MonitorOp, number>;
  // 문서 수 — updateMany로 문서 100개를 바꾸면 updated 100
  docs: { inserted: number; updated: number; deleted: number; returned: number };
  // 그 종류 작업의 평균 지연(ms). 그동안 작업이 없었으면 null
  latencyMs: { reads: number | null; writes: number | null; commands: number | null };
  // 훑은 인덱스 키 / 문서, 컬렉션 전체 훑기(COLLSCAN) 수 — 돌려준 문서보다 훨씬 많이 훑으면 인덱스가 없다는 신호
  scannedKeys: number;
  scannedDocs: number;
  collectionScans: number | null;
  // 새로 맺은 연결 — 계속 높으면 앱이 연결을 재사용(커넥션 풀)하지 않는다
  newConnections: number;
  // 서버 내부 경고·에러 수(user = 중복 키 같은 요청 에러)
  asserts: { regular: number; warning: number; msg: number; user: number };
  network: { inBps: number; outBps: number };
}

export interface MonitorGauges {
  connections: { current: number; available: number } | null;
  memResidentMb: number | null;
}

export interface MonitorSample {
  // 잰 시각(ms)
  at: number;
  problem?: MonitorProblem;
  // mongolive 서버 → MongoDB ping 왕복(ms)
  pingMs: number | null;
  // 첫 칸이거나 MongoDB가 재시작했거나 못 쟀으면 null
  rates: MonitorRates | null;
  gauges: MonitorGauges | null;
  // 이 칸 동안 changeStream으로 받은 이벤트 수, DB 기록 → 서버 수신 지연 p95(ms)
  stream: { events: number; lagP95Ms: number | null };
}

export interface MonitorInfo {
  version: string | null;
  uptimeSec: number | null;
  host: string | null;
  topology: MongoTopology;
}

export interface MonitorSnapshot {
  intervalMs: number;
  // 오래된 것 → 최신
  samples: MonitorSample[];
  info: MonitorInfo;
}

export interface MonitorTick {
  sample: MonitorSample;
  info: MonitorInfo;
}

// ── Monitor › Collections (9-2): changeStream으로 본 쓰기를 서버가 센 것 ──────────
// 이미 열린 스트림의 이벤트를 세기만 한다(DB 부하 없음). 피드가 열린 뒤(since)부터, 메모리에만.
//   GET /api/monitor/activity?database=&collection=&range=5m|1h → ActivityReport
//   GET /api/monitor/last-writes → LastWrites

export type ActivityRange = '5m' | '1h';

export interface ActivityOps {
  insert: number;
  update: number;
  replace: number;
  delete: number;
}

export interface LastWrite {
  at: number;
  op: LiveOperation;
}

export interface ActivityCollection {
  database: string;
  collection: string;
  // 범위(5분/1시간) 안 쓰기 수
  total: number;
  ops: ActivityOps;
  // 분당 쓰기 수(오래된 것 → 최신, 범위의 분 수만큼)
  trend: number[];
  lastWrite: LastWrite | null;
}

export interface ActivityReport {
  // 세기 시작한 시각(피드가 열린 때) — 이보다 앞은 모른다
  since: number;
  range: ActivityRange;
  // 범위 안 1분 칸(오래된 것 → 최신) — 범위(서버 전체/DB/컬렉션) 합계
  timeline: { at: number; ops: ActivityOps }[];
  // 범위 안 컬렉션들(쓰기 수 많은 순). 컬렉션 범위면 그 하나
  collections: ActivityCollection[];
  // 컬렉션 범위일 때만 — 자주 바뀐 필드(update의 바뀐·지운 경로, 배열 번호는 []로 묶음)와 문서. 5분 칸 단위라 범위보다 조금 길 수 있다
  fields?: { path: string; count: number }[];
  documents?: { id: string; count: number }[];
  // 서로 다른 필드·문서가 너무 많아 일부를 세지 못했다
  partial?: boolean;
}

// ── Monitor 기간(9-3b) — 범위 바의 기간 선택. 5m·1h = 서버 메모리(실시간), 그보다 길면 기록 파일 ──
export type MonitorRange = '5m' | '1h' | '24h' | '7d' | '30d' | '90d' | 'all';
export const LIVE_RANGES: readonly MonitorRange[] = ['5m', '1h'];

// 기록 파일의 지표 이름(서버 monitor/rollup과 같다)
export const MONITOR_METRIC_KEYS = [
  'insert', 'query', 'update', 'delete', 'getmore', 'command', // 초당 요청(opcounters)
  'returned', 'inserted', 'updated', 'deleted', // 초당 문서
  'latReads', 'latWrites', 'latCommands', // 평균 지연(ms)
  'scannedKeys', 'scannedDocs', 'collScans', // 초당 훑기
  'newConns', 'asserts', 'userAsserts', // 초당
  'netIn', 'netOut', // 초당 바이트
  'conns', 'memMb', // 그 순간 값
  'ping', 'lag', // ms
  'events', // 초당 changeStream 이벤트
] as const;
export type MonitorMetricKey = (typeof MONITOR_METRIC_KEYS)[number];

export interface HistoryPoint {
  // 칸 시작
  t: number;
  // 들어간 10초 칸 수 — 칸 길이 ÷ 10초보다 작으면 일부만 기록된 칸
  n: number;
  avg: Partial<Record<MonitorMetricKey, number>>;
  max: Partial<Record<MonitorMetricKey, number>>;
}

export interface HistoryGap {
  from: number;
  to: number;
  // MongoDB가 그사이 재시작했다 — 합계를 모른다
  restarted: boolean;
  ops?: Record<MonitorOp, number>;
  docs?: { inserted: number; updated: number; deleted: number; returned: number };
}

// 빈 구간을 불러온 결과(fills.jsonl 한 줄)
export interface HistoryFill {
  from: number;
  to: number;
  // 불러온 쓰기 이벤트 수
  events: number;
  // 앞부분이 oplog에서 이미 지워져 이 시각부터만 불러왔다
  partialFrom?: number;
  // 전부 지워져 하나도 못 불러왔다
  lost?: boolean;
}

// ── 빈 구간 불러오기(9-4) ──
// 탭이 없어 실시간을 안 받던 동안의 쓰기를 changeStream으로 다시 읽어 통계(컬렉션별 쓰기 수)만 채운다.
//   GET /api/monitor/backfill → BackfillReport
//   POST /api/monitor/backfill/start {id?} — 불러오기/계속(id가 없으면 전부)
//   POST /api/monitor/backfill/stop {id?} — 멈춤(자동으로 다시 시작하지 않는다)
//   socket 'monitor:backfill' (Monitor를 연 탭) → BackfillReport, 바뀔 때마다(불러오는 중엔 1초에 한 번)
export type BackfillStatus = 'pending' | 'loading' | 'paused' | 'error';

export interface BackfillEstimate {
  // oplog에 시작 지점이 남아 있나. 모르면 null(local 읽기 권한 없음 등)
  resumable: boolean | null;
  // 남은 쓰기 이벤트 수. 모르면 null
  events: number | null;
  // 구간 전체 쓰기 이벤트 수(진행률 = loaded / total). 모르면 null
  total: number | null;
  // 어떻게 셌나 — serverStatus 누적값 차이 / oplog 세기(5초 제한)
  source: 'counters' | 'oplog' | null;
  // 남은 크기(바이트) = oplog 평균 항목 크기 × 이벤트 수
  bytes: number | null;
  // 이때까지 불러오지 않으면 시작 지점이 oplog에서 지워지기 시작한다(ms). oplog이 아직 크기 한도까지 안 찼거나 모르면 null
  deadline: number | null;
}

export interface BackfillGap {
  id: string;
  from: number;
  // 실시간을 다시 받기 시작한 때
  to: number;
  status: BackfillStatus;
  // 불러온 데까지(ms)와 이벤트 수
  loadedTo: number | null;
  loaded: number;
  partialFrom?: number;
  error?: string;
  // 아직 안 쟀으면 null
  estimate: BackfillEstimate | null;
}

export interface BackfillReport {
  gaps: BackfillGap[];
  // 설정 › Monitor의 자동 한도(0 = 끔)
  autoLimit: number;
}

//   GET /api/monitor/history?range=24h|7d|30d|90d|all[&writes=1&database=&collection=] → HistoryReport
export interface HistoryReport {
  range: MonitorRange;
  // 한 칸의 길이(24h = 5분, 7d = 1시간, 30d = 2시간, 90d = 6시간, all = 1일)
  bucketMs: number;
  from: number;
  to: number;
  // 기록이 있는 칸만(오래된 것 → 최신). 비어 있는 칸은 없다 — 선이 끊긴다
  points: HistoryPoint[];
  gaps: HistoryGap[];
  // 빈 구간 중 쓰기를 다시 불러온 부분(9-4) — 그 구간의 컬렉션별 쓰기는 차트에 들어 있다
  fills?: HistoryFill[];
  // writes=1일 때 — 기간 동안 컬렉션별 쓰기(많은 순, 상위 50). trend는 points와 같은 칸
  collections?: { database: string; collection: string; total: number; ops: ActivityOps; trend: number[] }[];
  // 기록을 읽을 수 있는가(서버 신분을 아직 모르면 false — 막 연결함)
  ready: boolean;
}

// 설정 › Monitor — 이 연결의 기록 파일(9-3). GET /api/monitor/history-info, DELETE /api/monitor/history
export interface HistoryInfo {
  // 디스크에 있는 이 연결의 기록 크기(바이트) — 옛 서버(주소를 바꾸기 전)의 기록 포함
  bytes: number;
  // 기록이 있는 서버 수(주소를 바꿨다가 되돌리면 옛 기록에 다시 이어 붙는다)
  servers: number;
  // 가장 오래된 기록 시각
  oldest: number | null;
  // 지금 서버의 신분(replicaSetId 등으로 만든 폴더 이름). 아직 모르면 null
  current: string | null;
}

export interface LastWrites {
  // 피드가 없으면(이 연결을 쓰는 탭이 없음) null
  since: number | null;
  // "db.collection" → 마지막 쓰기
  writes: Record<string, LastWrite>;
}

// ── 지금 실행 중인 작업(9-5a) — Monitor › Operations ──
//   GET /api/monitor/operations?database=&collection= → OperationsReport ($currentOp, 탭이 보일 때 2초마다)
//   POST /api/monitor/operations/kill {opid} → 204 (killOp — mongolive 자신·내부 작업은 거절)
// 기록하지 않는다 — 그 순간의 스냅샷
//   user = 다른 클라이언트의 작업, mongolive = 이 앱의 드라이버(appName), system = 클라이언트 없는 내부 스레드·복제
export type RunningOpKind = 'user' | 'mongolive' | 'system';

export interface RunningOp {
  // killOp에 넘길 값(샤드면 "shard:123")
  opid: string;
  // query / insert / update / remove / getmore / command / none
  op: string;
  ns: string | null;
  // 경과(ms)
  ms: number;
  // 명령 한 줄(mongosh 표기, 길면 자름). getMore는 처음 명령(originatingCommand) 기준
  summary: string;
  // 전체 명령 — lsid·$clusterTime 등은 뺀다. MongoDB가 1KB 넘는 명령은 {$truncated: "..."}로 줄여 준다
  command: EjsonObject | null;
  origin: EjsonObject | null;
  planSummary: string | null;
  waitingForLock: boolean;
  yields: number | null;
  client: string | null;
  appName: string | null;
  user: string | null;
  startedAt: number | null;
  kind: RunningOpKind;
}

export interface OperationsReport {
  at: number;
  ops: RunningOp[];
  // 다른 사용자의 작업을 볼 권한(inprog)이 없어 이 사용자의 것만 보인다
  limited: boolean;
  // $currentOp 자체가 안 됨(권한·Atlas 공유 티어 등) — ops는 비어 있다
  error: string | null;
}

// ── Monitor › Operations › 느린 쿼리 (9-5b) ──────────────────────────────────
//   GET /api/monitor/slow?range=&database=&collection=&min= → SlowQueriesReport
// MongoDB가 스스로 로그에 남기는 "Slow query"(slowms보다 오래 걸린 작업)를 샘플러가 10초마다 getLog로 읽는다.
// slowms는 바꾸지 않는다(읽기만). 같은 모양의 쿼리(queryHash, 없으면 명령의 모양)끼리 묶는다.

// 화면 필터(이보다 빠른 건 숨김) — 기록도 이 경계로 나눠 두어 필터가 정확하다
export const SLOW_THRESHOLDS = [100, 500, 1000, 5000] as const;
export type SlowThreshold = (typeof SLOW_THRESHOLDS)[number];

// 한 번의 실행 — 기록은 분마다 모양별로 가장 느린 것 하나만 남긴다
export interface SlowRun {
  // 끝난 시각(로그 시각)
  at: number;
  ms: number;
  app: string | null;
  client: string | null;
  plan: string | null;
  docsExamined: number | null;
  keysExamined: number | null;
  // 돌려준 문서 수(수정·삭제는 맞은 문서 수)
  returned: number | null;
  summary: string;
  // 너무 길면 { $truncated: 요약 }. 응답 크기를 줄이려고 펼친 그룹(expand)에만 채워 보낸다 — 나머지는 null
  command: EjsonObject | null;
}

export interface SlowGroup {
  key: string;
  kind: RunningOpKind;
  ns: string;
  op: string;
  queryHash: string | null;
  // 가장 느린 실행의 요약
  summary: string;
  count: number;
  totalMs: number;
  maxMs: number;
  docsExamined: number;
  keysExamined: number;
  returned: number;
  plan: string | null;
  last: number;
  // 최근 것부터(분마다 가장 느린 것), 최대 20개
  runs: SlowRun[];
}

// 서버 로그가 읽는 속도보다 빨리 넘어가서 못 본 줄이 있던 구간 — 그사이 느린 쿼리를 놓쳤을 수 있다
export interface SlowMissed {
  from: number;
  to: number;
  lines: number;
}

//   ok = 읽는 중, closed = 이 연결을 쓰는 탭이 없어 안 읽음, denied = getLog 권한 없음,
//   unsupported = 4.4 전(로그가 JSON이 아님), error = 그 밖의 실패, off = 설정에서 수집을 끔(9-10)
export type SlowLogStatus = 'ok' | 'closed' | 'denied' | 'unsupported' | 'error' | 'off';

export interface SlowQueriesReport {
  at: number;
  range: MonitorRange;
  status: SlowLogStatus;
  error: string | null;
  // 서버의 기준(profile:-1로 읽음). 못 읽으면 null(기본 100ms)
  slowms: number | null;
  min: SlowThreshold;
  groups: SlowGroup[];
  // min보다 빨라서 뺀 실행 수
  hidden: number;
  missed: SlowMissed[];
  // 기록 파일에 남기는가(설정 › Monitor 기록이 켜져 있음). 꺼져 있으면 최근 1시간만 메모리에
  stored: boolean;
}

// 탭이 서버에 알리는 상태(소켓 'presence', 9-10) — 서버 로그(getLog)를 얼마나 자주 읽을지 정한다.
//   그 연결을 쓰는 탭 중 Slow 카드가 보이는 탭이 있으면 10초, 보이는 탭이 있으면 30초, 모두 숨겨져 있으면 60초
export interface ClientPresence {
  // 브라우저 탭이 보이는가(document.visibilityState)
  visible: boolean;
  // Monitor › Operations의 Slow queries 카드가 떠 있는가
  slowCard: boolean;
}

// ── Monitor › Collections의 크기 (9-6a, GET /api/monitor/sizes) ─────────────────
// 서버가 피드를 여는 때와 그 뒤 1시간마다 컬렉션마다 $collStats(storageStats)를 읽는다. 기록이 켜져 있으면 파일에도.
// 바이트 단위. size = 압축 전 데이터, storage = 디스크(압축 후·빈 칸 포함), index = 인덱스 전부
export interface SizeStats {
  count: number;
  size: number;
  storage: number;
  index: number;
}

export interface CollectionSizeRow extends SizeStats {
  database: string;
  collection: string;
  // 기간 안 첫 측정 때 값(Δ의 기준). 그때 없던 컬렉션이면 null, 실시간 기간(5m·1h)도 null
  base: SizeStats | null;
}

export interface SizesReport {
  // closed = 이 연결을 쓰는 탭이 없어 안 잼, error = 마지막 측정이 실패(권한 등)
  status: 'ok' | 'closed' | 'error';
  error: string | null;
  measuring: boolean;
  // rows를 잰 때. 아직 한 번도 못 쟀으면 null
  at: number | null;
  stored: boolean;
  // 범위 안 컬렉션(서버 전체 / DB / 컬렉션 하나)
  rows: CollectionSizeRow[];
  total: SizeStats;
  // Δ의 기준 시각과 그때 합계(기간 안 첫 측정). 기록이 없거나 실시간 기간이면 null
  baseAt: number | null;
  baseTotal: SizeStats | null;
  // 범위 합계의 추이(측정마다 한 점, 많으면 솎음)
  trend: ({ t: number } & SizeStats)[];
}

// ── Monitor › Collections › Indexes (GET /api/monitor/indexes, 9-6b) ─────────
// 컬렉션 하나의 인덱스 — 정의(listIndexes) + 쓰인 횟수($indexStats) + 디스크 크기($collStats indexSizes).
// 화면이 열 때·새로고침 때만 묻는다(기록하지 않는다)
export interface IndexUsageRow {
  name: string;
  // 키 패턴 { a: 1, b: -1 } · { loc: '2dsphere' } · 텍스트 인덱스는 { title: 'text' }
  key: Record<string, number | string>;
  // since부터 쓰인 횟수(이 멤버에서만, 재시작하면 0부터). 권한이 없으면 null
  ops: number | null;
  since: number | null;
  size: number | null;
  unique: boolean;
  sparse: boolean;
  // 부분 인덱스의 조건(보여 주기용 한 줄). 아니면 null
  partial: string | null;
  hidden: boolean;
  // TTL 초. 아니면 null
  ttl: number | null;
  // 아직 만드는 중
  building: boolean;
}

export interface IndexesReport {
  at: number;
  // 목록 자체를 못 읽음(컬렉션 없음·뷰·권한)
  error: string | null;
  // 쓰인 횟수만 못 읽음(indexStats 권한 등) — rows는 있고 ops·since가 null
  usageError: string | null;
  rows: IndexUsageRow[];
}

// 컬렉션별 서버 시간 (9-6c) — admin `top`의 누적값을 10초마다 읽어 차이를 1시간 메모리에 둔다(파일 없음)
// queries = find, getmore, insert·update·remove, commands = aggregate·count·distinct·findAndModify·인덱스 만들기 …
export const TOP_OPS = ['queries', 'getmore', 'insert', 'update', 'remove', 'commands'] as const;
export type TopOp = (typeof TOP_OPS)[number];
// time = 서버가 쓴 시간(µs), count = 작업 수(명령 하나 = 1, 문서가 몇 개든)
export interface TopUsage {
  time: number;
  count: number;
}
export interface CollectionTopRow {
  database: string;
  collection: string;
  total: TopUsage;
  // readLock(find·getMore·aggregate·count …) / writeLock(insert·update·delete·findAndModify …) — 둘을 더하면 total
  read: TopUsage;
  write: TopUsage;
  ops: Record<TopOp, TopUsage>;
}
export interface TopReport {
  // closed = 피드 없음, unsupported = top이 없음(mongos·일부 Atlas 등급), denied = top 권한 없음(clusterMonitor) — 둘 다 카드를 숨긴다
  status: 'ok' | 'closed' | 'unsupported' | 'denied' | 'error';
  error: string | null;
  // 숫자가 덮는 구간의 시작(첫 읽기 또는 기간 시작 중 늦은 쪽). null = 아직 한 번도 못 읽음
  since: number | null;
  // 마지막으로 읽은 때
  at: number | null;
  // 시간이 많은 순(최대 100개)
  rows: CollectionTopRow[];
  // 100개 밖이라 뺀 컬렉션 수
  more: number;
}

// 레플리카 셋 멤버 (9-7a) — 샘플러가 10초마다 replSetGetStatus를 읽는다(lag·상태 변화는 1시간 메모리, 파일 없음)
// replSetGetConfig에서 온 설정 — 권한이 없으면 멤버의 config가 null
export interface ReplicaMemberConfig {
  votes: number;
  priority: number;
  hidden: boolean;
  arbiterOnly: boolean;
  // 일부러 늦게 따라오는 멤버(secondaryDelaySecs) — 0이면 보통 멤버
  delaySec: number;
  buildIndexes: boolean;
  tags: Record<string, string>;
}
export interface ReplicaMember {
  id: number;
  name: string;
  // stateStr 그대로 — PRIMARY, SECONDARY, ARBITER, RECOVERING, STARTUP2, ROLLBACK, (not reachable/healthy) …
  state: string;
  healthy: boolean;
  // mongolive가 연결한 멤버(이 답을 준 노드)
  self: boolean;
  uptimeSec: number | null;
  // 이 멤버가 마지막으로 적용한 쓰기가 primary에서 쓰인 시각(ms). arbiter·닿지 않는 멤버는 null
  appliedAt: number | null;
  // primary(없으면 가장 앞선 멤버)보다 뒤처진 정도(ms). primary·arbiter·닿지 않는 멤버는 null
  lagMs: number | null;
  pingMs: number | null;
  // 연결한 멤버가 그 멤버에게서 마지막으로 소식을 받은 때 — 자기 자신은 null
  lastSeenAt: number | null;
  syncSource: string | null;
  // 하트비트 에러나 상태 설명(비면 null)
  message: string | null;
  // primary가 된 때
  electedAt: number | null;
  config: ReplicaMemberConfig | null;
}
// 멤버 상태가 바뀐 때 — from null = 새로 들어옴, to null = 빠짐
export interface ReplicaChange {
  at: number;
  member: string;
  from: string | null;
  to: string | null;
}
export interface ReplicaReport {
  // closed = 피드 없음, standalone = 레플리카 셋이 아님, unsupported = replSetGetStatus가 없음(mongos·일부 Atlas 등급),
  // denied = 권한 없음(clusterMonitor)
  status: 'ok' | 'closed' | 'standalone' | 'unsupported' | 'denied' | 'error';
  error: string | null;
  // 마지막으로 읽은 때
  at: number | null;
  set: string | null;
  term: number | null;
  // 'majority' 쓰기가 확인되려면 필요한 멤버 수 / 투표하는 멤버 수
  writeMajority: number | null;
  votingMembers: number | null;
  members: ReplicaMember[];
  // replSetGetConfig 권한이 없어 votes·priority 등을 모름
  configDenied: boolean;
  // 메모리에 있는 첫 읽기(기간 시작과 늦은 쪽) — null = 아직 못 읽음
  since: number | null;
  // 멤버별 lag(ms) — 10초 칸, 그때 primary였던 멤버는 null
  lag: { times: number[]; series: { member: string; values: (number | null)[] }[] };
  // 오래된 것부터
  changes: ReplicaChange[];
}

// ── Monitor › Server의 Oplog·Startup warnings (9-7b) ─────────────────────────
// 연결한 멤버의 oplog(local.oplog.rs) — 화면이 열 때·60초마다 묻는다(기록하지 않는다)
export interface OplogReport {
  // none = oplog가 없음(standalone·mongos), denied = local DB를 읽을 권한이 없음
  status: 'ok' | 'none' | 'denied' | 'error';
  error: string | null;
  at: number;
  // 가장 오래된·최근 항목의 시각 — 둘의 차이가 oplog 창(이만큼 뒤까지 이어 받을 수 있다)
  first: number | null;
  last: number | null;
  // 쓰는 크기(압축 전) / 최대 크기
  usedBytes: number | null;
  maxBytes: number | null;
  // 최대 크기에 거의 닿아(90%) 가장 오래된 항목부터 지워지는 중
  full: boolean | null;
  // 아직 안 찼으면: 지금까지의 평균 속도로 찰 때까지 남은 시간. 찼거나 모르면 null
  fillsInMs: number | null;
}
// getLog 'startupWarnings'의 한 줄 — 4.4+는 JSON(구조화 로그), 그 전엔 글자 그대로(message만)
export interface StartupWarning {
  at: number | null;
  // F·E·W·I·D1~5
  severity: string | null;
  component: string | null;
  id: number | null;
  message: string;
  // 덧붙은 값(현재 값·권장 값 등) — 객체는 JSON 글자로
  attr: Record<string, string>;
}
export interface StartupWarningsReport {
  // unsupported = getLog가 막힘(일부 Atlas 등급)
  status: 'ok' | 'denied' | 'unsupported' | 'error';
  error: string | null;
  at: number;
  warnings: StartupWarning[];
}

// 알림 (9-8a) — 피드가 받는 changeStream 이벤트만 센다(MongoDB에 묻지 않는다)
//   mass-delete    한 컬렉션에서 60초 안에 삭제가 한도 이상
//   burst          한 컬렉션의 60초 쓰기가 한도 이상이면서 평소(최근 1시간 분당 평균)의 10배 이상 — 실시간만
//   drop           컬렉션 삭제 — 같은 DB에서 이어지면 하나로 묶는다
//   drop-database  DB 삭제(그 안 컬렉션들의 drop을 흡수)
//   rename         컬렉션 이름 바꾸기
// 이어지면(5분 안에 다시 넘으면) 한 건으로 늘린다. 끝난 건은 alerts-YYYY-MM-DD.jsonl(기록이 꺼져 있으면 메모리 1시간)
//   GET /api/monitor/alerts?range=&database=&collection= → AlertsReport,  소켓 'monitor:alert' → MonitorAlert(실시간만)
export type AlertKind = 'mass-delete' | 'burst' | 'drop' | 'drop-database' | 'rename';
export interface MonitorAlert {
  id: string;
  kind: AlertKind;
  database: string;
  // 그 컬렉션 — drop·drop-database는 지워진 컬렉션들(앞 20개)
  collections: string[];
  // rename의 새 이름
  to?: { database: string; collection: string };
  // 처음·마지막 이벤트의 시각(ms, MongoDB에 기록된 시각)
  start: number;
  end: number;
  // 삭제 수 / 쓰기 수 / 지운 컬렉션 수 / 1
  count: number;
  // 60초 창에서 가장 많았던 수(mass-delete·burst), 나머지는 count
  peak: number;
  // burst: 넘을 때의 평소 분당 쓰기
  usual: number | null;
  // 그때의 한도(mass-delete·burst)
  limit: number | null;
  // 아직 이어지는 중(5분 안에 다시 넘으면 같은 건)
  ongoing: boolean;
  // 빈 구간 불러오기(9-4)로 다시 읽다가 찾음 — 탭이 없던 동안 일어난 일
  filled: boolean;
}
export interface AlertsReport {
  // closed = 피드 없음(이 연결을 쓰는 탭이 없음)
  status: 'ok' | 'closed';
  at: number;
  // 기록 파일에서도 읽었나(설정 › Monitor 기록이 꺼져 있으면 최근 1시간 메모리만)
  stored: boolean;
  // 이번에 지켜보기 시작한 때 — 이 앞은 기록 파일에 있는 것만
  since: number | null;
  // 지금 규칙(설정 › Monitor › Alerts)
  rules: { deletes: number; burst: number; drops: boolean };
  // 최근 것부터(최대 200)
  alerts: MonitorAlert[];
  more: number;
}

// ── Monitor › Collections › Transactions (9-8b) ─────────────────────────────
// 피드가 받은 변경 중 트랜잭션 안의 쓰기(lsid + txnNumber가 붙은 것)를 트랜잭션별로 센 것. DB에 묻지 않는다 — 최근 1시간 메모리만.
// 범위(DB·컬렉션)는 '그 범위를 건드린 트랜잭션' — 개수·쓰기 수는 트랜잭션 전체(다른 컬렉션 쓰기 포함)

export interface TransactionOps {
  insert: number;
  update: number; // replace 포함
  delete: number;
}

// 같이 쓰인 컬렉션 조합 — namespaces는 "db.coll" 정렬, 10개가 넘으면 more
export interface TransactionCombo {
  namespaces: string[];
  more: number;
  count: number;
  writes: number;
}

// 큰 트랜잭션 하나 — at = 커밋 시각(clusterTime)
export interface TransactionSample {
  at: number;
  writes: number;
  ops: TransactionOps;
  namespaces: { ns: string; writes: number }[];
  more: number;
}

export interface TransactionsReport {
  // closed = 피드 없음(이 연결을 쓰는 탭이 없음)
  status: 'ok' | 'closed';
  at: number;
  // 세기 시작한 때(빈 구간을 불러오면 앞당겨진다)
  since: number | null;
  count: number;
  writes: number;
  // 트랜잭션 수 ÷ 센 분(범위와 since 중 짧은 쪽, 최소 1분)
  perMinute: number;
  maxWrites: number;
  // 자주 같이 쓰인 조합(개수순 5개) / 큰 것(쓰기 수순, 같으면 최근 것 5개)
  combos: TransactionCombo[];
  largest: TransactionSample[];
  // 한 분에 조합이 너무 많아 일부를 '기타'로 셌다 — 범위로 좁힌 숫자가 모자랄 수 있다
  partial: boolean;
}

// ── 쿼리 바의 Explain (POST /api/databases/:db/collections/:col/explain, 9-9) ──
// find(쿼리).explain('executionStats')를 줄인 것. 숫자는 실제로 한 번 돌려 본 값이다.

// 계획의 한 단계 — inputs가 먼저 돈다(갈래가 여럿이면 OR·AND_SORTED 등)
export interface ExplainPlanNode {
  stage: string;
  // IXSCAN 등 인덱스를 쓰는 단계
  index?: string;
  keyPattern?: Record<string, number | string>;
  // 샤드 클러스터 — 그 샤드의 계획
  shard?: string;
  inputs: ExplainPlanNode[];
}

export interface ExplainSummary {
  plan: ExplainPlanNode;
  // 돌려준 문서 / 인덱스에서 읽은 키 / 열어 본 문서 / 걸린 시간 — 서버가 안 주면 null
  returned: number | null;
  keysExamined: number | null;
  docsExamined: number | null;
  timeMs: number | null;
  // 견줘 보고 버린 다른 계획 수
  rejectedPlans: number;
  // 계획에 쓰인 인덱스 이름(중복 없이) / 어딘가에서 컬렉션 전체를 읽었다
  indexes: string[];
  collectionScan: boolean;
  // 복사용 날것(Relaxed EJSON, 들여쓰기) — 너무 크면 null
  raw: string | null;
}

// ── 설정 창의 진단 (GET /api/diagnostics) ─────────────────────────────────────
// 실시간이 안 될 때 원인(standalone·권한)을 바로 보여 주기 위한 것. 보안 설정은 보여 주기만 한다(.env에서만 바꾼다).

// changeStream은 replica set이나 sharded cluster에서만 된다
export type MongoTopology = 'replicaSet' | 'sharded' | 'standalone' | 'unknown';

export interface Diagnostics {
  server: { version: string; node: string; uptimeSec: number };
  mongo: {
    ok: boolean;
    version: string | null;
    topology: MongoTopology;
    replicaSet: string | null;
    error?: string;
  };
  // 서버가 연 changeStream의 지금 상태
  realtime: Omit<LiveStatus, 'resync'>;
  // serverStatus(Monitor 화면) 권한 — clusterMonitor 역할이 있어야 한다
  serverStatus: 'ok' | 'denied' | 'error';
  // .env 값(읽기 전용). mongoUri는 비밀번호와 옵션을 가린 것
  security: {
    authMode: string;
    host: string;
    port: number;
    https: boolean;
    trustProxy: boolean;
    allowInsecureHttp: boolean;
    mongoUri: string;
    authFile: string;
    metaFile: string;
  };
}

// ── 변경 요청 ────────────────────────────────────────────────────────────────

export interface MutateFieldSpec {
  path: string[];
  key: string;
  action: 'add' | 'edit' | 'delete';
  value?: EjsonValue;
  nextKey?: string;
  containerType?: 'object' | 'array';
  // 충돌 확인: 사용자가 편집을 시작할 때 본 '그 자리'(path + key)의 값.
  // 서버는 지금 값이 이것과 같을 때만 쓰고, 다르면 409 + ConflictInfo를 돌려준다. 없으면 확인 없이 쓴다(= 그래도 덮어쓰기).
  //   배열 항목 추가 + { exists: false } = '맨 끝에 붙이기' — 그 사이 누가 먼저 붙였어도 충돌이 아니다
  expected?: ExpectedValue;
}

// 그 자리에 무엇이 있었나(있었다면 무슨 값이었나)
export type ExpectedValue = { exists: false } | { exists: true; value: EjsonValue };

// 409 응답 본문의 conflict — 어디가 지금 무슨 값인지
export interface ConflictInfo {
  // 문서 안 경로("tags.5")
  path: string;
  current: ExpectedValue;
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
  // expected(문서 전체): 지금 그 _id 문서가 이것일 때만(없어야 하면 exists: false). 되돌리기가 쓴다
  | { type: 'upsertDocument'; database: string; collection: string; document: Record<string, unknown>; expected?: ExpectedValue }
  | { type: 'duplicateDocument'; database: string; collection: string; documentId: string }
  | { type: 'deleteDocument'; database: string; collection: string; documentId: string; expected?: ExpectedValue }
  | { type: 'mutateField'; database: string; collection: string; documentId: string; field: MutateFieldSpec };

export interface MutationResult {
  status: 'ok';
  changedPaths: string[];
  tracePath: string[];
  collectionKey?: string;
  // 문서 쓰기의 시각 도장 — 곧 올 changeStream 알림(LiveChange.opTime)과 맞춰 '내 변경'을 알아본다.
  // 컬렉션/DB 연산은 알림이 여러 개라 없다(목록만 다시 받으므로 메아리가 와도 해가 없다)
  opTime?: string;
  // 되돌리기: 이 쓰기를 되돌리는 연산. expected가 '쓴 직후 값'이라 그 사이 누가 또 바꿨으면 409로 거절된다.
  // 문서/필드 쓰기만 있다(컬렉션/DB 연산은 되돌리지 않는다)
  undo?: MutationRequest;
}

// 컬렉션 식별 키 — 구독 키, getDocuments 인자, changedPaths 접두에 공통으로 쓴다
export const collectionKey = (databaseName: string, collectionName: string): string => `${databaseName}.${collectionName}`;

// ── 연결 (GET/POST /api/connections, PUT/DELETE /api/connections/:id, POST /api/connections/test) ──
// 접속 주소는 서버 컴퓨터의 파일(~/.mongolive/connections.json)에 두고, 브라우저에는 비밀 값을 가린 주소만 보낸다.
// .env의 MONGODB_URI는 id 'env'인 읽기 전용 연결로 보인다(이름·색·즐겨찾기만 바꿀 수 있음).

export const ENV_CONNECTION_ID = 'env';

// 가린 비밀 값 자리. 편집 화면에서 이 표시를 그대로 두고 저장하면 서버가 원래 값으로 채운다
export const URI_SECRET_MASK = '••••••';

// 연결 카드 색 — 운영/개발 DB를 헷갈리지 않게. tailwind 팔레트 이름과 같다
export const CONNECTION_COLORS = ['red', 'orange', 'amber', 'emerald', 'teal', 'sky', 'violet', 'rose'] as const;
export type ConnectionColor = (typeof CONNECTION_COLORS)[number];

export interface ConnectionInfo {
  id: string;
  // env = .env의 MONGODB_URI(주소 읽기 전용), saved = 화면에서 추가, demo = 브라우저 안 데모 데이터(Mock)
  source: 'env' | 'saved' | 'demo';
  // 사용자가 붙인 이름. 없으면 화면이 호스트로 이름을 만든다(connectionLabel)
  name: string | null;
  color: ConnectionColor | null;
  favorite: boolean;
  // 비밀번호와 비밀 옵션을 URI_SECRET_MASK로 가린 주소
  uri: string;
  srv: boolean;
  hosts: string[];
  username: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

// 만들기(POST)는 uri가 필요하고, 고치기(PUT)는 보낸 항목만 바꾼다. 'env' 연결은 uri를 바꿀 수 없다
export interface ConnectionInput {
  name?: string | null;
  color?: ConnectionColor | null;
  favorite?: boolean;
  uri?: string;
}

// 연결 테스트 — 저장된 연결(id)이면 가린 값을 원래 값으로 채워 시험한다
export interface ConnectionTestRequest {
  id?: string;
  uri?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  topology: MongoTopology;
  version: string | null;
  replicaSet: string | null;
  latencyMs: number | null;
  error?: string;
}

export const connectionLabel = (connection: Pick<ConnectionInfo, 'name' | 'hosts'>): string =>
  connection.name || connection.hosts[0] || 'MongoDB';
