// 컬렉션/DB 쓰기 (6-2).
//
//   createDatabase      새 DB(+ 같이 넣을 컬렉션들: 샘플 데이터·파일 가져오기)
//   deleteDatabase      DB 삭제
//   createCollection    새 컬렉션(+ 가져온 문서들)
//   renameCollection    이름 변경
//   duplicateCollection 컬렉션 복제 — "name-copy", ObjectId _id는 새로 발급
//   deleteCollection    컬렉션 삭제
//
// label/description은 MongoDB에 둘 곳이 없어 버린다(화면엔 이름이 그대로 보인다).
// PK/FK/titleKey 선언은 meta.json이 따라간다(이름 변경 → 옮기기, 복제 → 복사, 삭제 → 지우기).
import {
  collectionKey,
  isOid,
  makeOid,
  toCanonical,
  type Document,
  type MutationRequest,
  type MutationResult,
  type ReferenceFieldConfig,
} from '@mongolive/shared';
import { MongoServerError, ObjectId, type Db, type Document as BsonDocument } from 'mongodb';
import { getClient } from '../db';
import { emptyDatabases } from '../emptyDatabases';
import { copyCollectionMeta, deleteCollectionMeta, moveCollectionMeta, updateCollectionMeta } from '../meta';
import { checkCollectionName, checkDatabaseName, HttpError } from '../names';
import { listCollectionNames } from '../routes/read';
import { fromWire, READ_OPTIONS, toWire } from '../wire';
import { hasUsableId, uniqueKey } from './documents';

type StructureOp = Extract<
  MutationRequest,
  { type: 'createDatabase' | 'deleteDatabase' | 'createCollection' | 'renameCollection' | 'duplicateCollection' | 'deleteCollection' }
>;

export const STRUCTURE_OPS = new Set<string>([
  'createDatabase',
  'deleteDatabase',
  'createCollection',
  'renameCollection',
  'duplicateCollection',
  'deleteCollection',
]);

const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new HttpError(400, `${field}는 문자열이어야 합니다`);
  return value;
};

const existingDatabaseNames = async (): Promise<Set<string>> => {
  const { databases } = await (await getClient()).db('admin').admin().listDatabases({ nameOnly: true });
  return new Set(databases.map((d) => d.name));
};

// MongoDB 에러 → 사람이 읽을 HTTP 에러
const translate = (e: unknown): never => {
  if (e instanceof MongoServerError) {
    if (e.code === 48) throw new HttpError(409, 'Collection name already exists');
    if (e.code === 26) throw new HttpError(404, 'Collection not found');
    if (e.code === 11000) throw new HttpError(400, `_id가 겹치는 문서가 있습니다: ${e.message}`);
    if (e.code === 73) throw new HttpError(400, `잘못된 이름: ${e.message}`);
  }
  throw e;
};

// 가져온 문서들을 Canonical로 맞추고 _id가 없거나 쓸 수 없으면 새 ObjectId를 붙인다
// (MongoDB 문서엔 _id가 꼭 있어야 한다 — Mock은 plain JSON이면 비워 두지만 여기선 불가능)
const prepareDocuments = (raw: unknown[] | undefined): BsonDocument[] =>
  (raw ?? []).map((item, i) => {
    const doc = toCanonical(item);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, `${i + 1}번째 문서가 JSON 객체가 아닙니다`);
    const document = doc as Document;
    if (!hasUsableId(document._id)) document._id = makeOid(new ObjectId().toHexString());
    return fromWire(document) as BsonDocument;
  });

// 컬렉션을 만들고 문서를 넣는다. 넣다가 실패하면 방금 만든 컬렉션을 지워 반쯤 만든 상태를 남기지 않는다.
const createWithDocuments = async (db: Db, name: string, documents: BsonDocument[]): Promise<void> => {
  await db.createCollection(checkCollectionName(name)).catch(translate);
  if (documents.length === 0) return;
  try {
    await db.collection(name).insertMany(documents, { ordered: true });
  } catch (e) {
    await db.collection(name).drop().catch(() => undefined);
    translate(e);
  }
};

const openDb = async (database: string): Promise<Db> => (await getClient()).db(checkDatabaseName(database));

const requireCollection = async (db: Db, name: string): Promise<void> => {
  const found = await db.listCollections({ name: checkCollectionName(name) }, { nameOnly: true }).hasNext();
  if (!found) throw new HttpError(404, 'Collection not found');
};

const collectionResult = (database: string, collection: string, changedPath?: string, tracePath?: string[]): MutationResult => ({
  status: 'ok',
  changedPaths: [changedPath ?? `databases.${database}.collections.${collection}`],
  tracePath: tracePath ?? [database, collection],
  collectionKey: collectionKey(database, collection),
});

// ── 연산 ─────────────────────────────────────────────────────────────────────

