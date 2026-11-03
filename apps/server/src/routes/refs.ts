// 참조(FK)·내보내기용 조회 API (4-4)
//   GET  /api/oid/:oid                                   → 이 oid를 _id로 가진 문서가 어디 있는지 + 문서 전체
//   GET  /api/databases/:db/collections/:col/export      → CollectionExport (문서 전체 + PK/FK 선언)
//   POST /api/databases/:db/collections/:col/find-by-field  { key, value } → FieldReferenceCandidate[]
//   GET  /api/databases/:db/collections/:col/field-values?key=  → FieldValueCandidate[]
// 값 비교 규칙은 Mock(findDocumentsByField)과 같게 맞춘다 — 같은 화면이 Mock/서버에서 같은 결과를 내도록.
import { Router } from 'express';
import {
  compareKey,
  getDocumentId,
  isOid,
  makeOid,
  oidTimestampMs,
  summarizeDocument,
  toCanonical,
  type CollectionExport,
  type Document,
  type EjsonValue,
  type FieldReferenceCandidate,
  type FieldValueCandidate,
} from '@mongolive/shared';
import { getClient } from '../db';
import { getCollectionMeta } from '../meta';
import { checkCollectionName, checkDatabaseName, HIDDEN_DATABASES, HttpError } from '../names';
import { fromWire, READ_OPTIONS, toWire } from '../wire';
import { DOCUMENT_LIST_LIMIT, listCollectionNames } from './read';

export const refsRouter = Router();

const collectionFrom = async (dbName: string, colName: string) =>
  (await getClient()).db(checkDatabaseName(dbName)).collection(checkCollectionName(colName));

// 필드 이름 검사 — '$'로 시작하면 쿼리 연산자로 해석될 수 있으므로 거부
const checkKey = (key: unknown): string => {
  if (typeof key !== 'string' || key.length === 0 || key.startsWith('$') || key.includes('\0')) {
    throw new HttpError(400, `잘못된 필드 이름: ${String(key)}`);
  }
  return key;
};

// ── oid → 위치 ────────────────────────────────────────────────────────────────
// 어느 컬렉션에 있는지 모르므로 모든 컬렉션에 _id로 물어본다(_id 인덱스라 컬렉션당 아주 싸다).
// 한 번 찾은 위치는 기억해 두고 다음엔 거기부터 확인한다. 문서가 옮겨졌거나 지워졌으면 다시 전체 검색.
const locationCache = new Map<string, { database: string; collection: string }>();
const LOCATION_CACHE_MAX = 2000;

const findByOid = async (oid: string) => {
  const client = await getClient();
  const filter = { _id: fromWire(makeOid(oid)) } as never;

  const cached = locationCache.get(oid);
  if (cached) {
    const hit = await client.db(cached.database).collection(cached.collection).findOne(filter, READ_OPTIONS);
    if (hit) return { ...cached, document: toWire<Document>(hit) };
    locationCache.delete(oid);
  }

  const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });
  for (const { name: database } of databases) {
    if (HIDDEN_DATABASES.has(database)) continue;
    const db = client.db(database);
    for (const collection of await listCollectionNames(db)) {
      const hit = await db.collection(collection).findOne(filter, READ_OPTIONS);
      if (hit) {
        if (locationCache.size >= LOCATION_CACHE_MAX) locationCache.clear();
        locationCache.set(oid, { database, collection });
        return { database, collection, document: toWire<Document>(hit) };
      }
    }
  }
  return null;
};

refsRouter.get('/oid/:oid', async (req, res) => {
  const oid = req.params.oid.toLowerCase();
  if (!/^[0-9a-f]{24}$/.test(oid)) throw new HttpError(400, `잘못된 ObjectId: ${req.params.oid}`);
  const found = await findByOid(oid);
  if (!found) throw new HttpError(404, 'Document not found');
  res.json(found);
});

// ── 내보내기 ──────────────────────────────────────────────────────────────────

refsRouter.get('/databases/:db/collections/:col/export', async (req, res) => {
  const collection = await collectionFrom(req.params.db, req.params.col);
  const meta = await getCollectionMeta(req.params.db, req.params.col);
  const documents = (await collection.find({}, READ_OPTIONS).toArray()).map((d) => toWire<Document>(d));
  const result: CollectionExport = {
    name: req.params.col,
    label: req.params.col,
    description: '',
    documents,
    ...meta,
  };
  res.json(result);
});

// ── FK 따라가기: target 컬렉션에서 key 값이 value인 문서들 ─────────────────────

refsRouter.post('/databases/:db/collections/:col/find-by-field', async (req, res) => {
  const { db: dbName, col: colName } = req.params;
  const collection = await collectionFrom(dbName, colName);
  const key = checkKey(req.body?.key);
  const value = toCanonical(req.body?.value) as EjsonValue;
  const meta = await getCollectionMeta(dbName, colName);

  // 1차: MongoDB 쿼리로 후보를 좁힌다(인덱스가 있으면 탄다).
  // _id 대상은 Mock과 같이 느슨하게 — FK에 oid가 hex 문자열로 저장된 경우도 찾는다.
  const candidates: unknown[] = [fromWire(value)];
  if (key === '_id' && typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value)) {
    candidates.push(fromWire(makeOid(value)));
  }
  const raw = await collection
    .find({ [key]: { $in: candidates } } as never, { ...READ_OPTIONS, limit: DOCUMENT_LIST_LIMIT })
    .toArray();

  // 2차: Mock의 compareKey 규칙으로 다시 거른다. MongoDB 쿼리는 배열 필드면 '원소 중 하나'만 같아도,
  // 'a.b' 키면 중첩 경로로 매칭하는데, Mock은 최상위 키의 값 전체를 비교하기 때문이다.
  const target = compareKey(value);
  const result: FieldReferenceCandidate[] = [];
  for (const bson of raw) {
    const document = toWire<Document>(bson);
    const field = document[key];
    const matches =
      compareKey(field) === target ||
      (key === '_id' && isOid(field) && typeof value === 'string' && field.$oid === value.toLowerCase());
    if (!matches) continue;
    result.push({
      database: dbName,
      collection: colName,
      documentId: getDocumentId(document, meta.primaryKey) ?? '',
      documentTitle: summarizeDocument(document, 0, meta.titleKey, meta.primaryKey).title,
    });
  }
  res.json(result);
});

// ── FK 입력 후보: target 컬렉션의 key 값 목록 ─────────────────────────────────

refsRouter.get('/databases/:db/collections/:col/field-values', async (req, res) => {
  const { db: dbName, col: colName } = req.params;
  const collection = await collectionFrom(dbName, colName);
  const key = checkKey(req.query.key);
  const meta = await getCollectionMeta(dbName, colName);

  const raw = await collection.find({}, { ...READ_OPTIONS, limit: DOCUMENT_LIST_LIMIT }).toArray();
  const result: FieldValueCandidate[] = [];
  for (const bson of raw) {
    const document = toWire<Document>(bson);
    const value = document[key];
    if (value === undefined || value === null || value === '') continue;
    result.push({
      value,
      title: summarizeDocument(document, oidTimestampMs(document._id) ?? 0, meta.titleKey, meta.primaryKey).title,
    });
  }
  res.json(result);
});
