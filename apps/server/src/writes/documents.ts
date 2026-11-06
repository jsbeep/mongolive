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
  type ConflictInfo,
  type Document,
  type EjsonValue,
  type ExpectedValue,
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

// { exists: false } | { exists: true, value } — 없거나 모양이 다르면 '확인 안 함'
const parseExpected = (raw: unknown): ExpectedValue | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  if (e.exists === false) return { exists: false };
  if (e.exists === true && 'value' in e) return { exists: true, value: toCanonical(e.value) };
  return undefined;
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
    expected: parseExpected(f.expected),
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

// 그 자리의 지금 값 → ExpectedValue 모양
const slotOf = (document: Document, segments: string[]): ExpectedValue => {
  const value = resolveMutableContainer(document, segments);
  return value === undefined ? { exists: false } : { exists: true, value };
};

// 타입까지 똑같아야 같은 값 — Int32 30 → Double 30.0처럼 타입만 바뀐 것도 남의 변경이다.
// (ejsonEquals는 FK 매칭용이라 숫자 타입을 일부러 무시하므로 여기선 쓰지 않는다)
// 드라이버로 한 번 왕복시켜 표기를 맞춘 뒤 비교한다(예: Double의 "30" / "30.0" 같은 표기 차이를 없앰)
const normalized = (value: EjsonValue): string => JSON.stringify(toWire(fromWire(value)));
const sameValue = (a: EjsonValue, b: EjsonValue): boolean => normalized(a) === normalized(b);

const sameSlot = (a: ExpectedValue, b: ExpectedValue): boolean =>
  a.exists === b.exists && (!a.exists || (b.exists && sameValue(a.value, b.value)));

const conflictError = (path: string[], current: ExpectedValue): HttpError =>
  new HttpError(409, '편집하는 동안 다른 곳에서 바뀌었습니다', {
    conflict: { path: path.join('.'), current } satisfies ConflictInfo,
  });

// 읽은 그대로일 때만 쓰도록 거는 조건(읽기 ~ 쓰기 사이 수 ms 동안 끼어든 변경을 막는다)
// 조건의 값 자리에 그냥 넣으면 $로 시작하는 키를 가진 객체는 연산자로, 정규식은 패턴으로 해석된다
// (MongoDB 5.0부터 그런 필드 이름도 저장할 수 있다). $eq로 감싸 '이 값과 같을 때'로 못 박는다.
const slotFilter = (slot: ExpectedValue): unknown => (slot.exists ? { $eq: fromWire(slot.value) } : { $exists: false });

// 읽고 → 확인하고 → 조건 걸어 쓰기를 한 번. 읽은 뒤 그 사이 바뀌어 조건이 안 맞으면 null(다시 시도)
const tryMutateField = async (
  collection: Collection,
  documentId: string,
  field: MutateFieldSpec,
): Promise<{ changedPaths: string[]; opTime?: string; undo: MutateFieldSpec } | null> => {
  const { bson, wire } = await findByDocumentId(collection, documentId);
  const target = [...field.path, field.key];
  const containerPath = field.path.join('.');
  const join = (key: string) => (containerPath ? `${containerPath}.${key}` : key);
  const before = resolveMutableContainer(wire, field.path);
  const isArray = field.containerType === 'array';

  // 배열 항목 추가는 '맨 끝에 붙이기' — 그 사이 누가 먼저 붙였어도 지금 끝에 붙인다
  let spec = field;
  const appending = isArray && field.action === 'add' && field.expected?.exists === false;
  if (appending && Array.isArray(before)) spec = { ...field, key: String(before.length) };

  // 충돌 확인: 내가 본 값 vs 지금 값 (확인할 값이 없으면 = 그래도 덮어쓰기)
  if (field.expected && !appending) {
    const current = slotOf(wire, target);
    if (!sameSlot(field.expected, current)) throw conflictError(target, current);
    // 이름 바꾸기: 새 이름 자리를 그 사이 누가 먼저 차지했으면 덮지 않는다
    if (field.action === 'edit' && field.nextKey && field.nextKey !== field.key) {
      const renamed = [...field.path, field.nextKey];
      const occupant = slotOf(wire, renamed);
      if (occupant.exists) throw conflictError(renamed, occupant);
    }
  }

  // 공유 규칙으로 '바뀐 뒤'를 계산한다 — 경로가 없거나 타입이 안 맞으면 여기서 걸러진다
  const next = cloneValue(wire) as Document;
  let mutation;
  try {
    mutation = mutateDocumentField(next, spec);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }

  const filter: BsonDocument = { _id: { $eq: bson._id } };
  const update: BsonDocument = {};
  const index = Number(spec.key);
  const length = Array.isArray(before) ? before.length : 0;

  if (isArray && spec.action === 'edit' && index < length) {
    // 배열 칸 제자리 수정 — 그 칸만
    filter[join(spec.key)] = slotFilter(slotOf(wire, [...spec.path, spec.key]));
    update.$set = { [join(spec.key)]: fromWire(spec.value ?? null) };
  } else if (isArray) {
    // 끼워넣기/빼기/끝에 붙이기: MongoDB엔 '몇 번째 칸 빼기'가 없으므로 새 배열을 통째로 쓴다.
    // 방금 읽은 배열 그대로일 때만(아니면 칸 번호가 어긋나므로 다시 읽어서 처음부터)
    filter[containerPath] = { $eq: fromWire(before as EjsonValue) };
    update.$set = { [containerPath]: fromWire(resolveMutableContainer(next, spec.path) as EjsonValue) };
  } else {
    filter[join(spec.key)] = slotFilter(slotOf(wire, [...spec.path, spec.key]));
    if (spec.action === 'delete') {
      update.$unset = { [join(spec.key)]: '' };
    } else if (spec.action === 'edit' && spec.nextKey && spec.nextKey !== spec.key) {
      // 이름 바꾸기 = 옛 키 지우고 새 키에 쓰기(새 키는 맨 뒤로 간다 — Mock과 같음)
      filter[join(spec.nextKey)] = { $exists: false };
      update.$unset = { [join(spec.key)]: '' };
      update.$set = { [join(spec.nextKey)]: fromWire(spec.value ?? null) };
    } else {
      update.$set = { [join(spec.key)]: fromWire(spec.value ?? null) };
    }
  }

  // 그래도 덮어쓰기(확인할 값 없음)면 끼어든 변경도 덮는다 — _id 조건만 남긴다(배열 통째 쓰기는 칸이 어긋나지 않게 유지)
  if (!field.expected && !(isArray && !(spec.action === 'edit' && index < length))) {
    for (const key of Object.keys(filter)) if (key !== '_id') delete filter[key];
  }

  const { value: { matchedCount }, opTime } = await withOpTime((session) => collection.updateOne(filter, update, { session }));
  if (matchedCount === 0) return null;
  return { changedPaths: mutation.changedPaths, opTime, undo: fieldInverse(spec, wire, next) };
};

