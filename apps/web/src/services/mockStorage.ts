// path: src/services/mockStorage.ts
import {
  isPlainObject,
  type Document,
  type MockCollectionRecord,
  type MockDatabaseRecord,
  type MockSnapshot,
} from '../types/explorer';
import { createEmptyWorkspaceSnapshot } from '../data/sampleData';
import { canonicalDocument, cloneDocument } from './mockClone';

const STORAGE_KEY = 'mongolive_snapshot';
const SNAPSHOT_VERSION = 1;

const cloneCollection = (collection: MockCollectionRecord): MockCollectionRecord => ({
  ...collection,
  documents: collection.documents.map((document) => cloneDocument(document)),
});

const cloneDatabase = (database: MockDatabaseRecord): MockDatabaseRecord => {
  const collections: Record<string, MockCollectionRecord> = {};
  for (const [name, collection] of Object.entries(database.collections)) {
    collections[name] = cloneCollection(collection);
  }

  return {
    ...database,
    collections,
  };
};

const cloneSnapshot = (snapshot: MockSnapshot): MockSnapshot => {
  const databases: Record<string, MockDatabaseRecord> = {};
  for (const [name, database] of Object.entries(snapshot.databases)) {
    databases[name] = cloneDatabase(database);
  }

  return {
    version: snapshot.version,
    activeDatabase: snapshot.activeDatabase,
    databases,
    updatedAt: snapshot.updatedAt,
  };
};

// 깨진 항목은 던지지 않고 그냥 걸러낸다(titleKey처럼 관대하게) — 스냅샷 전체를
// invalid 처리해서 시드로 되돌리면 사용자 데이터가 통째로 날아간다
const normalizeReferenceFields = (raw: unknown): Record<string, { targetCollection: string; targetKey: string }> | undefined => {
  if (!isPlainObject(raw)) return undefined;
  const result: Record<string, { targetCollection: string; targetKey: string }> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (isPlainObject(value) && typeof value.targetCollection === 'string' && typeof value.targetKey === 'string') {
      result[field] = { targetCollection: value.targetCollection, targetKey: value.targetKey };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

// 검증과 동시에 문서까지 깊은 복제한 '소유 그래프'를 반환한다 — 반환값은 입력과
// 어떤 참조도 공유하지 않으므로 호출부에서 추가 복제가 필요 없다.
const validateSnapshot = (candidate: unknown): MockSnapshot => {
  if (!isPlainObject(candidate)) {
    throw new Error('Invalid snapshot');
  }

  const { version, activeDatabase, databases, updatedAt } = candidate;
  if (version !== SNAPSHOT_VERSION || typeof activeDatabase !== 'string' || !isPlainObject(databases) || typeof updatedAt !== 'number') {
    throw new Error('Invalid snapshot');
  }

  const normalizedDatabases: Record<string, MockDatabaseRecord> = {};
  for (const [databaseName, databaseValue] of Object.entries(databases)) {
    if (!isPlainObject(databaseValue)) {
      throw new Error('Invalid snapshot');
    }

    const { name, label, description, collections: rawCollections, updatedAt: databaseUpdatedAt } = databaseValue;
    if (
      typeof name !== 'string' ||
      typeof label !== 'string' ||
      typeof description !== 'string' ||
      !isPlainObject(rawCollections) ||
      typeof databaseUpdatedAt !== 'number'
    ) {
      throw new Error('Invalid snapshot');
    }

    const normalizedCollections: Record<string, MockCollectionRecord> = {};
    for (const [collectionName, collectionValue] of Object.entries(rawCollections)) {
      if (!isPlainObject(collectionValue)) {
        throw new Error('Invalid snapshot');
      }

      const { name: collectionLabelName, label: collectionLabel, description: collectionDescription, documents, updatedAt: collectionUpdatedAt, titleKey, primaryKey, referenceFields } = collectionValue;
      if (
        typeof collectionLabelName !== 'string' ||
        typeof collectionLabel !== 'string' ||
        typeof collectionDescription !== 'string' ||
        !Array.isArray(documents) ||
        typeof collectionUpdatedAt !== 'number'
      ) {
        throw new Error('Invalid snapshot');
      }

      const normalizedDocuments = documents.map((document): Document => {
        if (!isPlainObject(document)) {
          throw new Error('Invalid snapshot');
        }
        // Canonical 정규화 + 깊은 복제를 한 번에 — 입력과 참조를 공유하지 않는 소유 그래프가
        // 나온다. 이미 canonical이면 모양은 그대로(멱등)이고, 예전 relaxed로 저장된
        // localStorage 스냅샷은 여기서 자동으로 canonical로 이전된다.
        return canonicalDocument(document);
      });

      normalizedCollections[collectionName] = {
        name: collectionLabelName,
        label: collectionLabel,
        description: collectionDescription,
        documents: normalizedDocuments,
        updatedAt: collectionUpdatedAt,
        titleKey: typeof titleKey === 'string' ? titleKey : undefined,
        primaryKey: typeof primaryKey === 'string' ? primaryKey : undefined,
        referenceFields: normalizeReferenceFields(referenceFields),
      };
    }

    normalizedDatabases[databaseName] = {
      name,
      label,
      description,
      collections: normalizedCollections,
      updatedAt: databaseUpdatedAt,
    };
  }

  if (!(activeDatabase in normalizedDatabases)) {
    throw new Error('Invalid snapshot');
  }

  return {
    version: SNAPSHOT_VERSION,
    activeDatabase,
    databases: normalizedDatabases,
    updatedAt,
  };
};

const readStorage = (): Storage | undefined => {
  if (typeof globalThis === 'undefined') {
    return undefined;
  }

  const candidate = globalThis.localStorage;
  return candidate ?? undefined;
};

// 로컬스토리지 한도를 넘겨 저장에 실패했을 때 던진다 — 호출부에서 사용자에게 안내한다
export class StorageQuotaExceededError extends Error {
  constructor(message = 'Local storage is full. Delete unused databases and try again.') {
    super(message);
    this.name = 'StorageQuotaExceededError';
  }
}

// 브라우저마다 코드/이름이 달라서 둘 다 본다 (Firefox: NS_ERROR_DOM_QUOTA_REACHED / code 1014)
const isQuotaExceeded = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = (error as DOMException).code;
  return (
    error.name === 'QuotaExceededError' ||
    error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
};

const writeSnapshot = (snapshot: MockSnapshot): void => {
  const storage = readStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    if (isQuotaExceeded(error)) {
      throw new StorageQuotaExceededError();
    }
    throw error;
  }
};

const loadInitialSnapshot = (): MockSnapshot => {
  const storage = readStorage();
  if (storage) {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        return validateSnapshot(JSON.parse(raw) as unknown);
      } catch {
        const seed = createEmptyWorkspaceSnapshot();
        // 초기화 시점의 쓰기 실패로 앱이 죽지는 않게 한다 — 메모리 스냅샷으로 계속 진행
        try {
          writeSnapshot(seed);
        } catch {
          /* ignore */
        }
        return seed;
      }
    }
  }

  const seed = createEmptyWorkspaceSnapshot();
  try {
    writeSnapshot(seed);
  } catch {
    /* ignore */
  }
  return seed;
};

