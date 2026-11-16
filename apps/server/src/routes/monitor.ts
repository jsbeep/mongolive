// Monitor 화면의 조회 (9-2~)
//   GET /api/monitor/activity?database=&collection=&range=5m|1h → ActivityReport
//       changeStream으로 본 쓰기의 집계(범위: 서버 전체 / DB / 컬렉션). DB에 묻지 않는다 — 피드가 센 것을 잘라서 줄 뿐
//   GET /api/monitor/last-writes → LastWrites (사이드바 트리의 '마지막 쓰기')
// 피드는 이 연결을 쓰는 탭이 있을 때만 열려 있다. 없으면 빈 값(since 없음)
import { Router } from 'express';
import type { ActivityRange, ActivityReport, LastWrites } from '@mongolive/shared';
import { connectionIdOf } from '../db';
import { checkCollectionName, checkDatabaseName, HttpError } from '../names';
import { activityOf } from '../realtime';

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
