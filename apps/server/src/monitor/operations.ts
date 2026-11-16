// Monitor › Operations (9-5a) — $currentOp으로 지금 돌고 있는 작업을 보고, 사용자가 고른 것만 killOp로 멈춘다.
// 기록하지 않는다(그 순간의 스냅샷). 화면이 Operations 탭을 보는 동안 2초마다 묻는다.
// 권한: 다른 사용자의 작업까지 보려면 inprog(clusterMonitor) — 없으면 이 사용자 것만(limited).
//       멈추기는 killop(hostManager) — 자기 작업은 권한 없이도 된다.
import type { Document as BsonDocument, MongoClient } from 'mongodb';
import { formatQueryValue, type EjsonObject, type EjsonValue, type OperationsReport, type RunningOp, type RunningOpKind } from '@mongolive/shared';
import { HttpError } from '../names';
import { READ_OPTIONS, toWire } from '../wire';
import { withTimeout } from './sampler';

// db.ts가 드라이버에 거는 appName — 이 앱 자신의 작업(changeStream getMore, 샘플러 등)을 가려낸다
export const APP_NAME = 'mongolive';
const SUMMARY_MAX = 160;
// 화면에 쓸모없는 세션·라우팅 정보
const DROP_KEYS = new Set(['lsid', '$clusterTime', '$db', '$readPreference', 'signature', '$audit', '$client', 'mayBypassWriteBlocking']);

export interface OperationsScope {
  database: string | null;
  collection: string | null;
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const asObject = (value: unknown): EjsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as EjsonObject) : null;

export const cleanCommand = (command: unknown): BsonDocument | null => {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) return null;
  return Object.fromEntries(Object.entries(command as BsonDocument).filter(([key]) => !DROP_KEYS.has(key)));
};

const fmt = (value: EjsonValue | undefined): string => formatQueryValue(value ?? {});
export const shortSummary = (text: string): string => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text);

// 명령 한 줄 — 무엇을 찾는지(필터)·파이프라인 모양만. 컬렉션 이름은 ns 칸에 따로 있다
export const describeCommand = (command: EjsonObject | null): string => {
  if (!command) return '';
  if (typeof command.$truncated === 'string') return command.$truncated;
  const name = Object.keys(command)[0];
  if (!name) return '';
  switch (name) {
    case 'find':
      return ['find', fmt(command.filter), command.sort !== undefined ? `sort ${fmt(command.sort)}` : '', command.limit !== undefined ? `limit ${fmt(command.limit)}` : '']
        .filter(Boolean)
        .join(' ');
    case 'aggregate': {
      const stages = Array.isArray(command.pipeline) ? command.pipeline : [];
      const parts = stages.map((stage, i) => {
        const key = Object.keys(asObject(stage) ?? {})[0] ?? '?';
        return i === 0 && key === '$match' ? `$match ${fmt(asObject(stage)!.$match)}` : key;
      });
      return `aggregate ${parts.join(' → ') || '[]'}`;
    }
    case 'count':
      return `count ${fmt(command.query)}`;
    case 'distinct':
      return `distinct ${JSON.stringify(command.key)} ${fmt(command.query)}`;
    case 'update':
    case 'delete': {
      const list = command[name === 'update' ? 'updates' : 'deletes'];
      const statements = Array.isArray(list) ? list : [];
      const more = statements.length > 1 ? ` +${statements.length - 1} more` : '';
      return `${name} ${fmt(asObject(statements[0])?.q)}${more}`;
    }
    case 'findAndModify':
    case 'findandmodify':
      return `findAndModify ${fmt(command.query)}`;
    case 'insert': {
      const docs = command.documents;
      return Array.isArray(docs) ? `insert ${docs.length} doc${docs.length === 1 ? '' : 's'}` : 'insert';
    }
    default:
      return name;
  }
};

// 드라이버가 서버 상태를 기다리며 걸어 두는 hello(최대 10초) — 클라이언트마다 늘 하나씩 있다
const isHeartbeatWait = (command: unknown): boolean => {
  const cmd = command as BsonDocument | null | undefined;
  return !!cmd && (cmd.hello !== undefined || cmd.isMaster !== undefined || cmd.ismaster !== undefined) && cmd.maxAwaitTimeMS !== undefined;
};

export const kindOf = (doc: BsonDocument): RunningOpKind => {
  if (doc.appName === APP_NAME) return 'mongolive';
  // 클라이언트가 없으면 서버 내부 스레드(TTL·세션 정리 등). oplog을 끌어가는 건 다른 멤버의 복제
  if (!doc.client || doc.ns === 'local.oplog.rs' || isHeartbeatWait(doc.command)) return 'system';
  return 'user';
};

