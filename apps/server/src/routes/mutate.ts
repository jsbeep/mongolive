// 변경 API — 웹의 api.mutate(MutationRequest)가 그대로 POST된다.
//   POST /api/mutate                    { type: ..., ... }
//   GET    /api/meta/owned-oids
//   PUT    /api/meta/owned-oids/:oid    (내가 만든 oid로 표시)
//   DELETE /api/meta/owned-oids/:oid
//   GET    /api/meta/collections        (이 연결의 컬렉션 메타 — 설정 › Data 백업 내보내기)
//   POST   /api/meta/collections        { collections } (가져오기 — 합치기, 없는 컬렉션은 건너뜀)
// 메타데이터 연산(titleKey/PK/FK)은 meta.json에만 쓰고 MongoDB는 건드리지 않는다.
// 문서 쓰기는 writes/documents.ts(6-1), 컬렉션/DB 쓰기는 writes/structure.ts(6-2).
import { Router } from 'express';
import {
  collectionKey,
  normalizeCollectionMetadata,
  splitCollectionKey,
  writeBlockedReason,
  type CollectionMetadata,
  type MetadataImportResult,
  type MutationRequest,
  type MutationResult,
} from '@mongolive/shared';
import { connectionIdOf, connOf, type MongoConn } from '../db';
import { importCollectionMeta, listCollectionMeta, listOwnedOids, setOwnedOid, updateCollectionMeta } from '../meta';
import { checkCollectionName, checkDatabaseName, HttpError, isHiddenCollection } from '../names';
import { DOCUMENT_OPS, runDocumentOp } from '../writes/documents';
import { runStructureOp, STRUCTURE_OPS } from '../writes/structure';
import { getServerSettings } from '../settings';

export const mutateRouter = Router();

const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new HttpError(400, `${field}는 문자열이어야 합니다`);
  return value;
};

const optionalStr = (value: unknown, field: string): string | undefined =>
  value === undefined || value === null ? undefined : str(value, field);

// 존재하지 않는 컬렉션에 메타를 쌓지 않도록 확인 (Mock의 'Collection not found'와 같은 동작)
const requireCollection = async (conn: MongoConn, database: string, collection: string): Promise<void> => {
  const db = conn.client.db(checkDatabaseName(database));
  const found = await db.listCollections({ name: checkCollectionName(collection) }, { nameOnly: true }).hasNext();
  if (!found) throw new HttpError(404, 'Collection not found');
};

const collectionResult = (database: string, collection: string): MutationResult => ({
  status: 'ok',
  changedPaths: [`databases.${database}.collections.${collection}`],
  tracePath: [database, collection],
  collectionKey: collectionKey(database, collection),
});

