// 문서 쓰기 (6-1). 웹이 보내는 연산을 MongoDB 업데이트로 옮긴다.
//
//   mutateField       필드 하나 추가/수정/삭제 — 바뀐 경로만 $set/$unset (문서 통째로 덮지 않음)
//   upsertDocument    문서 추가(또는 같은 _id 문서 교체)
//   duplicateDocument 문서 복제 — _id 모양 유지, 제목 뒤에 " copy"
//   deleteDocument    문서 삭제
//
// 흔적 없음: 존재하는 컬렉션에만 쓴다(MongoDB는 없는 컬렉션에 쓰면 조용히 만들어 버린다).
// 결과(changedPaths/tracePath)는 Mock(mockAPI.ts)과 같은 모양이다.
import {
  cloneValue,
  collectionKey,
  getDocumentId,
  idLookupCandidates,
  isOid,
  makeInt32,
  makeLong,
  makeOid,
  mutateDocumentField,
  numericValue,
  resolveMutableContainer,
  toCanonical,
  valueKind,
  type Document,
  type EjsonValue,
  type MutateFieldSpec,
  type MutationRequest,
  type MutationResult,
} from '@mongolive/shared';
import { ObjectId, type ClientSession, type Collection, type Document as BsonDocument } from 'mongodb';
import { getClient } from '../db';
import { getCollectionMeta } from '../meta';
import { checkCollectionName, checkDatabaseName, HttpError } from '../names';
import { fromWire, READ_OPTIONS, toWire } from '../wire';

type DocumentOp = Extract<MutationRequest, { type: 'mutateField' | 'upsertDocument' | 'duplicateDocument' | 'deleteDocument' }>;

export const DOCUMENT_OPS = new Set<string>(['mutateField', 'upsertDocument', 'duplicateDocument', 'deleteDocument']);

// 존재하는 컬렉션만 돌려준다
const openCollection = async (database: string, collection: string): Promise<Collection> => {
  const db = (await getClient()).db(checkDatabaseName(database));
  const name = checkCollectionName(collection);
  const found = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!found) throw new HttpError(404, 'Collection not found');
  return db.collection(name);
};

// 식별자 문자열 → 문서. 읽기 API와 같은 규칙(후보 _id 전부로 찾기)
const findByDocumentId = async (collection: Collection, documentId: string) => {
  const candidates = idLookupCandidates(documentId).map(fromWire);
  const bson = await collection.findOne({ _id: { $in: candidates } } as never, READ_OPTIONS);
  if (!bson) throw new HttpError(404, 'Document not found');
  return { bson, wire: toWire<Document>(bson) };
};

// 점 표기("a.b.0")로 주소를 만들 수 없는 키는 받지 않는다 — '.'이 들어가거나 '$'로 시작하면
// MongoDB 업데이트 경로가 다른 뜻이 된다
const checkSegment = (segment: string): string => {
  if (segment === '' || segment.includes('.') || segment.startsWith('$') || segment.includes('\0')) {
    throw new HttpError(400, `이 앱에서 다룰 수 없는 필드 이름: "${segment}"`);
  }
  return segment;
};

const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new HttpError(400, `${field}는 문자열이어야 합니다`);
  return value;
};

const parseFieldSpec = (raw: unknown): MutateFieldSpec => {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'field가 없습니다');
  const f = raw as Record<string, unknown>;
  if (!Array.isArray(f.path) || !f.path.every((p) => typeof p === 'string')) throw new HttpError(400, 'field.path는 문자열 배열이어야 합니다');
  if (f.action !== 'add' && f.action !== 'edit' && f.action !== 'delete') throw new HttpError(400, `잘못된 field.action: ${String(f.action)}`);
  const containerType = f.containerType === 'array' ? 'array' : 'object';
  return {
    path: (f.path as string[]).map(checkSegment),
    key: checkSegment(str(f.key, 'field.key')),
    action: f.action,
    // 값은 Canonical로 정규화(웹이 relaxed 모양을 보내도 같은 결과) — Mock과 동일
    value: f.value === undefined ? undefined : toCanonical(f.value),
    nextKey: f.nextKey === undefined || f.nextKey === null ? undefined : checkSegment(str(f.nextKey, 'field.nextKey')),
    containerType,
  };
};

const docBase = (database: string, collection: string, documentId: string) =>
  `databases.${database}.collections.${collection}.documents.${documentId}`;

const okResult = (
  database: string,
  collection: string,
  documentId: string,
  changedPaths: string[],
  opTime: string | undefined,
  tracePath?: string[],
): MutationResult => ({
  status: 'ok',
  changedPaths,
  tracePath: tracePath ?? [database, collection, documentId],
  collectionKey: collectionKey(database, collection),
  opTime,
});

