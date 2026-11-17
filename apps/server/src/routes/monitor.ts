// Monitor 화면의 조회 (9-2~)
//   GET /api/monitor/activity?database=&collection=&range=5m|1h → ActivityReport
//       changeStream으로 본 쓰기의 집계(범위: 서버 전체 / DB / 컬렉션). DB에 묻지 않는다 — 피드가 센 것을 잘라서 줄 뿐
//   GET /api/monitor/last-writes → LastWrites (사이드바 트리의 '마지막 쓰기')
//   GET /api/monitor/history-info → HistoryInfo (설정 › Monitor — 기록 파일 크기·가장 오래된 기록)
//   DELETE /api/monitor/history → 이 연결의 기록 파일 전부 지우기
//   GET /api/monitor/history?range=24h|7d|30d|90d|all[&writes=1&database=&collection=] → HistoryReport (긴 기간, 9-3b)
//   GET /api/monitor/backfill → BackfillReport (빈 구간 불러오기, 9-4)
//   POST /api/monitor/backfill/start {id?} — 불러오기/계속,  POST /api/monitor/backfill/stop {id?} — 멈춤
//   GET /api/monitor/operations?database=&collection= → OperationsReport ($currentOp, 9-5a)
//   POST /api/monitor/operations/kill {opid} → 204 (killOp — 다른 클라이언트의 작업만)
//   GET /api/monitor/slow?range=&database=&collection=&min=100|500|1000|5000 → SlowQueriesReport (서버 로그의 느린 쿼리, 9-5b)
//   GET /api/monitor/sizes?range=&database=&collection= → SizesReport (컬렉션 크기, 9-6a)
//   POST /api/monitor/sizes/measure → { started } (false = 이미 재는 중이거나 30초 안에 잼)
// 피드는 이 연결을 쓰는 탭이 있을 때만 열려 있다. 없으면 빈 값(since 없음)
import { Router } from 'express';
import { SLOW_THRESHOLDS, type ActivityRange, type ActivityReport, type BackfillReport, type LastWrites, type MonitorRange, type SizesReport, type SlowQueriesReport, type SlowThreshold } from '@mongolive/shared';
import { dropConnectionHistory, historyInfo } from '../monitor/history';
import { isFileRange, readHistory } from '../monitor/historyRead';
import { clusterFingerprint } from '../monitor/identity';
import { killOperation, listOperations } from '../monitor/operations';
import { connectionUri } from '../connections';
import { clientFor, connectionIdOf } from '../db';
import { checkCollectionName, checkDatabaseName, HttpError } from '../names';
import { activityOf, backfillOf, recorderOf, sizesOf, slowOf } from '../realtime';
import { getServerSettings } from '../settings';

export const monitorRouter = Router();

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

monitorRouter.get('/monitor/activity', (req, res) => {
  const range = req.query.range === '5m' ? '5m' : req.query.range === '1h' || req.query.range === undefined ? '1h' : null;
  if (!range) throw new HttpError(400, 'range must be 5m or 1h');
  const database = text(req.query.database);
  const collection = text(req.query.collection);
  if (collection && !database) throw new HttpError(400, 'collection needs a database');
  const query = {
    database: database ? checkDatabaseName(database) : null,
    collection: collection ? checkCollectionName(collection) : null,
    range: range as ActivityRange,
  };
  const stats = activityOf(connectionIdOf(res));
  const empty: ActivityReport = { since: Date.now(), range: query.range, timeline: [], collections: [] };
  res.json(stats ? stats.report(query) : empty);
});

monitorRouter.get('/monitor/last-writes', (_req, res) => {
  const stats = activityOf(connectionIdOf(res));
  const result: LastWrites = stats ? { since: stats.since, writes: stats.lastWrites() } : { since: null, writes: {} };
  res.json(result);
});

monitorRouter.get('/monitor/history-info', async (_req, res) => {
  const id = connectionIdOf(res);
  res.json(await historyInfo(id, recorderOf(id)?.currentFingerprint() ?? null));
});

monitorRouter.delete('/monitor/history', async (_req, res) => {
  const id = connectionIdOf(res);
  const recorder = recorderOf(id);
  // 피드가 열려 있으면 기록기가 줄 선 쓰기를 마친 뒤 지운다(지우는 도중 다시 쓰지 않게)
  await (recorder ? recorder.clear() : dropConnectionHistory(id));
  res.status(204).end();
});

monitorRouter.get('/monitor/history', async (req, res) => {
  const range = String(req.query.range ?? '');
  if (!isFileRange(range)) throw new HttpError(400, 'range must be 24h, 7d, 30d, 90d or all — shorter ranges come live over the socket');
  const database = text(req.query.database);
  const collection = text(req.query.collection);
  if (collection && !database) throw new HttpError(400, 'collection needs a database');
  const id = connectionIdOf(res);
  // 서버 신분 — 기록기가 이미 알면 그것, 아니면 직접 묻는다(기록을 꺼 둬도 옛 기록은 볼 수 있게)
  let fingerprint = recorderOf(id)?.currentFingerprint() ?? null;
  if (!fingerprint) {
    try {
      fingerprint = await clusterFingerprint(await clientFor(id), connectionUri(id) ?? '');
    } catch {
      fingerprint = null;
    }
  }
  if (!fingerprint) {
    res.json({ range, bucketMs: 0, from: Date.now(), to: Date.now(), points: [], gaps: [], ready: false });
    return;
  }
  res.json(await readHistory(id, fingerprint, {
    range,
    writes: req.query.writes === '1',
    database: database ? checkDatabaseName(database) : null,
    collection: collection ? checkCollectionName(collection) : null,
  }));
});

