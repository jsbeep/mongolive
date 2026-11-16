// Monitor 화면의 조회 (9-2~)
//   GET /api/monitor/activity?database=&collection=&range=5m|1h → ActivityReport
//       changeStream으로 본 쓰기의 집계(범위: 서버 전체 / DB / 컬렉션). DB에 묻지 않는다 — 피드가 센 것을 잘라서 줄 뿐
//   GET /api/monitor/last-writes → LastWrites (사이드바 트리의 '마지막 쓰기')
//   GET /api/monitor/history-info → HistoryInfo (설정 › Monitor — 기록 파일 크기·가장 오래된 기록)
//   DELETE /api/monitor/history → 이 연결의 기록 파일 전부 지우기
//   GET /api/monitor/history?range=24h|7d|30d|90d|all[&writes=1&database=&collection=] → HistoryReport (긴 기간, 9-3b)
// 피드는 이 연결을 쓰는 탭이 있을 때만 열려 있다. 없으면 빈 값(since 없음)
import { Router } from 'express';
import type { ActivityRange, ActivityReport, LastWrites } from '@mongolive/shared';
import { dropConnectionHistory, historyInfo } from '../monitor/history';
import { isFileRange, readHistory } from '../monitor/historyRead';
import { clusterFingerprint } from '../monitor/identity';
import { connectionUri } from '../connections';
import { clientFor, connectionIdOf } from '../db';
import { checkCollectionName, checkDatabaseName, HttpError } from '../names';
import { activityOf, recorderOf } from '../realtime';

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
