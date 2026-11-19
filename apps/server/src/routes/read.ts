// 조회 API (4-2). 응답 문서는 전부 Canonical EJSON(toWire).
//   GET /api/databases
//   GET /api/databases/:db/collections
//   GET /api/databases/:db/collections/:col/documents
//   POST /api/databases/:db/collections/:col/documents   (본문 = DocumentQuery + mongoFilter, 사용자 쿼리)
//   GET /api/databases/:db/collections/:col/documents/:id
//   POST /api/databases/:db/collections/:col/explain     (본문 = { mongoFilter }, 쿼리 바의 Explain — 9-9)
import { Router } from 'express';
import {
  idLookupCandidates,
  type CollectionSummary,
  type DatabaseSummary,
  type Document,
  type DocumentQuery,
  type DocumentSort,
  isPlainObject,
  validateQueryFilter,
} from '@mongolive/shared';
import type { Db, Filter, Document as BsonDocument } from 'mongodb';
import { clientOf, connectionIdOf, connOf, type MongoConn } from '../db';
import { emptyDatabasesOf } from '../emptyDatabases';
import { getCollectionMeta } from '../meta';
import { toQueryHttpError, toValueHttpError } from '../queryErrors';
import { checkCollectionName, checkDatabaseName, HIDDEN_DATABASES, HttpError, isHiddenCollection } from '../names';
import { summarizeExplain } from '../explain';
import { listDocumentPage } from '../documentList';
import { fromWire, READ_OPTIONS, toWire } from '../wire';

// FK 후보 목록(find-by-field, field-values) 상한 — 실수로 거대한 컬렉션을 대상으로 잡아도 버티게
export const DOCUMENT_LIST_LIMIT = 5000;

// 사용자 쿼리 시간 제한 — 넘으면 MongoDB가 멈추고 오류를 돌려준다(느린 정규식·인덱스 없는 큰 컬렉션)
export const QUERY_MAX_TIME_MS = 5000;

export const readRouter = Router();

// 일반 컬렉션 이름만(뷰·시스템 컬렉션 제외). 뷰는 _id 조회/변경 감지가 안 되므로 지금은 다루지 않는다.
export const listCollectionNames = async (db: Db): Promise<string[]> => {
  const infos = await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray();
  return infos.map((c) => c.name).filter((name) => !isHiddenCollection(name)).sort();
};

readRouter.get('/databases', async (_req, res) => {
  const client = await clientOf(res);
  const emptyDatabases = emptyDatabasesOf(connectionIdOf(res));
  const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });

  const result: DatabaseSummary[] = [];
  for (const { name } of databases) {
    if (HIDDEN_DATABASES.has(name)) continue;
    const db = client.db(name);
    const collections = await listCollectionNames(db);
    // estimatedDocumentCount = 컬렉션 메타데이터에서 읽는 개수 — 문서를 세지 않아서 빠르다
    const counts = await Promise.all(collections.map((c) => db.collection(c).estimatedDocumentCount()));
    result.push({
      name,
      label: name,
      description: '',
      collectionCount: collections.length,
      documentCount: counts.reduce((a, b) => a + b, 0),
      updatedAt: 0,
    });
  }
  // 컬렉션 없이 만든 DB(서버 메모리) — 그 사이 진짜 DB가 됐으면 잊는다
  for (const { name } of databases) emptyDatabases.delete(name);
  for (const name of emptyDatabases) {
    result.push({ name, label: name, description: '', collectionCount: 0, documentCount: 0, updatedAt: 0 });
  }
  res.json(result);
});

readRouter.get('/databases/:db/collections', async (req, res) => {
  const db = (await clientOf(res)).db(checkDatabaseName(req.params.db));
  const names = await listCollectionNames(db);

  const result: CollectionSummary[] = await Promise.all(
    names.map(async (name): Promise<CollectionSummary> => {
      const collection = db.collection(name);
      const meta = await getCollectionMeta(connectionIdOf(res), db.databaseName, name);
      const [documentCount, sizeBytes] = await Promise.all([
        collection.estimatedDocumentCount(),
        collection
          .aggregate<{ storageStats?: { size?: number } }>([{ $collStats: { storageStats: {} } }])
          .next()
          .then((s) => s?.storageStats?.size ?? 0)
          .catch(() => 0),
      ]);
      return {
        name,
        label: name,
        description: '',
        documentCount,
        sizeMb: Number(Math.max(0.01, sizeBytes / 1_000_000).toFixed(2)),
        updatedAt: 0,
        titleKey: meta.titleKey,
        primaryKey: meta.primaryKey,
        referenceFields: meta.referenceFields,
      };
    }),
  );
  res.json(result);
});