// 이 화면이 묻는 $currentOp 자신 — 늘 하나 있으니 목록에서 뺀다
const isOwnProbe = (doc: BsonDocument): boolean =>
  doc.appName === APP_NAME && Array.isArray(doc.command?.pipeline) && doc.command.pipeline[0]?.$currentOp !== undefined;

export const toRunningOp = (doc: BsonDocument): RunningOp => {
  const command = asObject(doc.command ? toWire(cleanCommand(doc.command)) : null);
  const origin = asObject(doc.originatingCommand ? toWire(cleanCommand(doc.originatingCommand)) : null);
  const op = typeof doc.op === 'string' ? doc.op : 'none';
  const summary = op === 'getmore' ? (origin ? `getMore · ${describeCommand(origin)}` : 'getMore') : describeCommand(command);
  const micros = num(doc.microsecs_running);
  const secs = num(doc.secs_running);
  const ms = micros !== null ? micros / 1000 : secs !== null ? secs * 1000 : 0;
  // currentOpTime은 시작 시각이 아니라 이 $currentOp를 잰 시각 — 경과만큼 뺀다
  const reportedAt = typeof doc.currentOpTime === 'string' ? Date.parse(doc.currentOpTime) : NaN;
  const user = Array.isArray(doc.effectiveUsers) ? doc.effectiveUsers[0]?.user : undefined;
  return {
    opid: String(doc.opid),
    op,
    ns: typeof doc.ns === 'string' && doc.ns !== '' ? doc.ns : null,
    ms,
    summary: shortSummary(summary),
    command,
    origin,
    planSummary: typeof doc.planSummary === 'string' ? doc.planSummary : null,
    waitingForLock: doc.waitingForLock === true,
    yields: num(doc.numYields),
    client: typeof doc.client === 'string' ? doc.client : null,
    appName: typeof doc.appName === 'string' && doc.appName !== '' ? doc.appName : null,
    user: typeof user === 'string' ? user : null,
    startedAt: Number.isFinite(reportedAt) ? Math.round(reportedAt - ms) : null,
    kind: kindOf(doc),
  };
};

export const inScope = (ns: string | null, scope: OperationsScope): boolean => {
  if (!scope.database) return true;
  if (ns === null) return false;
  return scope.collection ? ns === `${scope.database}.${scope.collection}` : ns.startsWith(`${scope.database}.`);
};

export const isUnauthorized = (e: unknown) => Number((e as { code?: unknown })?.code) === 13;

// 다른 사용자 것까지 묻고, 권한(inprog)이 없으면 이 사용자 것만 다시 묻는다
const currentOps = async (client: MongoClient, match: BsonDocument): Promise<{ docs: BsonDocument[]; limited: boolean }> => {
  const run = (allUsers: boolean) =>
    withTimeout(
      client
        .db('admin')
        .aggregate([{ $currentOp: { allUsers, idleConnections: false, idleSessions: false } }, { $match: match }], READ_OPTIONS)
        .toArray(),
    );
  try {
    return { docs: await run(true), limited: false };
  } catch (e) {
    if (!isUnauthorized(e)) throw e;
    return { docs: await run(false), limited: true };
  }
};

export const listOperations = async (getClient: () => Promise<MongoClient>, scope: OperationsScope): Promise<OperationsReport> => {
  const at = Date.now();
  try {
    const { docs, limited } = await currentOps(await getClient(), { active: true });
    const ops = docs
      .filter((doc) => !isOwnProbe(doc))
      .map(toRunningOp)
      .filter((op) => inScope(op.ns, scope))
      .sort((a, b) => b.ms - a.ms);
    return { at, ops, limited, error: null };
  } catch (e) {
    const message = isUnauthorized(e)
      ? 'No permission to list operations ($currentOp needs the inprog privilege — e.g. the clusterMonitor role).'
      : e instanceof Error ? e.message : String(e);
    return { at, ops: [], limited: false, error: message };
  }
};

// 화면이 본 뒤에 끝났거나, 이 앱·내부 작업이면 거절한다(요청을 직접 만들어 보내도)
export const killOperation = async (client: MongoClient, opid: string): Promise<void> => {
  const value: number | string = /^\d+$/.test(opid) ? Number(opid) : opid;
  const { docs } = await currentOps(client, { opid: value });
  const doc = docs[0];
  if (!doc) throw new HttpError(404, 'This operation already finished.');
  if (kindOf(doc) !== 'user') throw new HttpError(403, 'mongolive’s own and internal MongoDB operations can’t be stopped here.');
  try {
    await withTimeout(client.db('admin').command({ killOp: 1, op: value }));
  } catch (e) {
    if (isUnauthorized(e)) throw new HttpError(403, 'No permission to stop other users’ operations (needs the killop privilege — e.g. the hostManager role).');
    throw e;
  }
};