// 필드 쓰기를 되돌리는 연산 — before(쓰기 전 문서)와 after(쓴 뒤 문서)로 만든다.
// expected는 '쓴 직후 값'이다: 그 사이 누가 또 바꿨으면 되돌리기가 409로 거절된다.
const fieldInverse = (spec: MutateFieldSpec, before: Document, after: Document): MutateFieldSpec => {
  const { path, key, containerType } = spec;
  const slot = (doc: Document, k: string) => slotOf(doc, [...path, k]);
  const valueAt = (doc: Document, k: string): EjsonValue => {
    const s = slot(doc, k);
    return s.exists ? s.value : null;
  };

  if (containerType === 'array') {
    const container = resolveMutableContainer(before, path);
    const length = Array.isArray(container) ? container.length : 0;
    const index = Number(key);
    if (spec.action === 'edit' && index < length) {
      // 칸 수정 → 원래 값으로
      return { path, key, action: 'edit', containerType, value: valueAt(before, key), expected: slot(after, key) };
    }
    if (spec.action === 'delete') {
      // 칸 삭제 → 그 자리에 다시 끼워넣기. 확인: 그 자리에 지금 있는 것(뒤에서 당겨진 칸, 끝이었으면 빈자리)
      return { path, key, action: 'add', containerType, value: valueAt(before, key), expected: slot(after, key) };
    }
    // 끼워넣기/끝에 붙이기 → 그 칸 빼기
    const at = String(Math.min(index, length));
    return { path, key: at, action: 'delete', containerType, expected: slot(after, at) };
  }

  if (spec.action === 'delete') {
    // 삭제 → 다시 추가(빈자리일 때만). 키는 맨 뒤로 간다
    return { path, key, action: 'add', containerType, value: valueAt(before, key), expected: { exists: false } };
  }
  if (spec.action === 'edit' && spec.nextKey && spec.nextKey !== key) {
    // 이름 바꾸기 → 새 이름에서 옛 이름으로, 원래 값으로
    return { path, key: spec.nextKey, nextKey: key, action: 'edit', containerType, value: valueAt(before, key), expected: slot(after, spec.nextKey) };
  }
  const was = slot(before, key);
  // 원래 있던 값을 바꿨으면 → 원래 값으로, 없던 걸 만들었으면 → 지우기
  return was.exists
    ? { path, key, action: 'edit', containerType, value: was.value, expected: slot(after, key) }
    : { path, key, action: 'delete', containerType, expected: slot(after, key) };
};

const MUTATE_ATTEMPTS = 3;