// 쓰기 한 번을 세션 안에서 실행하고 그 쓰기의 시각 도장(operationTime)을 돌려준다.
// 같은 쓰기의 changeStream 알림에 똑같은 값(clusterTime)이 실려 오므로, 브라우저가 둘을 맞춰
// '내가 한 저장의 메아리'를 알아본다. (세션은 도장을 읽으려고 쓸 뿐 트랜잭션이 아니다)
const withOpTime = async <T>(run: (session: ClientSession) => Promise<T>): Promise<{ value: T; opTime?: string }> => {
  const session = (await getClient()).startSession();
  try {
    const value = await run(session);
    return { value, opTime: session.operationTime?.toString() };
  } finally {
    await session.endSession();
  }
};

// ── mutateField ──────────────────────────────────────────────────────────────

const mutateField = async (op: Extract<DocumentOp, { type: 'mutateField' }>): Promise<MutationResult> => {
  const database = str(op.database, 'database');
  const collectionName = str(op.collection, 'collection');
  const documentId = str(op.documentId, 'documentId');
  const field = parseFieldSpec(op.field);
  const collection = await openCollection(database, collectionName);
  const { bson, wire } = await findByDocumentId(collection, documentId);

  if (field.path.length === 0 && (field.key === '_id' || field.nextKey === '_id')) {
    throw new HttpError(400, '_id는 바꿀 수 없습니다 (MongoDB 규칙)');
  }

  // 공유 규칙으로 '바뀐 뒤'를 계산한다 — 경로가 없거나 타입이 안 맞으면 여기서 걸러진다
  const before = resolveMutableContainer(wire, field.path);
  const next = cloneValue(wire) as Document;
  let mutation;
  try {
    mutation = mutateDocumentField(next, field);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }

  const containerPath = field.path.join('.');
  const join = (key: string) => (containerPath ? `${containerPath}.${key}` : key);
  const filter: BsonDocument = { _id: bson._id };
  const update: BsonDocument = {};

  if (field.containerType === 'array') {
    const length = Array.isArray(before) ? before.length : 0;
    const index = Number(field.key);
    if (field.action === 'edit' && index < length) {
      // 제자리 수정 — 그 칸만
      update.$set = { [join(String(index))]: fromWire(field.value ?? null) };
    } else {
      // 끼워넣기/빼기/끝에 붙이기: MongoDB엔 '몇 번째 칸 빼기'가 없으므로 새 배열을 통째로 쓴다.
      // 내가 읽은 배열과 같을 때만 쓴다(그 사이 누가 바꿨으면 칸 번호가 어긋나므로 거절)
      filter[containerPath] = fromWire(before as EjsonValue);
      update.$set = { [containerPath]: fromWire(resolveMutableContainer(next, field.path) as EjsonValue) };
    }
  } else if (field.action === 'delete') {
    update.$unset = { [join(field.key)]: '' };
  } else if (field.action === 'edit' && field.nextKey && field.nextKey !== field.key) {
    // 이름 바꾸기 = 옛 키 지우고 새 키에 쓰기(새 키는 맨 뒤로 간다 — Mock과 같음)
    update.$unset = { [join(field.key)]: '' };
    update.$set = { [join(field.nextKey)]: fromWire(field.value ?? null) };
  } else {
    update.$set = { [join(field.key)]: fromWire(field.value ?? null) };
  }

  const { value: { matchedCount }, opTime } = await withOpTime((session) => collection.updateOne(filter, update, { session }));
  if (matchedCount === 0) throw new HttpError(409, '그 사이 다른 곳에서 바뀌었습니다. 새로 불러온 뒤 다시 시도하세요');

  const base = docBase(database, collectionName, documentId);
  return okResult(
    database,
    collectionName,
    documentId,
    mutation.changedPaths.map((p) => `${base}.${p}`),
    opTime,
    [database, collectionName, documentId, ...field.path, field.key],
  );
};

// ── upsertDocument ───────────────────────────────────────────────────────────

const ID_KINDS = new Set(['oid', 'string', 'int32', 'long', 'double', 'decimal128']);

export const hasUsableId = (value: unknown): boolean => {
  const kind = valueKind(value);
  if (!ID_KINDS.has(kind)) return false;
  return kind !== 'string' || (value as string).trim() !== '';
};

