// serverStatus 응답 → Monitor 화면에 쓰는 숫자만 / 두 번 받은 것의 차이 → 초당 값 (9-1)
//
// serverStatus는 MongoDB가 '켜진 뒤 지금까지'의 누적값을 준다(작업 수, 지연 합계 등).
// 초당 값 = (이번 값 − 지난 값) ÷ 그 사이 시간. 시간은 MongoDB의 uptimeMillis 차이로 잰다(서버 시계 기준이라 정확하다).
// MongoDB가 재시작하면 누적값이 0부터 다시 시작한다 — uptime이 줄었거나 값이 줄었으면 그 칸은 차이를 내지 않는다.
import type { MonitorGauges, MonitorOp, MonitorRates } from '@mongolive/shared';

// 받을 때 빼는 섹션 — 전부 받으면 7.0 기준 약 116KB, 빼면 약 4KB.
// 모르는 이름이 섞여도 MongoDB는 무시한다(버전마다 섹션이 다르다). metrics는 하위 항목까지 뺀다(7.0에서 확인)
const DROP_SECTIONS = [
  'wiredTiger', 'tcmalloc', 'indexStats', 'readPreferenceCounters', 'security', 'electionMetrics', 'locks',
  'readConcernCounters', 'repl', 'transactions', 'indexBuilds', 'extra_info', 'storageEngine', 'logicalSessionRecordCache',
  'globalLock', 'catalogStats', 'collectionCatalog', 'flowControl', 'queues', 'queryAnalyzers', 'twoPhaseCommitCoordinator',
  'tenantMigrations', 'shardSplits', 'scramCache', 'internalTransactions', 'batchedDeletes', 'indexBulkBuilder',
  'oplogTruncation', 'transportSecurity', 'trafficRecording', 'profiler', 'defaultRWConcern', 'featureCompatibilityVersion',
  'opcountersRepl', 'opWriteConcernCounters', 'mirroredReads', 'sharding', 'shardingStatistics', 'health',
];
// metrics 중 쓰는 건 document, queryExecutor뿐
const DROP_METRICS = [
  'commands', 'operatorCounters', 'query', 'aggStageCounters', 'repl', 'cursor', 'operation', 'network', 'queryStats', 'ttl',
  'getLastError', 'abortExpiredTransactions', 'mongos', 'changeStreams', 'diskSpaceMonitor', 'dotsAndDollarsFields', 'apiVersions',
  'storage', 'record', 'ttlIndexes', 'numSlowDurationsInvocations', 'numSlowLookupsInvocations',
];

const dropAll = (names: string[]) => Object.fromEntries(names.map((name) => [name, false]));

export const STATUS_COMMAND = { serverStatus: 1, ...dropAll(DROP_SECTIONS), metrics: dropAll(DROP_METRICS) };
// metrics의 하위 항목 빼기를 못 알아듣는 옛 버전용 — metrics를 통째로 받는다(조금 크다)
export const STATUS_COMMAND_FULL_METRICS = { serverStatus: 1, ...dropAll(DROP_SECTIONS) };

const OPS: MonitorOp[] = ['insert', 'query', 'update', 'delete', 'getmore', 'command'];

// 누적값만 — 차이를 내는 재료
export interface StatusCounters {
  uptimeMs: number;
  ops: Record<MonitorOp, number>;
  // opLatencies: 지연 합계(μs) / 작업 수
  latency: Record<'reads' | 'writes' | 'commands', { micros: number; ops: number }>;
  docs: { inserted: number; updated: number; deleted: number; returned: number };
  scannedKeys: number;
  scannedDocs: number;
  // 4.4+에만 있다
  collectionScans: number | null;
  connectionsCreated: number;
  asserts: { regular: number; warning: number; msg: number; user: number };
  bytesIn: number;
  bytesOut: number;
}

export interface StatusReading {
  counters: StatusCounters;
  gauges: MonitorGauges;
  version: string | null;
  uptimeSec: number | null;
  host: string | null;
}

type Doc = Record<string, unknown>;

// 드라이버는 큰 정수를 Long 객체로 줄 수 있다
const num = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') return (value as { toNumber: () => number }).toNumber();
  return null;
};
const at = (doc: unknown, ...path: string[]): unknown => {
  let current = doc;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Doc)[key];
  }
  return current;
};
const n0 = (doc: unknown, ...path: string[]) => num(at(doc, ...path)) ?? 0;

