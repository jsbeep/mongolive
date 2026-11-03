// 실제 서버(apps/server)에 붙는 DataSource 구현. 서버는 Canonical EJSON을 주고받으므로 변환 없이 그대로 쓴다.
// 개발 중에는 Vite가 /api 요청을 서버로 넘겨준다(vite.config.ts의 proxy).
import { projectDocument, summarizeDocument } from '@mongolive/shared';
import type {
  ChangeResponse,
  CollectionExport,
  CollectionSummary,
  ConnectionConfig,
  ConnectionResult,
  DatabaseSummary,
  Document,
  DocumentPage,
  DocumentQuery,
  FieldReferenceCandidate,
  FieldValueCandidate,
  JsonValue,
  MutationRequest,
  MutationResult,
  ReferenceInfo,
} from '../types/explorer';
import type { DataSource } from './dataSource';

const BASE = '/api';

// 서버 에러 응답은 { error: "..." } — 메시지를 그대로 Error로 올려 토스트에 보이게 한다
const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // 본문이 JSON이 아니면 상태 코드만
    }
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
};

const enc = encodeURIComponent;
const collectionPath = (database: string, collection: string) => `/databases/${enc(database)}/collections/${enc(collection)}`;

// collectionKey(db, col) = "db.col" — DB 이름에는 '.'이 올 수 없으므로 첫 '.'에서 자른다
const splitCollectionId = (collectionId: string): [string, string] => {
  const dot = collectionId.indexOf('.');
  if (dot <= 0) throw new Error(`잘못된 컬렉션 id: ${collectionId}`);
  return [collectionId.slice(0, dot), collectionId.slice(dot + 1)];
};

interface OidLocation {
  database: string;
  collection: string;
  document: Document;
}

export const createRemoteDataSource = (): DataSource => {
  // 참조 하나를 열 때 화면이 같은 oid로 checkReference → getDocumentById → getReferenceInfo →
  // getFullDocumentById를 연달아 부른다. 짧은 시간 동안은 한 번의 서버 조회를 공유한다.
  const OID_CACHE_MS = 3000;
  const oidCache = new Map<string, { at: number; promise: Promise<OidLocation | null> }>();

  const locateOid = (oid: string): Promise<OidLocation | null> => {
    const cached = oidCache.get(oid);
    if (cached && Date.now() - cached.at < OID_CACHE_MS) return cached.promise;
    const promise = request<OidLocation>(`/oid/${enc(oid)}`).catch((e: unknown) => {
      if ((e as { status?: number }).status === 404) return null;
      oidCache.delete(oid);
      throw e;
    });
    oidCache.set(oid, { at: Date.now(), promise });
    return promise;
  };

  const requireOid = async (oid: string): Promise<OidLocation> => {
    const found = await locateOid(oid);
    if (!found) throw new Error('Document not found');
    return found;
  };

  const listDatabases = () => request<DatabaseSummary[]>('/databases');

  return {
    async connect(config: ConnectionConfig): Promise<ConnectionResult> {
      const databases = await listDatabases();
      const activeDatabase =
        config.database && databases.some((d) => d.name === config.database) ? config.database : databases[0]?.name ?? '';
      return { status: 'connected', connectedAt: Date.now(), activeDatabase, databases };
    },
    listDatabases,
    getCollections: (database) => request<CollectionSummary[]>(`/databases/${enc(database)}/collections`),
    getDocuments(collectionId, query: DocumentQuery = {}) {
      const [database, collection] = splitCollectionId(collectionId);
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') params.set(key, String(value));
      }
      const qs = params.toString();
      return request<DocumentPage>(`${collectionPath(database, collection)}/documents${qs ? `?${qs}` : ''}`);
    },

    async getDocumentById(oid, projectionPath) {
      return projectDocument((await requireOid(oid)).document, projectionPath);
    },
    async getFullDocumentById(oid) {
      return (await requireOid(oid)).document;
    },
    getFullDocumentByIdInCollection: (database, collection, documentId) =>
      request<Document>(`${collectionPath(database, collection)}/documents/${enc(documentId)}`),
    exportCollection: (database, collection) => request<CollectionExport>(`${collectionPath(database, collection)}/export`),

    async checkReference(oid) {
      return (await locateOid(oid)) !== null;
    },
    async getReferenceInfo(oid): Promise<ReferenceInfo | null> {
      const found = await locateOid(oid);
      if (!found) return null;
      // Mock과 같이 titleKey 없이 요약한다(name/title → _id 순)
      return {
        databaseName: found.database,
        collectionName: found.collection,
        collectionLabel: found.collection,
        documentTitle: summarizeDocument(found.document, 0).title,
      };
    },
    getReferenceCandidatesByField: (database, collection, key, value: JsonValue) =>
      request<FieldReferenceCandidate[]>(`${collectionPath(database, collection)}/find-by-field`, {
        method: 'POST',
        body: JSON.stringify({ key, value }),
      }),
    getFieldValueCandidates: (database, collection, key) =>
      request<FieldValueCandidate[]>(`${collectionPath(database, collection)}/field-values?key=${enc(key)}`),

    async mutate(op: MutationRequest): Promise<MutationResult> {
      const result = await request<MutationResult>('/mutate', { method: 'POST', body: JSON.stringify(op) });
      // 쓰기 후엔 oid 위치/내용이 바뀌었을 수 있다
      oidCache.clear();
      return result;
    },
    // 서버 쪽 되돌리기는 6단계(쓰기)에서 — 지금은 되돌릴 것이 없다고 답한다
    async undoLast() {
      return false;
    },

    // 실시간 반영은 5단계(changeStream)에서 — 지금은 구독만 받고 아무것도 보내지 않는다
    subscribeToChanges(_collectionId: string, _callback: (change: ChangeResponse) => void) {
      return () => undefined;
    },

    listOwnedOids: () => request<string[]>('/meta/owned-oids'),
    async setOwnedOid(oid, owned) {
      await request<void>(`/meta/owned-oids/${enc(oid)}`, { method: owned ? 'PUT' : 'DELETE' });
    },
  };
};
