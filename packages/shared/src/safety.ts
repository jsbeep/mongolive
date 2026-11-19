// 안전장치(설정 창 › Safety) — 서버와 브라우저가 같은 규칙을 쓴다.
//   서버(routes/mutate)  : 진짜로 막는 곳. 403으로 거절한다
//   브라우저(useExplorerState): 보내기 전에 미리 알려 주는 곳(토스트) — 서버가 최종 판단
// 실수 방지용이지 보안 장치가 아니다: 세션을 가진 사람은 설정도 바꿀 수 있다.
// 메타데이터 연산(titleKey/PK/FK 선언)은 MongoDB를 건드리지 않으므로 막지 않는다.
import type { MutationRequest } from './contract';

export interface ProtectedTarget {
  database: string;
  // 없으면 DB 전체
  collection?: string;
}

// Monitor 기록을 파일로 남길지(9-3) — 시 단위 기록의 보관 기간. 일 단위 요약은 켜져 있으면 늘 남긴다(하루 1줄)
export type MonitorHistory = 'off' | '30d' | '90d' | '1y';
export const MONITOR_HISTORY_DAYS: Record<Exclude<MonitorHistory, 'off'>, number> = { '30d': 30, '90d': 90, '1y': 365 };
// 1분 기록을 며칠 남길지(C1) — 6h·12h·24h 차트가 1분·2분·5분 칸으로 읽는다. 따라잡기(시 합치기)는 이와 상관없이 2일
export type MinuteHistory = '2d' | '7d' | '14d';
export const MINUTE_HISTORY_DAYS: Record<MinuteHistory, number> = { '2d': 2, '7d': 7, '14d': 14 };
// 연결 하나의 기록 폴더 한도(C1) — 넘으면 정리할 때 오래된 것부터 지운다(slow·sizes·alerts → 분 → 시·일). off = 한도 없음
export type HistoryBudget = '500mb' | '1gb' | '5gb' | 'off';
export const HISTORY_BUDGET_BYTES: Record<Exclude<HistoryBudget, 'off'>, number> = { '500mb': 500 * 1024 ** 2, '1gb': 1024 ** 3, '5gb': 5 * 1024 ** 3 };
// 빈 구간 자동 불러오기 한도(이벤트 수, 9-4) — 추정이 이 이하면 피드가 열릴 때 바로 불러온다. 0 = 끔(늘 버튼으로)
export const BACKFILL_AUTO_LIMITS = [0, 1_000, 10_000, 100_000] as const;
export type BackfillAutoLimit = (typeof BACKFILL_AUTO_LIMITS)[number];
// 알림(9-8a) 한도 — 한 컬렉션의 60초 안 삭제 수 / 쓰기 수. 0 = 끔
export const ALERT_DELETE_LIMITS = [0, 100, 1_000, 10_000] as const;
export type AlertDeleteLimit = (typeof ALERT_DELETE_LIMITS)[number];
export const ALERT_BURST_LIMITS = [0, 1_000, 10_000, 100_000] as const;
export type AlertBurstLimit = (typeof ALERT_BURST_LIMITS)[number];

// 서버 쪽 설정(~/.mongolive/settings.json). 모든 브라우저에 똑같이 적용된다
export interface ServerSettings {
  // 켜면 문서·컬렉션·DB 쓰기를 전부 거절한다(되돌리기 포함)
  readOnly: boolean;
  // 편집을 막을 DB/컬렉션
  protected: ProtectedTarget[];
  // Monitor 기록(설정 › Monitor)
  monitorHistory: MonitorHistory;
  // 빈 구간 자동 불러오기 한도(설정 › Monitor)
  backfillAuto: BackfillAutoLimit;
  // 알림(설정 › Monitor › Alerts) — 대량 삭제 한도, 쓰기 폭주 한도, 컬렉션·DB 삭제와 이름 바꾸기
  alertDeletes: AlertDeleteLimit;
  alertBurst: AlertBurstLimit;
  alertDrops: boolean;
  // 느린 쿼리 수집(설정 › Monitor, 9-10) — 끄면 서버 로그(getLog)를 읽지 않는다.
  // 기본 꺼짐: 읽을 때마다 로그 버퍼 전체(최대 약 1MB)를 받고, getLog 권한이 없는 계정도 많다
  slowLog: boolean;
  // 1분 기록 보관(설정 › Monitor › History)
  minuteHistory: MinuteHistory;
  // 연결 하나의 기록 폴더 한도(설정 › Monitor › History)
  historyBudget: HistoryBudget;
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  readOnly: false,
  protected: [],
  monitorHistory: '90d',
  backfillAuto: 10_000,
  alertDeletes: 1_000,
  alertBurst: 1_000,
  alertDrops: true,
  slowLog: false,
  minuteHistory: '2d',
  historyBudget: '1gb',
};