monitorRouter.get('/monitor/backfill', (_req, res) => {
  const backfill = backfillOf(connectionIdOf(res));
  const empty: BackfillReport = { gaps: [], autoLimit: getServerSettings().backfillAuto };
  res.json(backfill ? backfill.report() : empty);
});

// 본문의 id — 없으면 전부
const gapId = (body: unknown): string | undefined => {
  const id = (body as { id?: unknown } | undefined)?.id;
  if (id === undefined) return undefined;
  if (typeof id !== 'string' || !/^\d+-\d+$/.test(id)) throw new HttpError(400, 'id must be a gap id from GET /monitor/backfill');
  return id;
};

monitorRouter.post('/monitor/backfill/start', async (req, res) => {
  const backfill = backfillOf(connectionIdOf(res));
  if (!backfill) throw new HttpError(409, 'Nothing is open for this connection — open it in a tab first.');
  await backfill.load(gapId(req.body));
  res.json(backfill.report());
});

monitorRouter.post('/monitor/backfill/stop', async (req, res) => {
  const backfill = backfillOf(connectionIdOf(res));
  if (!backfill) throw new HttpError(409, 'Nothing is open for this connection — open it in a tab first.');
  await backfill.pause(gapId(req.body));
  res.json(backfill.report());
});

// 지금 실행 중인 작업 — 피드와 상관없이 그때그때 묻는다(Operations 탭이 보일 때 2초마다)
monitorRouter.get('/monitor/operations', async (req, res) => {
  const database = text(req.query.database);
  const collection = text(req.query.collection);
  if (collection && !database) throw new HttpError(400, 'collection needs a database');
  const id = connectionIdOf(res);
  res.json(await listOperations(() => clientFor(id), {
    database: database ? checkDatabaseName(database) : null,
    collection: collection ? checkCollectionName(collection) : null,
  }));
});

monitorRouter.post('/monitor/operations/kill', async (req, res) => {
  const opid = (req.body as { opid?: unknown } | undefined)?.opid;
  // 숫자(복제 세트) 또는 "샤드이름:숫자"(mongos)
  if (typeof opid !== 'string' || !/^(?:[\w.-]+:)?\d+$/.test(opid)) throw new HttpError(400, 'opid must be an operation id from GET /monitor/operations');
  await killOperation(await clientFor(connectionIdOf(res)), opid);
  res.status(204).end();
});

const RANGES: readonly MonitorRange[] = ['5m', '1h', '24h', '7d', '30d', '90d', 'all'];

// 느린 쿼리 — 피드가 열려 있는 동안 샘플러가 서버 로그에서 모은 것(기록 파일 + 아직 안 적은 지금 분)
monitorRouter.get('/monitor/slow', async (req, res) => {
  const range = String(req.query.range ?? '1h') as MonitorRange;
  if (!RANGES.includes(range)) throw new HttpError(400, `range must be one of ${RANGES.join(', ')}`);
  const min = Number(req.query.min ?? SLOW_THRESHOLDS[0]) as SlowThreshold;
  if (!SLOW_THRESHOLDS.includes(min)) throw new HttpError(400, `min must be one of ${SLOW_THRESHOLDS.join(', ')}`);
  const database = text(req.query.database);
  const collection = text(req.query.collection);
  if (collection && !database) throw new HttpError(400, 'collection needs a database');
  const scope = {
    database: database ? checkDatabaseName(database) : null,
    collection: collection ? checkCollectionName(collection) : null,
  };
  const slow = slowOf(connectionIdOf(res));
  if (!slow) {
    const closed: SlowQueriesReport = { at: Date.now(), range, status: 'closed', error: null, slowms: null, min, groups: [], hidden: 0, missed: [], stored: getServerSettings().monitorHistory !== 'off' };
    res.json(closed);
    return;
  }
  res.json(await slow.report({ range, scope, min }));
});

const scopeOf = (query: Record<string, unknown>) => {
  const database = text(query.database);
  const collection = text(query.collection);
  if (collection && !database) throw new HttpError(400, 'collection needs a database');
  return {
    database: database ? checkDatabaseName(database) : null,
    collection: collection ? checkCollectionName(collection) : null,
  };
};

const closedSizes = (): SizesReport => ({
  status: 'closed',
  error: null,
  measuring: false,
  at: null,
  stored: getServerSettings().monitorHistory !== 'off',
  rows: [],
  total: { count: 0, size: 0, storage: 0, index: 0 },
  baseAt: null,
  baseTotal: null,
  trend: [],
});

// 컬렉션 크기 — 피드가 열려 있는 동안 1시간마다 잰 것(기록 파일 + 마지막 측정)
monitorRouter.get('/monitor/sizes', async (req, res) => {
  const range = String(req.query.range ?? '1h') as MonitorRange;
  if (!RANGES.includes(range)) throw new HttpError(400, `range must be one of ${RANGES.join(', ')}`);
  const sizes = sizesOf(connectionIdOf(res));
  res.json(sizes ? await sizes.report({ range, scope: scopeOf(req.query) }) : closedSizes());
});

monitorRouter.post('/monitor/sizes/measure', (_req, res) => {
  const sizes = sizesOf(connectionIdOf(res));
  if (!sizes) throw new HttpError(409, 'No tab is using this connection');
  res.json({ started: sizes.measureNow() });
});
