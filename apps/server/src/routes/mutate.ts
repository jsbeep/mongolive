// 변경 API — 웹의 api.mutate(MutationRequest)가 그대로 POST된다.
//   POST /api/mutate                    { type: ..., ... }
//   GET    /api/meta/owned-oids
//   PUT    /api/meta/owned-oids/:oid    (내가 만든 oid로 표시)
//   DELETE /api/meta/owned-oids/:oid
// 메타데이터 연산(titleKey/PK/FK)은 meta.json에만 쓰고 MongoDB는 건드리지 않는다.
// 문서 쓰기는 writes/documents.ts(6-1), 컬렉션/DB 쓰기는 writes/structure.ts(6-2).
import { Router } from 'express';
import { collectionKey, type MutationRequest, type MutationResult } from '@mongolive/shared';
import { getClient } from '../db';
import { listOwnedOids, setOwnedOid, updateCollectionMeta } from '../meta';
import { checkCollectionName, checkDatabaseName, HttpError } from '../names';
import { DOCUMENT_OPS, runDocumentOp } from '../writes/documents';
import { runStructureOp, STRUCTURE_OPS } from '../writes/structure';

export const mutateRouter = Router();

const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new HttpError(400, `${field}는 문자열이어야 합니다`);
  return value;
};

const optionalStr = (value: unknown, field: string): string | undefined =>
  value === undefined || value === null ? undefined : str(value, field);

// 존재하지 않는 컬렉션에 메타를 쌓지 않도록 확인 (Mock의 'Collection not found'와 같은 동작)
const requireCollection = async (database: string, collection: string): Promise<void> => {
  const db = (await getClient()).db(checkDatabaseName(database));
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

  if (typeof op.type === 'string' && DOCUMENT_OPS.has(op.type)) {
    res.json(await runDocumentOp(op as Parameters<typeof runDocumentOp>[0]));
    return;
  }
  if (typeof op.type === 'string' && STRUCTURE_OPS.has(op.type)) {
    res.json(await runStructureOp(op as Parameters<typeof runStructureOp>[0]));
    return;
  }

  switch (op.type) {
    case 'setCollectionTitleKey': {
      const database = str(op.database, 'database');
      const collection = str(op.collection, 'collection');
      const titleKey = str(op.titleKey, 'titleKey').trim();
      await requireCollection(database, collection);
      await updateCollectionMeta(database, collection, (m) => ({ ...m, titleKey: titleKey || undefined }));
      res.json(collectionResult(database, collection));
      return;
    }
    case 'setCollectionPrimaryKey': {
      const database = str(op.database, 'database');
      const collection = str(op.collection, 'collection');
      const primaryKey = str(op.primaryKey, 'primaryKey').trim();
      await requireCollection(database, collection);
      await updateCollectionMeta(database, collection, (m) => ({ ...m, primaryKey: primaryKey || undefined }));
      res.json(collectionResult(database, collection));
      return;
    }
    case 'setCollectionReferenceField': {
      const database = str(op.database, 'database');
      const collection = str(op.collection, 'collection');
      const field = str(op.field, 'field');
      const targetCollection = optionalStr(op.targetCollection, 'targetCollection');
      const targetKey = optionalStr(op.targetKey, 'targetKey');
      await requireCollection(database, collection);
      await updateCollectionMeta(database, collection, (m) => {
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
  res.json(await listOwnedOids());
});

mutateRouter.put('/meta/owned-oids/:oid', async (req, res) => {
  await setOwnedOid(checkOid(req.params.oid), true);
  res.status(204).end();
});

mutateRouter.delete('/meta/owned-oids/:oid', async (req, res) => {
  await setOwnedOid(checkOid(req.params.oid), false);
  res.status(204).end();
});