mutateRouter.post('/mutate', async (req, res) => {
  const op = req.body as Partial<MutationRequest> & Record<string, unknown>;
  if (!op || typeof op !== 'object') throw new HttpError(400, '요청 본문이 없습니다');

  // 안전장치(설정 창 › Safety): read-only / 보호 대상이면 거절. 되돌리기도 이 길로 오므로 같이 막힌다.
  // 모양이 틀린 요청은 판정이 실패할 수 있다 — 그건 아래 검사가 400으로 거절한다
  let blocked: string | null = null;
  try {
    blocked = writeBlockedReason(getServerSettings(), op as MutationRequest);
  } catch {
    blocked = null;
  }
  if (blocked) throw new HttpError(403, blocked);

  if (typeof op.type === 'string' && DOCUMENT_OPS.has(op.type)) {
    res.json(await runDocumentOp(await connOf(res), op as Parameters<typeof runDocumentOp>[1]));
    return;
  }
  if (typeof op.type === 'string' && STRUCTURE_OPS.has(op.type)) {
    res.json(await runStructureOp(await connOf(res), op as Parameters<typeof runStructureOp>[1]));
    return;
  }

  switch (op.type) {
    case 'setCollectionTitleKey': {
      const database = str(op.database, 'database');
      const collection = str(op.collection, 'collection');
      const titleKey = str(op.titleKey, 'titleKey').trim();
      await requireCollection(await connOf(res), database, collection);
      await updateCollectionMeta(connectionIdOf(res), database, collection, (m) => ({ ...m, titleKey: titleKey || undefined }));
      res.json(collectionResult(database, collection));
      return;
    }
    case 'setCollectionPrimaryKey': {
      const database = str(op.database, 'database');
      const collection = str(op.collection, 'collection');
      const primaryKey = str(op.primaryKey, 'primaryKey').trim();
      await requireCollection(await connOf(res), database, collection);
      await updateCollectionMeta(connectionIdOf(res), database, collection, (m) => ({ ...m, primaryKey: primaryKey || undefined }));
      res.json(collectionResult(database, collection));
      return;
    }
    case 'setCollectionReferenceField': {
      const database = str(op.database, 'database');
      const collection = str(op.collection, 'collection');
      const field = str(op.field, 'field');
      const targetCollection = optionalStr(op.targetCollection, 'targetCollection');
      const targetKey = optionalStr(op.targetKey, 'targetKey');
      await requireCollection(await connOf(res), database, collection);
      await updateCollectionMeta(connectionIdOf(res), database, collection, (m) => {
        const referenceFields = { ...m.referenceFields };
        // 대상이 비어 있으면 선언 해제 (Mock과 동일)
        if (!targetCollection || !targetKey) delete referenceFields[field];
        else referenceFields[field] = { targetCollection, targetKey };
        return { ...m, referenceFields };
      });
      res.json(collectionResult(database, collection));
      return;
    }
    default:
      throw new HttpError(501, `아직 지원하지 않는 연산: ${String(op.type)}`);
  }
});

const OID = /^[0-9a-f]{24}$/;

const checkOid = (oid: string): string => {
  const normalized = oid.toLowerCase();
  if (!OID.test(normalized)) throw new HttpError(400, `잘못된 ObjectId: ${oid}`);
  return normalized;
};

mutateRouter.get('/meta/owned-oids', async (_req, res) => {
  res.json(await listOwnedOids(connectionIdOf(res)));
});

mutateRouter.put('/meta/owned-oids/:oid', async (req, res) => {
  await setOwnedOid(connectionIdOf(res), checkOid(req.params.oid), true);
  res.status(204).end();
});

mutateRouter.delete('/meta/owned-oids/:oid', async (req, res) => {
  await setOwnedOid(connectionIdOf(res), checkOid(req.params.oid), false);
  res.status(204).end();
});

mutateRouter.get('/meta/collections', async (_req, res) => {
  res.json(await listCollectionMeta(connectionIdOf(res)));
});

// 메타데이터 연산이라 Safety(read-only·보호 대상)에 막히지 않는다 — 선언 연산과 같은 규칙(shared/safety)
mutateRouter.post('/meta/collections', async (req, res) => {
  const body = req.body as { collections?: unknown } | undefined;
  if (!body || typeof body !== 'object' || !body.collections || typeof body.collections !== 'object') {
    throw new HttpError(400, 'collections가 필요합니다');
  }
  const entries = normalizeCollectionMetadata(body.collections);
  const conn = await connOf(res);
  // DB마다 컬렉션 목록을 한 번씩 받아, 지금 연결에 있는 컬렉션에만 적용한다
  const namesByDb = new Map<string, Set<string>>();
  const applied: CollectionMetadata = {};
  const skipped: string[] = [];
  for (const [key, meta] of Object.entries(entries)) {
    const [database, collection] = splitCollectionKey(key) ?? ['', ''];
    let names = namesByDb.get(database);
    if (!names) {
      names = new Set();
      try {
        const list = await conn.client.db(checkDatabaseName(database)).listCollections({}, { nameOnly: true }).toArray();
        for (const c of list) if (!isHiddenCollection(c.name)) names.add(c.name);
      } catch (e) {
        // 이름이 틀렸거나 숨긴 DB면 그 DB 것은 전부 건너뛴다
        if (!(e instanceof HttpError)) throw e;
      }
      namesByDb.set(database, names);
    }
    if (names.has(collection)) applied[key] = meta;
    else skipped.push(key);
  }
  if (Object.keys(applied).length > 0) await importCollectionMeta(conn.id, applied);
  const result: MetadataImportResult = { applied: Object.keys(applied), skipped };
  res.json(result);
});
