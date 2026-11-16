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
  // 너무 길면 { $truncated: 요약 }
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
//   unsupported = 4.4 전(로그가 JSON이 아님), error = 그 밖의 실패
export type SlowLogStatus = 'ok' | 'closed' | 'denied' | 'unsupported' | 'error';

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
