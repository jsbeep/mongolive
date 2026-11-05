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

// ── 문서 목록 페이지 ──────────────────────────────────────────────────────────

// 한 페이지(문서 목록)·한 화면(필드 목록)에 보여 줄 개수. 둘이 같은 단위를 쓴다.
export const PAGE_SIZE = 7;

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
}

export interface DocumentPage {
  items: DocumentSummary[];
  page: number;
  pageSize: number;
  // 필터 적용 후 개수
  total: number;
  // 필터 적용 전 컬렉션 전체 개수
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
// 소켓 이벤트: 클라이언트 → 서버 'view'(LiveView), 서버 → 클라이언트 'change'(LiveChange)·'status'(LiveStatus)

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
  state: 'connecting' | 'running' | 'error';
  error?: string;
  // true면 이벤트를 놓쳤을 수 있다 — 화면을 전부 다시 받아야 한다
  resync?: boolean;
}

// ── 활동 패널(ChangeStreamLogs / PerformanceMetrics) ──────────────────────────
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

export interface LagStats {
  p50: number;
  p95: number;
  max: number;
  samples: number;
}

export interface ServerMetrics {
  at: number;
  realtime: {
    status: LiveStatus;
    // 서버가 시작된 뒤 받은 이벤트 수
    eventsTotal: number;
    // 최근 60초, 1초 단위 이벤트 수(오래된 것 → 최신)
    eventsPerSecond: number[];
    // DB 기록 시각(wallTime) → 서버 수신까지(ms), 최근 이벤트 기준
    lag: LagStats | null;
  };
  // serverStatus — 계정에 권한(clusterMonitor)이 없으면 error만 온다
  mongo: {
    version?: string;
    uptimeSec?: number;
    connections?: { current: number; available: number };
    memResidentMb?: number;
    // 누적값 — 초당 값은 두 번 받아 차이로 계산한다
    opcounters?: Record<string, number>;
    network?: { bytesIn: number; bytesOut: number };
    error?: string;
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
  // 문서 쓰기의 시각 도장 — 곧 올 changeStream 알림(LiveChange.opTime)과 맞춰 '내 변경'을 알아본다.
  // 컬렉션/DB 연산은 알림이 여러 개라 없다(목록만 다시 받으므로 메아리가 와도 해가 없다)
  opTime?: string;
}

// 컬렉션 식별 키 — 구독 키, getDocuments 인자, changedPaths 접두에 공통으로 쓴다
export const collectionKey = (databaseName: string, collectionName: string): string => `${databaseName}.${collectionName}`;
