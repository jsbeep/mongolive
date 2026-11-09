// 사용자 aggregation 실행(읽기만).
//   POST /api/databases/:db/collections/:col/aggregate   본문 { pipeline, counts? }
//     counts 없음 → { results, truncated, elapsedMs }  (결과는 AGGREGATE_RESULT_LIMIT개까지, 넘으면 truncated)
//     counts: true → { counts, error?, elapsedMs }       (스테이지 카드의 "31 → 12" — 들어오는 문서와 스테이지마다 지난 문서 수)
// 검사(validatePipeline) → 변환(fromWire) → 실행(maxTimeMS). $out·$merge는 검사에서 막혀 여기까지 오지 않는다.
import { Router } from 'express';
import {
  AGGREGATE_COUNT_LIMIT,
  AGGREGATE_RESULT_LIMIT,
  isPlainObject,
  validatePipeline,
  type AggregateCounts,
  type AggregateResult,
  type StageCount,
} from '@mongolive/shared';
import type { Document as BsonDocument } from 'mongodb';
import type { Collection } from 'mongodb';
import { getClient } from '../db';
import { checkCollectionName, checkDatabaseName, HttpError } from '../names';
import { toQueryHttpError, toValueHttpError } from '../queryErrors';
import { fromWire, READ_OPTIONS, toWire } from '../wire';
import { QUERY_MAX_TIME_MS } from './read';

export const aggregateRouter = Router();

aggregateRouter.post('/databases/:db/collections/:col/aggregate', async (req, res) => {
  const body: Record<string, unknown> = isPlainObject(req.body) ? req.body : {};
  const invalid = validatePipeline(body.pipeline);
  if (invalid) throw new HttpError(400, `Invalid pipeline: ${invalid.message}`, { path: invalid.path });

  let pipeline: BsonDocument[];
  try {
    pipeline = fromWire(body.pipeline as never) as BsonDocument[];
  } catch (e) {
    throw toValueHttpError(e);
  }

  const collection = (await getClient()).db(checkDatabaseName(req.params.db)).collection(checkCollectionName(req.params.col));
  const options = { ...READ_OPTIONS, maxTimeMS: QUERY_MAX_TIME_MS };
  const started = Date.now();
  try {
    if (body.counts === true) {
      res.json(await countStages(collection, pipeline, started));
      return;
    }
    const rows = await collection.aggregate([...pipeline, { $limit: AGGREGATE_RESULT_LIMIT + 1 }], options).toArray();
    const result: AggregateResult = {
      results: toWire<unknown[]>(rows.slice(0, AGGREGATE_RESULT_LIMIT)),
      truncated: rows.length > AGGREGATE_RESULT_LIMIT,
      elapsedMs: Date.now() - started,
    };
    res.json(result);
  } catch (e) {
    throw toQueryHttpError(e, QUERY_MAX_TIME_MS);
  }
});

// 스테이지마다 '여기까지 몇 개'를 앞에서부터 센다(앞부분 파이프라인 + $limit + $count). 개수는 상한에서 멈추고,
// 한 번 세는 데 QUERY_MAX_TIME_MS, 전체는 COUNT_BUDGET_MS까지. 어느 스테이지에서 막히면(입력 오류·시간 초과)
// 거기서 멈추고 그 스테이지를 알려 준다 — 그 뒤 카드는 개수 없이 보인다. 입력 탓이 아닌 오류는 그대로 던진다(500).
const COUNT_BUDGET_MS = 15_000;

const countStages = async (collection: Collection, pipeline: BsonDocument[], started: number): Promise<AggregateCounts> => {
  const counts: StageCount[] = [];
  for (let i = 0; i <= pipeline.length; i++) {
    const left = started + COUNT_BUDGET_MS - Date.now();
    // i = 0(들어오는 문서)은 늘 센다 — 나머지는 남은 시간 안에서만
    if (i > 0 && left <= 0) {
      return { counts, error: { stage: i - 1, message: `Stopped counting — the pipeline took over ${COUNT_BUDGET_MS / 1000}s` }, elapsedMs: Date.now() - started };
    }
    const maxTimeMS = i === 0 ? QUERY_MAX_TIME_MS : Math.min(QUERY_MAX_TIME_MS, left);
    try {
      const [row] = await collection
        .aggregate([...pipeline.slice(0, i), { $limit: AGGREGATE_COUNT_LIMIT + 1 }, { $count: 'n' }], { ...READ_OPTIONS, maxTimeMS })
        .toArray();
      const n = Number(row?.n ?? 0);
      counts.push({ n: Math.min(n, AGGREGATE_COUNT_LIMIT), capped: n > AGGREGATE_COUNT_LIMIT });
    } catch (e) {
      const mapped = toQueryHttpError(e, QUERY_MAX_TIME_MS);
      if (i === 0 || !(mapped instanceof HttpError)) throw mapped;
      return { counts, error: { stage: i - 1, message: mapped.message }, elapsedMs: Date.now() - started };
    }
  }
  return { counts, elapsedMs: Date.now() - started };
};

