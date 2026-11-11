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
  Diagnostics,
  ServerSettings,
  AggregateResult,
  AggregateCounts,
} from '../types/explorer';
import { mutationTarget } from '../types/explorer';
import { fetchAuthStatus, notifySessionExpired } from './auth';
import { getPreferences } from './preferences';
import type { ClientMetrics, DataSource } from './dataSource';

const BASE = '/api';

// 서버 에러 응답은 { error: "..." } — 메시지를 그대로 Error로 올려 토스트에 보이게 한다
const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  if (!response.ok) {
    // 출입증이 무효(만료, 다른 곳에서 비밀번호 변경) — 로그인 화면으로
    if (response.status === 401) notifySessionExpired();
    let message = `${response.status} ${response.statusText}`;
    let body: Record<string, unknown> | undefined;
    try {
      body = (await response.json()) as Record<string, unknown>;
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // 본문이 JSON이 아니면 상태 코드만
    }
    // body: 409 충돌이면 { conflict: ConflictInfo } — useExplorerState가 충돌 창을 띄운다
    throw Object.assign(new Error(message), { status: response.status, body });
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
    const now = Date.now();
    const cached = oidCache.get(oid);
    if (cached && now - cached.at < OID_CACHE_MS) return cached.promise;
    // 시간이 지난 것은 지운다 — 안 지우면 변경 알림이 없는 동안 열어 본 참조 문서가 계속 쌓인다
    for (const [key, entry] of oidCache) if (now - entry.at >= OID_CACHE_MS) oidCache.delete(key);
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
  const settingsListeners = new Set<(settings: ServerSettings) => void>();
  const emitStatus = (status: LiveStatus) => statusListeners.forEach((listener) => listener(status));
  const logListeners = new Set<(entries: LiveLogEntry[], isBacklog: boolean) => void>();

  // ── 내 저장의 메아리 알아보기 ──
  // 내가 저장하면 서버 changeStream이 같은 변경을 알림으로 다시 보낸다(메아리). 저장 응답의 opTime과
  // 알림의 opTime(둘 다 MongoDB가 그 쓰기에 찍은 시각 도장)이 같으면 내 변경이다 → own: true.
  // 알림이 응답보다 먼저 올 수도 있으므로, 저장 요청이 진행 중인 동안 온 알림은 잠깐 모아 두었다가
  // 응답을 받은 뒤에 판단해서 넘긴다(보통 수십 ms).
  const OWN_TTL_MS = 60_000;
  const ownOpTimes = new Map<string, number>();
  let writesInFlight = 0;
  const held: (() => void)[] = [];
  const isOwn = (opTime: string) => opTime !== '' && ownOpTimes.has(opTime);
  const deliver = (run: () => void) => {
    if (writesInFlight > 0) held.push(run);
    else run();
  };
  const rememberOwn = (opTime: string | undefined) => {
    const now = Date.now();
    for (const [key, at] of ownOpTimes) if (now - at > OWN_TTL_MS) ownOpTimes.delete(key);
    if (opTime) ownOpTimes.set(opTime, now);
  };

  // 되돌리기: 직전 쓰기 한 번의 반대 연산(서버가 응답에 실어 준다). 컬렉션/DB 연산이면 없음.
  // 반대 연산엔 '쓴 직후 값' 확인이 들어 있어서, 그 사이 누가 또 바꿨으면 서버가 409로 거절한다.
  // 여러 단계: 마지막 것이 끝. 개수는 설정 창 › Safety(이 브라우저). 다시 실행하기(redo)는 없다
  let undoStack: MutationRequest[] = [];

  const sendMutation = async (op: MutationRequest): Promise<MutationResult> => {
    writesInFlight += 1;
    try {
      const result = await request<MutationResult>('/mutate', { method: 'POST', body: JSON.stringify(op) });
      rememberOwn(result.opTime);
      // 쓰기 후엔 oid 위치/내용이 바뀌었을 수 있다
      oidCache.clear();
      return result;
    } finally {
      writesInFlight -= 1;
      // 모아 둔 알림을 이제 판단해서 넘긴다(실패했으면 전부 남의 변경)
      if (writesInFlight === 0) held.splice(0).forEach((run) => run());
    }
  };

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
    next.on('disconnect', (reason) => {
      emitStatus({ state: 'connecting' });
      // 서버가 끊은 경우 socket.io는 다시 붙지 않는다. 서버는 출입증이 무효가 된 연결을 끊으므로 확인해 본다.
      if (reason === 'io server disconnect') {
        void fetchAuthStatus()
          .then((status) => (status.authenticated ? next.connect() : notifySessionExpired()))
          .catch(() => undefined);
      }
    });
    next.on('connect_error', (e: Error) => emitStatus({ state: 'error', error: e.message }));
    next.on('status', (status: LiveStatus) => emitStatus(status));
    // 설정 창 › Safety가 바뀌면(이 탭이든 다른 기기든) 서버가 모두에게 알린다
    next.on('settings', (settings: ServerSettings) => settingsListeners.forEach((listener) => listener(settings)));
    next.on('change', (change: LiveChange) => {
      // 어딘가 바뀌었으니 oid 위치 캐시는 믿을 수 없다
      oidCache.clear();
      deliver(() => {
        const marked = { ...change, own: isOwn(change.opTime) };
        changeListeners.forEach((listener) => listener(marked));
      });
    });
    next.on('log:backlog', (entries: LiveLogEntry[]) => {
      const marked = entries.map((e) => ({ ...e, own: isOwn(e.opTime) }));
      logListeners.forEach((listener) => listener(marked, true));
    });
    next.on('log', (entry: LiveLogEntry) =>
      deliver(() => {
        const marked = { ...entry, own: isOwn(entry.opTime) };
        logListeners.forEach((listener) => listener([marked], false));
      }),
    );
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
      // 사용자 쿼리가 있으면 POST 본문으로(주소 길이 제한·접속 기록), 없으면 지금처럼 GET
      if (query.mongoFilter) {
        return request<DocumentPage>(`${collectionPath(database, collection)}/documents`, { method: 'POST', body: JSON.stringify(query) });
      }
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
    aggregate: (database, collection, pipeline) =>
      request<AggregateResult>(`${collectionPath(database, collection)}/aggregate`, { method: 'POST', body: JSON.stringify({ pipeline }) }),
    aggregateCounts: (database, collection, pipeline) =>
      request<AggregateCounts>(`${collectionPath(database, collection)}/aggregate`, { method: 'POST', body: JSON.stringify({ pipeline, counts: true }) }),
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
      let result: MutationResult;
      try {
        result = await sendMutation(op);
      } catch (e) {
        // 충돌(409)·안전장치(403)는 아무것도 안 바뀐 것 — 쌓인 되돌리기는 그대로.
        // 그 밖의 실패는 무엇이 반쯤 바뀌었을지 모르므로 비운다
        const status = (e as { status?: number }).status;
        if (status !== 409 && status !== 403) undoStack = [];
        throw e;
      }
      if (result.undo) {
        undoStack = [...undoStack, result.undo].slice(-getPreferences().undoDepth);
      } else if (mutationTarget(op)) {
        // 되돌릴 수 없는 쓰기(컬렉션·DB 연산)를 지나서 그 전 편집을 되돌리면 헷갈린다 — 여기서 끊는다.
        // 메타데이터 선언(제목 키·PK·FK)은 MongoDB를 안 건드리므로 그대로 둔다
        undoStack = [];
      }
      return result;
    },
    async undoLast() {
      const undo = undoStack[undoStack.length - 1];
      if (!undo) return false;
      // 꺼낸 것은 성공하든 실패하든 버린다(실패 = 그 사이 바뀜 → 더는 되돌릴 수 없다). 그 아래 것들은 남는다
      undoStack = undoStack.slice(0, -1);
      try {
        await sendMutation(undo);
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 409 || status === 404) throw new Error("Changed elsewhere since — can't undo");
        throw e;
      }
      return true;
    },
    canUndo: () => undoStack.length > 0,

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
    getDiagnostics: () => request<Diagnostics>('/diagnostics'),

    getServerSettings: () => request<ServerSettings>('/settings'),
    saveServerSettings: (next) => request<ServerSettings>('/settings', { method: 'PUT', body: JSON.stringify(next) }),
    onServerSettings(listener) {
      ensureSocket();
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
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
