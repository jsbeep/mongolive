// 앱 메타데이터 저장소 — PK/FK 선언, titleKey, 내가 만든 oid 목록.
// 사용자의 MongoDB에는 아무 흔적도 남기지 않는다는 원칙에 따라 서버 컴퓨터의 JSON 파일 하나에 둔다.
//   경로: config.metaFile (기본 ~/.mongolive/meta.json)
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { collectionKey, type ReferenceFieldConfig } from '@mongolive/shared';
import { config } from './config';

export interface CollectionMeta {
  titleKey?: string;
  primaryKey?: string;
  referenceFields?: Record<string, ReferenceFieldConfig>;
}

interface MetaFile {
  version: 1;
  // 키: "db.collection" (collectionKey)
  collections: Record<string, CollectionMeta>;
  ownedOids: string[];
}

const empty = (): MetaFile => ({ version: 1, collections: {}, ownedOids: [] });

let cache: MetaFile | null = null;
// 저장 요청을 한 줄로 세운다 — 동시에 두 번 쓰면 나중 것이 앞의 변경을 덮어쓸 수 있으므로
let writeQueue: Promise<void> = Promise.resolve();

const load = async (): Promise<MetaFile> => {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(config.metaFile, 'utf8')) as Partial<MetaFile>;
    cache = {
      version: 1,
      collections: parsed.collections && typeof parsed.collections === 'object' ? parsed.collections : {},
      ownedOids: Array.isArray(parsed.ownedOids) ? parsed.ownedOids.filter((x) => typeof x === 'string') : [],
    };
  } catch (e) {
    // 파일이 아직 없으면 빈 상태로 시작. 그 외(깨진 JSON 등)는 덮어쓰지 않도록 에러를 낸다.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    cache = empty();
  }
  return cache;
};

// 임시 파일에 다 쓴 뒤 이름을 바꿔 교체 — 쓰는 도중 꺼져도 원래 파일은 온전하다
const persist = (data: MetaFile): Promise<void> => {
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(config.metaFile), { recursive: true });
    const tmp = `${config.metaFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmp, config.metaFile);
  });
  return writeQueue;
};

// 빈 값(undefined, 빈 객체)은 지워서 파일을 깔끔하게 유지
const compact = (meta: CollectionMeta): CollectionMeta | undefined => {
  const out: CollectionMeta = {};
  if (meta.titleKey) out.titleKey = meta.titleKey;
  if (meta.primaryKey) out.primaryKey = meta.primaryKey;
  if (meta.referenceFields && Object.keys(meta.referenceFields).length > 0) out.referenceFields = meta.referenceFields;
  return Object.keys(out).length > 0 ? out : undefined;
};

export const getCollectionMeta = async (database: string, collection: string): Promise<CollectionMeta> =>
  (await load()).collections[collectionKey(database, collection)] ?? {};

export const updateCollectionMeta = async (
  database: string,
  collection: string,
  update: (current: CollectionMeta) => CollectionMeta,
): Promise<void> => {
  const data = await load();
  const key = collectionKey(database, collection);
  const next = compact(update({ ...data.collections[key] }));
  if (next) data.collections[key] = next;
  else delete data.collections[key];
  await persist(data);
};

export const listOwnedOids = async (): Promise<string[]> => [...(await load()).ownedOids];

export const setOwnedOid = async (oid: string, owned: boolean): Promise<void> => {
  const data = await load();
  const set = new Set(data.ownedOids);
  if (owned) set.add(oid);
  else set.delete(oid);
  data.ownedOids = [...set];
  await persist(data);
};

// ── 컬렉션/DB 구조가 바뀔 때 메타도 따라가게 (6-2) ──

// 이름 변경: 옛 키의 메타를 새 키로 옮긴다
export const moveCollectionMeta = async (database: string, from: string, to: string): Promise<void> => {
  const data = await load();
  const fromKey = collectionKey(database, from);
  const meta = data.collections[fromKey];
  if (!meta) return;
  delete data.collections[fromKey];
  data.collections[collectionKey(database, to)] = meta;
  await persist(data);
};

// 복제: 같은 선언을 새 컬렉션에도
export const copyCollectionMeta = async (database: string, from: string, to: string): Promise<void> => {
  const data = await load();
  const meta = data.collections[collectionKey(database, from)];
  if (!meta) return;
  data.collections[collectionKey(database, to)] = structuredClone(meta);
  await persist(data);
};

// 삭제: collection을 빼면 그 DB의 모든 컬렉션 메타를 지운다(DB 삭제)
export const deleteCollectionMeta = async (database: string, collection?: string): Promise<void> => {
  const data = await load();
  const prefix = collectionKey(database, '');
  for (const key of Object.keys(data.collections)) {
    if (collection === undefined ? key.startsWith(prefix) : key === collectionKey(database, collection)) delete data.collections[key];
  }
  await persist(data);
};