const createDatabase = async (op: Extract<StructureOp, { type: 'createDatabase' }>): Promise<MutationResult> => {
  if (!op.database || typeof op.database !== 'object') throw new HttpError(400, 'database가 없습니다');
  const name = checkDatabaseName(str(op.database.name, 'database.name').trim());
  if ((await existingDatabaseNames()).has(name) || emptyDatabases.has(name)) throw new HttpError(409, 'Database already exists');

  const seeds = Object.entries(op.database.collections ?? {});
  if (seeds.length === 0) {
    emptyDatabases.add(name);
  } else {
    const db = await openDb(name);
    try {
      for (const [collectionName, seed] of seeds) {
        await createWithDocuments(db, collectionName, prepareDocuments(seed.documents));
        await updateCollectionMeta(name, collectionName, () => ({
          titleKey: seed.titleKey,
          primaryKey: seed.primaryKey,
          referenceFields: seed.referenceFields as Record<string, ReferenceFieldConfig> | undefined,
        }));
      }
    } catch (e) {
      // 방금 새로 만든 DB이므로 통째로 지워 되돌린다
      await db.dropDatabase().catch(() => undefined);
      await deleteCollectionMeta(name);
      throw e;
    }
  }
  return { status: 'ok', changedPaths: [`databases.${name}`], tracePath: [name] };
};

const deleteDatabase = async (op: Extract<StructureOp, { type: 'deleteDatabase' }>): Promise<MutationResult> => {
  const name = checkDatabaseName(str(op.database, 'database'));
  if (emptyDatabases.delete(name)) return { status: 'ok', changedPaths: [`databases.${name}`], tracePath: [name] };
  if (!(await existingDatabaseNames()).has(name)) throw new HttpError(404, 'DB not found');
  await (await openDb(name)).dropDatabase();
  await deleteCollectionMeta(name);
  return { status: 'ok', changedPaths: [`databases.${name}`], tracePath: [name] };
};

const createCollection = async (op: Extract<StructureOp, { type: 'createCollection' }>): Promise<MutationResult> => {
  const database = str(op.database, 'database');
  if (!op.collection || typeof op.collection !== 'object') throw new HttpError(400, 'collection이 없습니다');
  const name = checkCollectionName(str(op.collection.name, 'collection.name').trim());
  const db = await openDb(database);
  await createWithDocuments(db, name, prepareDocuments(op.collection.documents));
  emptyDatabases.delete(database);
  return collectionResult(database, name);
};

const renameCollection = async (op: Extract<StructureOp, { type: 'renameCollection' }>): Promise<MutationResult> => {
  const database = str(op.database, 'database');
  const oldName = checkCollectionName(str(op.oldName, 'oldName'));
  const newName = checkCollectionName(str(op.newName, 'newName').trim());
  const db = await openDb(database);
  await requireCollection(db, oldName);
  if (newName !== oldName) {
    // dropTarget: false(기본) — 같은 이름이 있으면 덮지 않고 에러
    await db.renameCollection(oldName, newName).catch(translate);
    await moveCollectionMeta(database, oldName, newName);
  }
  return collectionResult(database, newName);
};

const duplicateCollection = async (op: Extract<StructureOp, { type: 'duplicateCollection' }>): Promise<MutationResult> => {
  const database = str(op.database, 'database');
  const source = checkCollectionName(str(op.collection, 'collection'));
  const db = await openDb(database);
  await requireCollection(db, source);
  const target = uniqueKey(source, new Set(await listCollectionNames(db)));

  // ObjectId _id는 새로 발급(다른 컬렉션과 같은 oid면 참조가 헷갈린다), 다른 _id는 그대로
  const raw = await db.collection(source).find({}, READ_OPTIONS).toArray();
  const documents = raw.map((bson) => {
    const doc = toWire<Document>(bson);
    if (isOid(doc._id)) doc._id = makeOid(new ObjectId().toHexString());
    return fromWire(doc) as BsonDocument;
  });
  await createWithDocuments(db, target, documents);
  await copyCollectionMeta(database, source, target);
  return collectionResult(database, target);
};

const deleteCollection = async (op: Extract<StructureOp, { type: 'deleteCollection' }>): Promise<MutationResult> => {
  const database = str(op.database, 'database');
  const name = checkCollectionName(str(op.collection, 'collection'));
  const db = await openDb(database);
  await requireCollection(db, name);
  await db.collection(name).drop();
  await deleteCollectionMeta(database, name);
  // Mock과 같은 모양 — 강조 대상은 컬렉션 목록
  return collectionResult(database, name, `databases.${database}.collections`, [database]);
};

export const runStructureOp = (op: StructureOp): Promise<MutationResult> => {
  switch (op.type) {
    case 'createDatabase':
      return createDatabase(op);
    case 'deleteDatabase':
      return deleteDatabase(op);
    case 'createCollection':
      return createCollection(op);
    case 'renameCollection':
      return renameCollection(op);
    case 'duplicateCollection':
      return duplicateCollection(op);
    case 'deleteCollection':
      return deleteCollection(op);
  }
};
