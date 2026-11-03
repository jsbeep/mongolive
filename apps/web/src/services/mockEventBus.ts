// path: src/services/mockEventBus.ts
import type { ChangeResponse, Document, MockDatabaseRecord, MockSnapshot } from '../types/explorer';
import { cloneDocument } from './mockClone';
import { collectionKey } from './mockQuery';

type ChangeListener = (change: ChangeResponse) => void;

// 모듈 싱글턴이어야 한다 — subscribeToChanges로 등록한 구독자와 emitChange가
// 같은 Map 인스턴스를 봐야 알림이 전달된다. 이 파일을 두 번 다른 경로로
// import하게 만들면(예: 별칭 경로 추가) 구독이 조용히 끊어지니 주의.
const listeners = new Map<string, Set<ChangeListener>>();

// 구독 키는 항상 `database.collection` 한 가지다. 예전엔 컬렉션 이름만으로도 알림을
// 뿌렸는데, 그러면 DB가 둘 이상일 때 다른 DB의 동명 컬렉션(users 등) 변경까지 받아버린다.
// 실제 MongoDB ChangeStream도 DB/컬렉션을 특정해서 여는 것이라 이쪽이 맞다.
export const emitChange = (databaseName: string, collectionName: string, change: ChangeResponse): void => {
  const registered = listeners.get(collectionKey(databaseName, collectionName));
  if (!registered) {
    return;
  }

  for (const listener of [...registered]) {
    try {
      listener(change);
    } catch {
      // Subscriber errors should not break the mock bus.
    }
  }
};

export const emitCollectionReplace = (databaseName: string, collectionName: string, documents: Document[]): void => {
  emitChange(databaseName, collectionName, {
    type: 'replace',
    database: databaseName,
    collection: collectionName,
    data: documents.map((document) => cloneDocument(document)),
    tracePath: [databaseName, collectionName],
  });
};

export const emitDatabaseSnapshot = (snapshot: MockSnapshot): void => {
  for (const [databaseName, database] of Object.entries(snapshot.databases)) {
    for (const [collectionName, collection] of Object.entries(database.collections)) {
      emitCollectionReplace(databaseName, collectionName, collection.documents);
    }
  }
};

export const emitDatabaseCollections = (databaseName: string, database: MockDatabaseRecord): void => {
  for (const [collectionName, collection] of Object.entries(database.collections)) {
    emitCollectionReplace(databaseName, collectionName, collection.documents);
  }
};

// collectionId는 반드시 collectionKey(database, collection) 형식이어야 한다 —
// 컬렉션 이름만 넘기면 emitChange가 찾는 키와 달라 알림이 오지 않는다.
export const subscribeToChanges = (collectionId: string, callback: (change: ChangeResponse) => void): (() => void) => {
  const currentListeners = listeners.get(collectionId) ?? new Set<ChangeListener>();
  currentListeners.add(callback);
  listeners.set(collectionId, currentListeners);

  return () => {
    const registered = listeners.get(collectionId);
    if (!registered) {
      return;
    }

    registered.delete(callback);
    if (registered.size === 0) {
      listeners.delete(collectionId);
    }
  };
};
