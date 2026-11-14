// 앱 메타데이터 저장소 — PK/FK 선언, titleKey, 내가 만든 oid 목록. 연결마다 따로 둔다(같은 DB 이름이 다른 클러스터에도 있으므로).
// 사용자의 MongoDB에는 아무 흔적도 남기지 않는다는 원칙에 따라 서버 컴퓨터의 JSON 파일 하나에 둔다.
//   경로: config.metaFile (기본 ~/.mongolive/meta.json)
//   형식 v2: { version: 2, connections: { <연결 id>: { collections, ownedOids } } }
//   예전 형식(v1, 연결 구분 없음)은 읽을 때 .env 연결(ENV_CONNECTION_ID)의 것으로 옮긴다 — 다음에 쓸 때 v2로 저장된다.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { collectionKey, ENV_CONNECTION_ID, type ReferenceFieldConfig } from '@mongolive/shared';
import { config } from './config';

export interface CollectionMeta {
  titleKey?: string;
  primaryKey?: string;
  referenceFields?: Record<string, ReferenceFieldConfig>;
}

export interface ConnectionMeta {
  // 키: "db.collection" (collectionKey)
  collections: Record<string, CollectionMeta>;
  ownedOids: string[];
}

export interface MetaFile {
  version: 2;
  connections: Record<string, ConnectionMeta>;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const readConnectionMeta = (raw: Record<string, unknown>): ConnectionMeta => ({
  collections: isObject(raw.collections) ? (raw.collections as Record<string, CollectionMeta>) : {},
  ownedOids: Array.isArray(raw.ownedOids) ? raw.ownedOids.filter((x): x is string => typeof x === 'string') : [],
});

const isEmpty = (meta: ConnectionMeta) => Object.keys(meta.collections).length === 0 && meta.ownedOids.length === 0;

// 파일 내용(JSON.parse 결과) → v2. migrated = 예전 형식이었나(옮겼다고 한 번 알린다)
export const normalizeMetaFile = (raw: unknown): { data: MetaFile; migrated: boolean } => {
  const obj = isObject(raw) ? raw : {};
  if (obj.version === 2) {
    const connections: Record<string, ConnectionMeta> = {};
    for (const [id, value] of Object.entries(isObject(obj.connections) ? obj.connections : {})) {
      if (isObject(value)) connections[id] = readConnectionMeta(value);
    }
    return { data: { version: 2, connections }, migrated: false };
  }
  // v1(또는 version 없음) — 전부 .env 연결의 것
  const legacy = readConnectionMeta(obj);
  return { data: { version: 2, connections: isEmpty(legacy) ? {} : { [ENV_CONNECTION_ID]: legacy } }, migrated: !isEmpty(legacy) };
};

let cache: MetaFile | null = null;
// 저장 요청을 한 줄로 세운다 — 동시에 두 번 쓰면 나중 것이 앞의 변경을 덮어쓸 수 있으므로
let writeQueue: Promise<void> = Promise.resolve();

const load = async (): Promise<MetaFile> => {
  if (cache) return cache;
  try {
    const { data, migrated } = normalizeMetaFile(JSON.parse(await readFile(config.metaFile, 'utf8')));
    if (migrated) console.log('[meta] 예전 meta.json을 .env 연결의 메타데이터로 옮깁니다(다음 저장 때 새 형식으로 씀)');
    cache = data;
  } catch (e) {
    // 파일이 아직 없으면 빈 상태로 시작. 그 외(깨진 JSON 등)는 덮어쓰지 않도록 에러를 낸다.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    cache = { version: 2, connections: {} };
  }
  return cache;
};

// 임시 파일에 다 쓴 뒤 이름을 바꿔 교체 — 쓰는 도중 꺼져도 원래 파일은 온전하다
const persist = (data: MetaFile): Promise<void> => {
  // 빈 연결은 지워서 파일을 깔끔하게
  for (const [id, meta] of Object.entries(data.connections)) if (isEmpty(meta)) delete data.connections[id];
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(config.metaFile), { recursive: true });
    const tmp = `${config.metaFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmp, config.metaFile);
  });
  return writeQueue;
};

// 읽기용 — 없으면 빈 값(파일에 만들지 않는다)
const peek = async (connectionId: string): Promise<ConnectionMeta> =>
  (await load()).connections[connectionId] ?? { collections: {}, ownedOids: [] };

// 쓰기용 — 없으면 만들어 붙인다(빈 채로 남으면 persist가 지운다)
const slot = async (connectionId: string): Promise<{ data: MetaFile; meta: ConnectionMeta }> => {
  const data = await load();
  data.connections[connectionId] ??= { collections: {}, ownedOids: [] };
  return { data, meta: data.connections[connectionId] };
};

// 빈 값(undefined, 빈 객체)은 지워서 파일을 깔끔하게 유지
const compact = (meta: CollectionMeta): CollectionMeta | undefined => {
  const out: CollectionMeta = {};
  if (meta.titleKey) out.titleKey = meta.titleKey;
  if (meta.primaryKey) out.primaryKey = meta.primaryKey;
  if (meta.referenceFields && Object.keys(meta.referenceFields).length > 0) out.referenceFields = meta.referenceFields;
  return Object.keys(out).length > 0 ? out : undefined;
};

export const getCollectionMeta = async (connectionId: string, database: string, collection: string): Promise<CollectionMeta> =>
  (await peek(connectionId)).collections[collectionKey(database, collection)] ?? {};

export const updateCollectionMeta = async (
  connectionId: string,
  database: string,
  collection: string,
  update: (current: CollectionMeta) => CollectionMeta,
): Promise<void> => {
  const { data, meta } = await slot(connectionId);
  const key = collectionKey(database, collection);
  const next = compact(update({ ...meta.collections[key] }));
  if (next) meta.collections[key] = next;
  else delete meta.collections[key];
  await persist(data);
};

export const listOwnedOids = async (connectionId: string): Promise<string[]> => [...(await peek(connectionId)).ownedOids];

export const setOwnedOid = async (connectionId: string, oid: string, owned: boolean): Promise<void> => {
  const { data, meta } = await slot(connectionId);
  const set = new Set(meta.ownedOids);
  if (owned) set.add(oid);
  else set.delete(oid);
  meta.ownedOids = [...set];
  await persist(data);
};

// 연결을 지우면 그 연결의 메타데이터도 — 연결 id는 다시 쓰지 않으므로 남겨 둘 이유가 없다
export const dropConnectionMeta = async (connectionId: string): Promise<void> => {
  const data = await load();
  if (!data.connections[connectionId]) return;
  delete data.connections[connectionId];
  await persist(data);
};

// ── 컬렉션/DB 구조가 바뀔 때 메타도 따라가게 (6-2) ──

// 이름 변경: 옛 키의 메타를 새 키로 옮긴다
export const moveCollectionMeta = async (connectionId: string, database: string, from: string, to: string): Promise<void> => {
  const { data, meta } = await slot(connectionId);
  const fromKey = collectionKey(database, from);
  const moved = meta.collections[fromKey];
  if (!moved) return;
  delete meta.collections[fromKey];
  meta.collections[collectionKey(database, to)] = moved;
  await persist(data);
};

// 복제: 같은 선언을 새 컬렉션에도
export const copyCollectionMeta = async (connectionId: string, database: string, from: string, to: string): Promise<void> => {
  const { data, meta } = await slot(connectionId);
  const source = meta.collections[collectionKey(database, from)];
  if (!source) return;
  meta.collections[collectionKey(database, to)] = structuredClone(source);
  await persist(data);
};

// 삭제: collection을 빼면 그 DB의 모든 컬렉션 메타를 지운다(DB 삭제)
export const deleteCollectionMeta = async (connectionId: string, database: string, collection?: string): Promise<void> => {
  const { data, meta } = await slot(connectionId);
  const prefix = collectionKey(database, '');
  for (const key of Object.keys(meta.collections)) {
    if (collection === undefined ? key.startsWith(prefix) : key === collectionKey(database, collection)) delete meta.collections[key];
  }
  await persist(data);
};