const mutateField = async (op: Extract<DocumentOp, { type: 'mutateField' }>): Promise<MutationResult> => {
  const database = str(op.database, 'database');
  const collectionName = str(op.collection, 'collection');
  const documentId = str(op.documentId, 'documentId');
  const field = parseFieldSpec(op.field);
  if (field.path.length === 0 && (field.key === '_id' || field.nextKey === '_id')) {
    throw new HttpError(400, '_id는 바꿀 수 없습니다 (MongoDB 규칙)');
  }
  const collection = await openCollection(database, collectionName);

  // 읽기와 쓰기 사이에 끼어든 변경 때문에 쓰지 못했으면 다시 읽어서 처음부터.
  // 다시 할 땐 충돌 확인이 '내가 본 값'으로 진짜 충돌인지 걸러 준다.
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt += 1) {
    const done = await tryMutateField(collection, documentId, field);
    if (!done) continue;
    const base = docBase(database, collectionName, documentId);
    return {
      ...okResult(
        database,
        collectionName,
        documentId,
        done.changedPaths.map((p) => `${base}.${p}`),
        done.opTime,
        [database, collectionName, documentId, ...field.path, field.key],
      ),
      undo: { type: 'mutateField', database, collection: collectionName, documentId, field: done.undo },
    };
  }
  throw new HttpError(409, '이 값이 계속 바뀌고 있어 저장하지 못했습니다. 잠시 뒤 다시 시도하세요');
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
  // 식별할 수 없는 _id(없음/빈 문자열/객체 등)면 새 ObjectId — MongoDB 문서엔 _id가 꼭 있어야 한다.
  // _id는 맨 앞에 둔다: MongoDB가 저장할 때 늘 맨 앞으로 옮기므로, 그래야 '쓴 직후 문서'가 저장된 모양과 같다
  // (되돌리기가 그 모양으로 '그 사이 안 바뀌었나'를 비교한다)
  const { _id: givenId, ...fields } = canonical as Document;
  const id: EjsonValue = hasUsableId(givenId) ? (givenId as EjsonValue) : makeOid(new ObjectId().toHexString());
  const document: Document = { _id: id, ...fields };

  const bson = fromWire(document) as BsonDocument;
  const existing = await collection.findOne({ _id: { $eq: bson._id } }, READ_OPTIONS);
  const was: ExpectedValue = existing ? { exists: true, value: toWire<Document>(existing) } : { exists: false };
  // 확인(되돌리기가 보낸 경우): 지금 그 _id 문서가 기대한 그대로인가
  const expected = parseExpected(op.expected);
  if (expected && !sameSlot(expected, was)) throw conflictError([], was);

  // 같은 _id가 있으면 교체, 없으면 추가 (Mock과 같은 동작)
  const { opTime } = await withOpTime((session) => collection.replaceOne({ _id: { $eq: bson._id } }, bson, { upsert: true, session }));

  const documentId = getDocumentId(document) ?? '';
  const now: ExpectedValue = { exists: true, value: document };
  return {
    ...okResult(database, collectionName, documentId, [docBase(database, collectionName, documentId)], opTime),
    // 교체였으면 → 원래 문서로, 추가였으면 → 그 문서 삭제 (둘 다 지금 그대로일 때만)
    undo: was.exists
      ? { type: 'upsertDocument', database, collection: collectionName, document: was.value as Document, expected: now }
      : { type: 'deleteDocument', database, collection: collectionName, documentId, expected: now },
  };
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
  return {
    ...okResult(database, collectionName, documentId, [docBase(database, collectionName, documentId)], opTime),
    // 복제본 삭제 (그 사이 고치지 않았을 때만)
    undo: { type: 'deleteDocument', database, collection: collectionName, documentId, expected: { exists: true, value: copy } },
  };
};

// ── deleteDocument ───────────────────────────────────────────────────────────

const deleteDocument = async (op: Extract<DocumentOp, { type: 'deleteDocument' }>): Promise<MutationResult> => {
  const database = str(op.database, 'database');
  const collectionName = str(op.collection, 'collection');
  const documentId = str(op.documentId, 'documentId');
  const collection = await openCollection(database, collectionName);
  const { bson, wire } = await findByDocumentId(collection, documentId);
  // 확인(되돌리기가 보낸 경우): 지울 문서가 기대한 그대로인가 — 그 사이 누가 고쳤으면 지우지 않는다
  const expected = parseExpected(op.expected);
  if (expected && !sameSlot(expected, { exists: true, value: wire })) throw conflictError([], { exists: true, value: wire });
  const { opTime } = await withOpTime((session) => collection.deleteOne({ _id: { $eq: bson._id } }, { session }));
  return {
    ...okResult(database, collectionName, documentId, [docBase(database, collectionName, documentId)], opTime),
    // 다시 넣기 (그 _id가 비어 있을 때만)
    undo: { type: 'upsertDocument', database, collection: collectionName, document: wire, expected: { exists: false } },
  };
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