const upsertDocument = async (op: Extract<DocumentOp, { type: 'upsertDocument' }>): Promise<MutationResult> => {
  const database = str(op.database, 'database');
  const collectionName = str(op.collection, 'collection');
  const collection = await openCollection(database, collectionName);

  const canonical = toCanonical(op.document);
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) throw new HttpError(400, '문서는 JSON 객체여야 합니다');
  const document = canonical as Document;
  // 식별할 수 없는 _id(없음/빈 문자열/객체 등)면 새 ObjectId — MongoDB 문서엔 _id가 꼭 있어야 한다
  if (!hasUsableId(document._id)) document._id = makeOid(new ObjectId().toHexString());

  const bson = fromWire(document) as BsonDocument;
  // 같은 _id가 있으면 교체, 없으면 추가 (Mock과 같은 동작)
  const { opTime } = await withOpTime((session) => collection.replaceOne({ _id: bson._id }, bson, { upsert: true, session }));

  const documentId = getDocumentId(document) ?? '';
  return okResult(database, collectionName, documentId, [docBase(database, collectionName, documentId)], opTime);
};

// ── duplicateDocument ────────────────────────────────────────────────────────

export const uniqueKey = (base: string, existing: Set<string>): string => {
  if (!existing.has(base)) return base;
  let candidate = `${base}-copy`;
  for (let i = 2; existing.has(candidate); i += 1) candidate = `${base}-copy-${i}`;
  return candidate;
};

const duplicateDocument = async (op: Extract<DocumentOp, { type: 'duplicateDocument' }>): Promise<MutationResult> => {
  const database = str(op.database, 'database');
  const collectionName = str(op.collection, 'collection');
  const collection = await openCollection(database, collectionName);
  const { wire: source } = await findByDocumentId(collection, str(op.documentId, 'documentId'));
  const meta = await getCollectionMeta(database, collectionName);

  const copy = cloneValue(source) as Document;
  const idKind = valueKind(source._id);
  if (isOid(source._id)) {
    copy._id = makeOid(new ObjectId().toHexString());
  } else if (idKind === 'string' || idKind === 'int32' || idKind === 'long') {
    // 문자열은 "u1" → "u1-copy", 숫자는 (최댓값 + 1) — 같은 컬렉션 안에 _id 타입이 섞이지 않게
    const ids = (await collection.find({}, { ...READ_OPTIONS, projection: { _id: 1 } }).toArray()).map((d) => toWire<Document>(d)._id);
    if (idKind === 'string') {
      copy._id = uniqueKey(source._id as string, new Set(ids.filter((id): id is string => typeof id === 'string')));
    } else {
      const max = ids.reduce<number>((m, id) => Math.max(m, numericValue(id) ?? m), 0);
      copy._id = idKind === 'int32' && max + 1 <= 2147483647 ? makeInt32(max + 1) : makeLong(max + 1);
    }
  } else {
    // double/decimal 등 — 새 ObjectId로
    copy._id = makeOid(new ObjectId().toHexString());
  }

  // 목록에 보이는 이름 뒤에 " copy" (summarizeDocument의 제목 결정 순서와 같게: titleKey → name → title → PK)
  const titleField = [meta.titleKey, 'name', 'title', meta.primaryKey].find(
    (k): k is string => !!k && typeof source[k] === 'string' && (source[k] as string).trim() !== '',
  );
  if (titleField && titleField !== '_id') copy[titleField] = `${source[titleField] as string} copy`;

  const { opTime } = await withOpTime((session) => collection.insertOne(fromWire(copy) as BsonDocument, { session }));
  const documentId = getDocumentId(copy) ?? '';
  return okResult(database, collectionName, documentId, [docBase(database, collectionName, documentId)], opTime);
};

// ── deleteDocument ───────────────────────────────────────────────────────────

const deleteDocument = async (op: Extract<DocumentOp, { type: 'deleteDocument' }>): Promise<MutationResult> => {
  const database = str(op.database, 'database');
  const collectionName = str(op.collection, 'collection');
  const documentId = str(op.documentId, 'documentId');
  const collection = await openCollection(database, collectionName);
  const { bson } = await findByDocumentId(collection, documentId);
  const { opTime } = await withOpTime((session) => collection.deleteOne({ _id: bson._id }, { session }));
  return okResult(database, collectionName, documentId, [docBase(database, collectionName, documentId)], opTime);
};

export const runDocumentOp = (op: DocumentOp): Promise<MutationResult> => {
  switch (op.type) {
    case 'mutateField':
      return mutateField(op);
    case 'upsertDocument':
      return upsertDocument(op);
    case 'duplicateDocument':
      return duplicateDocument(op);
    case 'deleteDocument':
      return deleteDocument(op);
  }
};