export const readStatus = (doc: Doc): StatusReading => {
  const ops = Object.fromEntries(OPS.map((op) => [op, n0(doc, 'opcounters', op)])) as Record<MonitorOp, number>;
  const latencyOf = (kind: string) => ({ micros: n0(doc, 'opLatencies', kind, 'latency'), ops: n0(doc, 'opLatencies', kind, 'ops') });
  const current = num(at(doc, 'connections', 'current'));
  const available = num(at(doc, 'connections', 'available'));
  const uptimeMs = num(doc.uptimeMillis) ?? (num(doc.uptime) ?? 0) * 1000;
  return {
    counters: {
      uptimeMs,
      ops,
      latency: { reads: latencyOf('reads'), writes: latencyOf('writes'), commands: latencyOf('commands') },
      docs: {
        inserted: n0(doc, 'metrics', 'document', 'inserted'),
        updated: n0(doc, 'metrics', 'document', 'updated'),
        deleted: n0(doc, 'metrics', 'document', 'deleted'),
        returned: n0(doc, 'metrics', 'document', 'returned'),
      },
      scannedKeys: n0(doc, 'metrics', 'queryExecutor', 'scanned'),
      scannedDocs: n0(doc, 'metrics', 'queryExecutor', 'scannedObjects'),
      collectionScans: num(at(doc, 'metrics', 'queryExecutor', 'collectionScans', 'total')),
      connectionsCreated: n0(doc, 'connections', 'totalCreated'),
      asserts: {
        regular: n0(doc, 'asserts', 'regular'),
        warning: n0(doc, 'asserts', 'warning'),
        msg: n0(doc, 'asserts', 'msg'),
        user: n0(doc, 'asserts', 'user'),
      },
      bytesIn: n0(doc, 'network', 'bytesIn'),
      bytesOut: n0(doc, 'network', 'bytesOut'),
    },
    gauges: {
      connections: current !== null && available !== null ? { current, available } : null,
      memResidentMb: num(at(doc, 'mem', 'resident')),
    },
    version: typeof doc.version === 'string' ? doc.version : null,
    uptimeSec: num(doc.uptime),
    host: typeof doc.host === 'string' ? doc.host : null,
  };
};

// 소수 둘째 자리까지 — 화면에 그 이상은 필요 없고 소켓으로 보내는 글자 수만 는다
const round = (value: number) => Math.round(value * 100) / 100;

// 지난 값 → 이번 값의 초당 값. 재시작(시간·값이 줄어듦)이거나 시간이 안 흘렀으면 null
export const ratesBetween = (prev: StatusCounters, cur: StatusCounters): MonitorRates | null => {
  const seconds = (cur.uptimeMs - prev.uptimeMs) / 1000;
  if (!(seconds > 0)) return null;
  const deltas: number[] = [];
  const rate = (before: number, after: number) => {
    const delta = after - before;
    deltas.push(delta);
    return round(delta / seconds);
  };
  const latency = (kind: 'reads' | 'writes' | 'commands') => {
    const ops = cur.latency[kind].ops - prev.latency[kind].ops;
    const micros = cur.latency[kind].micros - prev.latency[kind].micros;
    deltas.push(ops, micros);
    return ops > 0 ? round(micros / ops / 1000) : null;
  };
  const rates: MonitorRates = {
    ops: Object.fromEntries(OPS.map((op) => [op, rate(prev.ops[op], cur.ops[op])])) as Record<MonitorOp, number>,
    docs: {
      inserted: rate(prev.docs.inserted, cur.docs.inserted),
      updated: rate(prev.docs.updated, cur.docs.updated),
      deleted: rate(prev.docs.deleted, cur.docs.deleted),
      returned: rate(prev.docs.returned, cur.docs.returned),
    },
    latencyMs: { reads: latency('reads'), writes: latency('writes'), commands: latency('commands') },
    scannedKeys: rate(prev.scannedKeys, cur.scannedKeys),
    scannedDocs: rate(prev.scannedDocs, cur.scannedDocs),
    collectionScans: prev.collectionScans !== null && cur.collectionScans !== null ? rate(prev.collectionScans, cur.collectionScans) : null,
    newConnections: rate(prev.connectionsCreated, cur.connectionsCreated),
    asserts: {
      regular: rate(prev.asserts.regular, cur.asserts.regular),
      warning: rate(prev.asserts.warning, cur.asserts.warning),
      msg: rate(prev.asserts.msg, cur.asserts.msg),
      user: rate(prev.asserts.user, cur.asserts.user),
    },
    network: { inBps: rate(prev.bytesIn, cur.bytesIn), outBps: rate(prev.bytesOut, cur.bytesOut) },
  };
  // 누적값이 줄었다 = 그 사이 MongoDB가 재시작했다(uptime이 아직 더 크더라도)
  return deltas.some((d) => d < 0) ? null : rates;
};