// 이 쓰기가 건드리는 곳. null = MongoDB를 건드리지 않는 연산(메타데이터)
export const mutationTarget = (op: MutationRequest): { database: string; collections: string[] } | null => {
  switch (op.type) {
    case 'createDatabase':
      return { database: op.database.name, collections: [] };
    case 'deleteDatabase':
      return { database: op.database, collections: [] };
    case 'createCollection':
      return { database: op.database, collections: [op.collection.name] };
    case 'renameCollection':
      return { database: op.database, collections: [op.oldName, op.newName] };
    // 복제는 원본을 읽기만 한다 — 새 컬렉션이 생기는 DB만 본다
    case 'duplicateCollection':
      return { database: op.database, collections: [] };
    case 'deleteCollection':
    case 'upsertDocument':
    case 'duplicateDocument':
    case 'deleteDocument':
    case 'mutateField':
      return { database: op.database, collections: [op.collection] };
    case 'setCollectionTitleKey':
    case 'setCollectionPrimaryKey':
    case 'setCollectionReferenceField':
      return null;
  }
};

export const isProtected = (settings: ServerSettings, database: string, collection?: string): boolean =>
  settings.protected.some((p) => p.database === database && (p.collection === undefined || p.collection === collection));

// 막혀 있으면 이유(사용자에게 보일 문장), 아니면 null
export const writeBlockedReason = (settings: ServerSettings, op: MutationRequest): string | null => {
  const target = mutationTarget(op);
  if (!target) return null;
  if (settings.readOnly) return 'Read-only mode is on — turn it off in Settings › Safety to edit.';
  if (isProtected(settings, target.database)) return `Database "${target.database}" is protected — change it in Settings › Safety.`;
  const blocked = target.collections.find((c) => isProtected(settings, target.database, c));
  if (blocked) return `Collection "${target.database}.${blocked}" is protected — change it in Settings › Safety.`;
  return null;
};

// 바깥에서 온 값(파일·요청 본문)을 ServerSettings로 — 모르는 값은 버린다
export const normalizeServerSettings = (raw: unknown): ServerSettings => {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(obj.protected) ? obj.protected : [];
  const seen = new Set<string>();
  const protectedTargets: ProtectedTarget[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { database, collection } = item as Record<string, unknown>;
    if (typeof database !== 'string' || !database) continue;
    if (collection !== undefined && (typeof collection !== 'string' || !collection)) continue;
    const key = `${database}\u0000${collection ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    protectedTargets.push(collection === undefined ? { database } : { database, collection });
  }
  const history = obj.monitorHistory;
  const monitorHistory: MonitorHistory = history === 'off' || history === '30d' || history === '90d' || history === '1y' ? history : DEFAULT_SERVER_SETTINGS.monitorHistory;
  const auto = BACKFILL_AUTO_LIMITS.find((n) => n === obj.backfillAuto);
  const backfillAuto: BackfillAutoLimit = auto ?? DEFAULT_SERVER_SETTINGS.backfillAuto;
  const alertDeletes = ALERT_DELETE_LIMITS.find((n) => n === obj.alertDeletes) ?? DEFAULT_SERVER_SETTINGS.alertDeletes;
  const alertBurst = ALERT_BURST_LIMITS.find((n) => n === obj.alertBurst) ?? DEFAULT_SERVER_SETTINGS.alertBurst;
  const alertDrops = typeof obj.alertDrops === 'boolean' ? obj.alertDrops : DEFAULT_SERVER_SETTINGS.alertDrops;
  const slowLog = typeof obj.slowLog === 'boolean' ? obj.slowLog : DEFAULT_SERVER_SETTINGS.slowLog;
  const minuteHistory = typeof obj.minuteHistory === 'string' && Object.keys(MINUTE_HISTORY_DAYS).includes(obj.minuteHistory) ? (obj.minuteHistory as MinuteHistory) : DEFAULT_SERVER_SETTINGS.minuteHistory;
  const budget = obj.historyBudget;
  const historyBudget: HistoryBudget = budget === 'off' || (typeof budget === 'string' && Object.keys(HISTORY_BUDGET_BYTES).includes(budget)) ? (budget as HistoryBudget) : DEFAULT_SERVER_SETTINGS.historyBudget;
  return { readOnly: obj.readOnly === true, protected: protectedTargets, monitorHistory, backfillAuto, alertDeletes, alertBurst, alertDrops, slowLog, minuteHistory, historyBudget };
};