let currentSnapshot = cloneSnapshot(loadInitialSnapshot());

export const getSnapshot = (): MockSnapshot => cloneSnapshot(currentSnapshot);

// 쓰기가 실패하면 메모리 스냅샷도 갱신하지 않는다 — 화면에는 저장된 것처럼 보이는데
// 새로고침하면 사라지는 상태를 막기 위해 저장 성공 후에만 커밋한다
export const setSnapshot = (snapshot: MockSnapshot): void => {
  // validateSnapshot이 이미 문서까지 복제한 소유 그래프를 돌려주므로 추가 cloneSnapshot이
  // 필요 없다 — currentSnapshot이 호출부 객체와 참조를 공유하지 않는다는 보장은 그대로다.
  const nextSnapshot = validateSnapshot(snapshot);
  writeSnapshot(nextSnapshot);
  currentSnapshot = nextSnapshot;
};

// ── '고유 oid' 레지스트리 ─────────────────────────────────────────────────────
// 새로고침 후에도 ObjectID 필드의 owned/REF 분류가 유지되도록 localStorage에 별도 저장

const UNIQUE_OIDS_KEY = 'mongolive_unique_oids';

export const getUniqueOids = (): string[] => {
  const storage = readStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(UNIQUE_OIDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

export const setUniqueOids = (oids: string[]): void => {
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.setItem(UNIQUE_OIDS_KEY, JSON.stringify(oids));
  } catch {
    // oid 레지스트리는 분류 힌트일 뿐이라 저장 실패해도 진행한다(용량 초과는 스냅샷 쪽에서 알린다)
  }
};
