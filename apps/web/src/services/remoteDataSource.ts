// 실제 서버(apps/server)에 붙는 DataSource 구현. 서버는 Canonical EJSON을 주고받으므로 변환 없이 그대로 쓴다.
// 개발 중에는 Vite가 /api 요청을 서버로 넘겨준다(vite.config.ts의 proxy).
import { projectDocument, summarizeDocument } from '@mongolive/shared';
import { io, type Socket } from 'socket.io-client';
import type {
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
  LiveChange,
  LiveLogEntry,
  LiveStatus,
  LiveView,
  MutationRequest,
  MutationResult,
  ReferenceInfo,
  ServerMetrics,
} from '../types/explorer';
import type { ClientMetrics, DataSource } from './dataSource';

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

  // ── 실시간: socket.io 연결은 처음 필요할 때 연다 ──
  let socket: Socket | null = null;
  let view: LiveView = { database: null, collection: null };
  let everConnected = false;
  const changeListeners = new Set<(change: LiveChange) => void>();
  const statusListeners = new Set<(status: LiveStatus) => void>();
  const emitStatus = (status: LiveStatus) => statusListeners.forEach((listener) => listener(status));
  const logListeners = new Set<(entries: LiveLogEntry[], isBacklog: boolean) => void>();

  const ensureSocket = (): Socket => {
    if (socket) return socket;
    // 같은 주소의 /socket.io — 개발 중엔 Vite 프록시가 서버로 넘긴다. 끊기면 socket.io가 알아서 다시 붙는다.
    const next = io({ transports: ['websocket'] });
    next.on('connect', () => {
      // 서버는 소켓마다 채널을 기억하므로 다시 붙으면 지금 보는 범위를 다시 알려야 한다
      next.emit('view', view);
      // 활동 패널이 열려 있었다면 기록 구독도 다시(최근 기록이 다시 오지만 패널이 id로 중복을 거른다)
      if (logListeners.size > 0) next.emit('log:subscribe');
      // 끊겨 있던 동안의 변경은 받지 못했다 → 화면을 새로 받게 한다(첫 연결은 막 불러온 상태라 제외)
      if (everConnected) emitStatus({ state: 'running', resync: true });
      everConnected = true;
    });
    next.on('disconnect', () => emitStatus({ state: 'connecting' }));
    next.on('connect_error', (e: Error) => emitStatus({ state: 'error', error: e.message }));
    next.on('status', (status: LiveStatus) => emitStatus(status));
    next.on('change', (change: LiveChange) => {
      // 어딘가 바뀌었으니 oid 위치 캐시는 믿을 수 없다
      oidCache.clear();
      changeListeners.forEach((listener) => listener(change));
    });
    next.on('log:backlog', (entries: LiveLogEntry[]) => logListeners.forEach((listener) => listener(entries, true)));
    next.on('log', (entry: LiveLogEntry) => logListeners.forEach((listener) => listener([entry], false)));
    socket = next;
    return next;
  };

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

    setLiveView(next: LiveView) {
      view = next;
      const s = ensureSocket();
      if (s.connected) s.emit('view', view);
    },
    onLiveChange(listener) {
      ensureSocket();
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onLiveStatus(listener) {
      ensureSocket();
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },

    onActivityLog(listener) {
      const s = ensureSocket();
      logListeners.add(listener);
      if (logListeners.size === 1 && s.connected) s.emit('log:subscribe');
      return () => {
        logListeners.delete(listener);
        if (logListeners.size === 0 && s.connected) s.emit('log:unsubscribe');
      };
    },
    async getMetrics(): Promise<ClientMetrics> {
      const s = ensureSocket();
      // 왕복 시간: 서버가 받자마자 응답하는 'rtt'를 보내고 응답까지 잰다(2초 안에 없으면 null)
      const rtt = new Promise<number | null>((resolve) => {
        if (!s.connected) return resolve(null);
        const t0 = performance.now();
        s.timeout(2000).emit('rtt', (err: Error | null) => resolve(err ? null : Math.round(performance.now() - t0)));
      });
      const [metrics, rttMs] = await Promise.all([request<ServerMetrics>('/metrics'), rtt]);
      return { ...metrics, rttMs };
    },

    listOwnedOids: () => request<string[]>('/meta/owned-oids'),
    async setOwnedOid(oid, owned) {
      await request<void>(`/meta/owned-oids/${enc(oid)}`, { method: owned ? 'PUT' : 'DELETE' });
    },
  };
};