const SORTS: readonly DocumentSort[] = ['none', 'title-asc', 'title-desc', 'fields-desc', 'fields-asc', 'updated-desc', 'updated-asc'];

// 쿼리스트링(GET) 또는 본문(POST) → DocumentQuery. 이상한 값은 버리고 기본값으로(queryDocuments가 범위도 다시 자른다)
const parseDocumentQuery = (q: Record<string, unknown>): DocumentQuery => {
  const int = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const sort = text(q.sort);
  return {
    page: int(q.page),
    pageSize: int(q.pageSize),
    filter: text(q.filter),
    sort: SORTS.includes(sort as DocumentSort) ? (sort as DocumentSort) : undefined,
    aroundId: text(q.aroundId),
    markId: text(q.markId),
  };
};

// 문서 목록 한 페이지 — 요약 재료만 받아오고, 큰 결과는 MongoDB에서 페이지만(documentList.ts)
const listDocuments = async ({ id, client }: MongoConn, dbName: string, colName: string, query: DocumentQuery, mongoFilter?: Filter<BsonDocument>) => {
  const db = client.db(checkDatabaseName(dbName));
  const collection = db.collection(checkCollectionName(colName));
  const meta = await getCollectionMeta(id, db.databaseName, collection.collectionName);
  return listDocumentPage(collection, query, { meta, mongoFilter, maxTimeMS: QUERY_MAX_TIME_MS });
};

readRouter.get('/databases/:db/collections/:col/documents', async (req, res) => {
  const conn = await connOf(res);
  try {
    res.json(await listDocuments(conn, req.params.db, req.params.col, parseDocumentQuery(req.query as Record<string, unknown>)));
  } catch (e) {
    // 큰 컬렉션의 먼 페이지(skip)가 시간 제한에 걸린 경우
    throw toQueryHttpError(e, QUERY_MAX_TIME_MS);
  }
});

// 본문의 사용자 쿼리(mongoFilter) — 허용 연산자 검사 → BSON 변환. 틀리면 400
//   검사 → 변환 순서 — 검사는 Canonical EJSON 그대로 봐야 연산자와 값({ $oid })을 가린다
const userFilterOf = (body: Record<string, unknown>): Filter<BsonDocument> => {
  const mongoFilter = body.mongoFilter ?? {};
  const invalid = validateQueryFilter(mongoFilter);
  if (invalid) throw new HttpError(400, `Invalid query: ${invalid.message}`, { path: invalid.path });
  try {
    return fromWire(mongoFilter as never) as Filter<BsonDocument>;
  } catch (e) {
    throw toValueHttpError(e);
  }
};

// 사용자 쿼리 — 쿼리가 길 수 있고(주소 길이 제한) 값이 접속 기록에 남지 않게 POST 본문으로 받는다
readRouter.post('/databases/:db/collections/:col/documents', async (req, res) => {
  const body: Record<string, unknown> = isPlainObject(req.body) ? req.body : {};
  const filter = userFilterOf(body);
  try {
    res.json(await listDocuments(await connOf(res), req.params.db, req.params.col, parseDocumentQuery(body), filter));
  } catch (e) {
    throw toQueryHttpError(e, QUERY_MAX_TIME_MS);
  }
});

// 쿼리 바의 Explain(9-9) — 앱이 실제로 돌리는 find(쿼리)(정렬·limit 없음)를 executionStats로.
// 쿼리를 한 번 돌려 보지만 문서는 돌려받지 않는다. 시간 제한은 Run과 같다
readRouter.post('/databases/:db/collections/:col/explain', async (req, res) => {
  const body: Record<string, unknown> = isPlainObject(req.body) ? req.body : {};
  const filter = userFilterOf(body);
  const { client } = await connOf(res);
  const collection = client.db(checkDatabaseName(req.params.db)).collection(checkCollectionName(req.params.col));
  try {
    const explain = await collection.find(filter).explain({ verbosity: 'executionStats', maxTimeMS: QUERY_MAX_TIME_MS });
    res.json(summarizeExplain(explain));
  } catch (e) {
    throw toQueryHttpError(e, QUERY_MAX_TIME_MS);
  }
});

readRouter.get('/databases/:db/collections/:col/documents/:id', async (req, res) => {
  const db = (await clientOf(res)).db(checkDatabaseName(req.params.db));
  const collection = db.collection(checkCollectionName(req.params.col));

  // id 문자열 "5"는 문자열 "5"/Int32 5/Long 5/Double 5.0 중 무엇이었는지 모른다 — 후보 전부로 찾는다
  const candidates = idLookupCandidates(req.params.id).map(fromWire);
  const found = await collection.findOne({ _id: { $in: candidates } } as never, READ_OPTIONS);
  if (!found) throw new HttpError(404, 'Document not found');
  res.json(toWire<Document>(found));
});
