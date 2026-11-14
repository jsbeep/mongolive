// 실시간 변경 전달 (5단계, 8-3에서 연결별로)
//
//   연결 A의 MongoDB ──changeStream 1개──▶ 피드 A ──socket.io──▶ 연결 A를 쓰는 탭들
//   연결 B의 MongoDB ──changeStream 1개──▶ 피드 B ──socket.io──▶ 연결 B를 쓰는 탭들
//
// 피드(feed) = 연결 하나의 실시간: changeStream + 활동 기록 + 지표. 그 연결을 쓰는 탭(소켓)이 생기면 열고,
// 마지막 탭이 떠나면 잠시(FEED_GRACE_MS) 뒤 닫는다 — 새로고침 정도로는 끊기지 않게.
//
// 채널(room) — 모두 연결 id(c:<id>)로 시작한다:
//   c:<id>                       그 연결을 쓰는 모든 탭 — 상태, 컬렉션/DB 생성·삭제·이름변경
//   c:<id>:db:<db>               그 DB를 보는 탭 — 다른 컬렉션의 문서 변경은 요약만(문서 수 갱신용)
//   c:<id>:col:<db>.<collection> 그 컬렉션을 보는 탭 — 문서 변경을 자세히(바뀐 경로·값)
//   c:<id>:log                   활동 패널을 연 탭 — 클러스터 전체 변경을 값 없이
//
// 상태: 드라이버 하트비트(db.ts healthOf)가 "닿지 않음"이면 스트림과 상관없이 error.
// 단독(standalone) MongoDB는 changeStream이 안 되므로 열지 않고 그 사실을 알린다(8-6에서 폴링).
//
// 흔적 없음: changeStream은 읽기 전용이다. 변경 전 문서(pre-image)는 DB 옵션을 켜야 해서 쓰지 않는다.
// resume token은 저장하지 않는다 — 잠깐 끊기면 드라이버가 알아서 이어 받고, 스트림을 새로 열어야 할 땐
// 클라이언트에 resync를 보내 화면을 다시 받게 한다.
import type { ChangeStream, ChangeStreamDocument, Document as BsonDocument, ResumeToken } from 'mongodb';
import type { Server, Socket } from 'socket.io';
import {
  idString,
  type EjsonValue,
  type LagStats,
  type LiveChange,
  type LiveLogEntry,
  type LiveOperation,
  type LiveStatus,
  type LiveView,
  type ServerMetrics,
} from '@mongolive/shared';
import { connectionUri, onConnectionsChange } from './connections';
import { clientFor, healthOf, onHealthChange, retainClient } from './db';
import { checkCollectionName, checkDatabaseName, HIDDEN_DATABASES } from './names';
import { toWire } from './wire';

const DOCUMENT_OPS = new Set<LiveOperation>(['insert', 'update', 'replace', 'delete']);
const STRUCTURE_OPS = new Set<LiveOperation>(['create', 'drop', 'rename', 'dropDatabase']);

// DB 이름에는 ':'이 들어갈 수 없고 연결 id는 UUID나 'env'라 채널 이름이 겹치지 않는다
const connRoom = (id: string) => `c:${id}`;
const dbRoom = (id: string, database: string) => `c:${id}:db:${database}`;
const colRoom = (id: string, database: string, collection: string) => `c:${id}:col:${database}.${collection}`;
const logRoom = (id: string) => `c:${id}:log`;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── 이벤트 변환: 드라이버 이벤트 → LiveChange ─────────────────────────────────

const tokenString = (token: ResumeToken): string => {
  const data = (token as { _data?: unknown })._data;
  return typeof data === 'string' ? data : JSON.stringify(token);
};

// 이벤트가 DB에 기록된 시각(ms). wallTime(MongoDB 6+)은 ms 단위, 없으면 clusterTime(초 단위)으로.
const clusterTimeMs = (change: ChangeStreamDocument): number => {
  const wall = (change as { wallTime?: Date }).wallTime;
  if (wall instanceof Date) return wall.getTime();
  const ts = (change as { clusterTime?: { getHighBits?: () => number } }).clusterTime;
  const seconds = ts?.getHighBits?.();
  return typeof seconds === 'number' ? seconds * 1000 : Date.now();
};

// 쓰기 시각 도장(Timestamp) → 문자열. 쓴 쪽 세션의 operationTime과 같은 값이다
const opTimeString = (change: ChangeStreamDocument): string =>
  (change as { clusterTime?: { toString(): string } }).clusterTime?.toString() ?? '';

const toLiveChange = (change: ChangeStreamDocument): LiveChange | null => {
  const op = change.operationType as LiveOperation;
  if (!DOCUMENT_OPS.has(op) && !STRUCTURE_OPS.has(op)) return null; // createIndexes, modify 등은 화면과 무관
  const ns = (change as { ns?: { db?: string; coll?: string } }).ns;
  if (!ns?.db) return null;

  const live: LiveChange = {
    id: tokenString(change._id),
    op,
    database: ns.db,
    collection: ns.coll,
    detailed: true,
    clusterTime: clusterTimeMs(change),
    serverTime: Date.now(),
    opTime: opTimeString(change),
  };

  if ('documentKey' in change && change.documentKey) {
    const key = toWire<{ _id?: EjsonValue }>(change.documentKey);
    live.documentId = idString(key._id);
  }
  if (change.operationType === 'update' && change.updateDescription) {
    const { updatedFields, removedFields, truncatedArrays } = change.updateDescription;
    live.updatedFields = toWire<Record<string, EjsonValue>>(updatedFields ?? {});
    live.removedFields = removedFields ?? [];
    if (truncatedArrays?.length) live.truncatedArrays = truncatedArrays.map((t) => ({ field: t.field, newSize: t.newSize }));
  }
  if (change.operationType === 'rename' && change.to) {
    live.to = { database: change.to.db, collection: change.to.coll };
  }
  return live;
};

// 보고 있지 않은 컬렉션에 보내는 요약본 — 바뀐 값은 빼고 "어디서 무엇이" 바뀌었는지만
const summarize = (change: LiveChange): LiveChange => {
  const { updatedFields: _u, removedFields: _r, truncatedArrays: _t, ...rest } = change;
  return { ...rest, detailed: false };
};

// ── 피드: 연결 하나의 실시간 ─────────────────────────────────────────────────

const LOG_BACKLOG = 200;
const LAG_SAMPLES = 200;
const RATE_WINDOW_SEC = 60;
// 마지막 탭이 떠난 뒤 스트림을 닫기까지
const FEED_GRACE_MS = 60 * 1000;

const UNREACHABLE_ERROR = "Can't reach MongoDB.";
const GONE_ERROR = 'This connection no longer exists — it may have been deleted.';

interface Feed {
  id: string;
  // 연 주소 — 연결의 주소가 바뀌면 처음부터 다시 연다
  uri: string;
  stream: ChangeStream | null;
  // polling = 단독 MongoDB라 스트림을 열지 않음(브라우저가 주기적으로 다시 받는다)
  streamState: 'connecting' | 'running' | 'polling' | 'error';
  streamError?: string;
  retryDelay: number;
  retryTimer: NodeJS.Timeout | null;
  // 마지막으로 받은 위치 — 스트림을 새로 열 때 이어 받기에 쓴다(메모리에만)
  lastToken?: ResumeToken;
  stopped: boolean;
  // 이 연결을 쓰는 소켓 수
  users: number;
  graceTimer: NodeJS.Timeout | null;
  releaseClient: () => void;
  // 마지막으로 알린 상태
  status: LiveStatus;
  // 활동 패널용 기록(메모리에만)
  logBacklog: LiveLogEntry[];
  lagSamples: number[];
  // 초(epoch sec) → 그 1초 동안 받은 이벤트 수
  perSecond: Map<number, number>;
  eventsTotal: number;
}

const feeds = new Map<string, Feed>();

const toLogEntry = (change: LiveChange): LiveLogEntry => ({
  id: change.id,
  op: change.op,
  database: change.database,
  collection: change.collection,
  documentId: change.documentId,
  paths: change.updatedFields ? Object.keys(change.updatedFields) : undefined,
  removed: change.removedFields?.length ? change.removedFields : undefined,
  to: change.to,
  clusterTime: change.clusterTime,
  serverTime: change.serverTime,
  opTime: change.opTime,
});

const record = (feed: Feed, change: LiveChange) => {
  feed.eventsTotal += 1;
  const second = Math.floor(change.serverTime / 1000);
  feed.perSecond.set(second, (feed.perSecond.get(second) ?? 0) + 1);
  for (const key of feed.perSecond.keys()) if (key < second - RATE_WINDOW_SEC) feed.perSecond.delete(key);
  feed.lagSamples.push(Math.max(0, change.serverTime - change.clusterTime));
  if (feed.lagSamples.length > LAG_SAMPLES) feed.lagSamples.shift();
  const entry = toLogEntry(change);
  feed.logBacklog.push(entry);
  if (feed.logBacklog.length > LOG_BACKLOG) feed.logBacklog.shift();
  return entry;
};

const lagStats = (samples: number[]): LagStats | null => {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1], samples: sorted.length };
};

// 지표 탭·진단용. 그 연결의 피드가 없으면(쓰는 탭이 없음) 빈 값
export const realtimeMetrics = (connectionId: string): ServerMetrics['realtime'] => {
  const feed = feeds.get(connectionId);
  const now = Math.floor(Date.now() / 1000);
  const eventsPerSecond = Array.from({ length: RATE_WINDOW_SEC }, (_, i) => feed?.perSecond.get(now - RATE_WINDOW_SEC + 1 + i) ?? 0);
  const { resync: _resync, ...status } = feed?.status ?? { state: 'connecting' as const };
  return { status, eventsTotal: feed?.eventsTotal ?? 0, eventsPerSecond, lag: feed ? lagStats(feed.lagSamples) : null };
};

// 하트비트와 스트림 상태를 합친 '지금 상태'
const computeStatus = (feed: Feed): LiveStatus => {
  if (healthOf(feed.id).reachable === false) return { state: 'error', error: UNREACHABLE_ERROR };
  if (feed.streamState === 'running') return { state: 'running' };
  if (feed.streamState === 'polling') return { state: 'polling' };
  if (feed.streamState === 'error') return { state: 'error', error: feed.streamError };
  return { state: 'connecting' };
};

// ── 스트림 관리 ───────────────────────────────────────────────────────────────

export const startRealtime = (io: Server) => {
  // 상태가 바뀌었을 때만 알린다. resync는 '그 순간' 놓친 게 있다는 신호라 바뀌지 않았어도 보낸다
  const publish = (feed: Feed, resync = false) => {
    const next = computeStatus(feed);
    const changed = next.state !== feed.status.state || next.error !== feed.status.error;
    feed.status = next;
    if (changed || resync) io.to(connRoom(feed.id)).emit('status', resync ? { ...next, resync: true } : next);
  };

  const dispatch = (feed: Feed, change: LiveChange) => {
    io.to(logRoom(feed.id)).emit('log', record(feed, change));
    if (STRUCTURE_OPS.has(change.op) || !change.collection) {
      io.to(connRoom(feed.id)).emit('change', summarize(change));
      return;
    }
    // 이 컬렉션을 보는 클라이언트에겐 자세히, 같은 DB의 나머지에겐 요약만
    // (socket.io는 한 소켓이 두 방에 다 있어도 except로 중복 없이 나눌 수 있다)
    const col = colRoom(feed.id, change.database, change.collection);
    io.to(col).emit('change', change);
    io.to(dbRoom(feed.id, change.database)).except(col).emit('change', summarize(change));
  };

  const closeStream = (feed: Feed) => {
    if (feed.retryTimer) clearTimeout(feed.retryTimer);
    feed.retryTimer = null;
    void feed.stream?.close().catch(() => undefined);
    feed.stream = null;
  };

  const scheduleReopen = (feed: Feed) => {
    if (feed.stopped) return;
    const delay = feed.retryDelay;
    feed.retryDelay = Math.min(feed.retryDelay * 2, 30_000);
    feed.retryTimer = setTimeout(() => {
      feed.retryTimer = null;
      void open(feed);
    }, delay);
  };

  const fail = (feed: Feed, error: string, retry: boolean) => {
    feed.streamState = 'error';
    feed.streamError = error;
    publish(feed);
    if (retry) scheduleReopen(feed);
  };

  const open = async (feed: Feed): Promise<void> => {
    if (feed.stopped) return;
    try {
      const client = await clientFor(feed.id);
      // 기다리는 사이 닫혔거나(탭이 다 떠남) 다른 open이 먼저 열었으면 그만
      if (feed.stopped || feed.stream) return;
      // 단독 MongoDB — 열어 봐야 계속 실패하므로 열지 않는다(주소가 바뀌면 다시 판단).
      // 에러가 아니라 'polling' — 브라우저가 보이는 범위를 주기적으로 다시 받는다(8-6)
      if (healthOf(feed.id).topology === 'standalone') {
        feed.streamState = 'polling';
        feed.streamError = undefined;
        publish(feed);
        return;
      }
      const pipeline: BsonDocument[] = [{ $match: { 'ns.db': { $nin: [...HIDDEN_DATABASES] } } }];
      const next = client.watch(pipeline, {
        // create 같은 구조 이벤트도 받는다(MongoDB 6+)
        showExpandedEvents: true,
        ...(feed.lastToken ? { resumeAfter: feed.lastToken } : {}),
      });
      feed.stream = next;

      // 스트림이 실제로 열렸다는 신호: 서버의 첫 응답에는 항상 위치(postBatchResumeToken)가 실려 오고,
      // 드라이버는 그걸 'resumeTokenChanged'로 알린다('init'은 이 드라이버 버전에서 바깥으로 전달되지 않음).
      // 권한·설정 에러면 이 신호 없이 'error'가 온다.
      const resumed = feed.lastToken !== undefined;
      let opened = false;
      const markOpened = () => {
        if (opened) return;
        opened = true;
        feed.retryDelay = 1000;
        feed.streamState = 'running';
        feed.streamError = undefined;
        // 새로 연 스트림이면(이어 받기가 아니면) 그 사이 변경을 놓쳤을 수 있다 → 화면 다시 받기
        publish(feed, !resumed);
        console.log(`[realtime] ${feed.id} changeStream ${resumed ? '이어 받기' : '시작'}`);
      };
      // 이벤트가 없어도 서버가 위치를 갱신해 준다 — 다시 열 때 여기서부터
      next.on('resumeTokenChanged', (token: ResumeToken) => {
        if (feed.stream !== next) return;
        feed.lastToken = token;
        markOpened();
      });
      next.on('change', (change: ChangeStreamDocument) => {
        if (feed.stream !== next) return;
        feed.lastToken = change._id;
        markOpened();
        const live = toLiveChange(change);
        if (live) dispatch(feed, live);
      });
      next.on('error', (e: unknown) => {
        if (feed.stream !== next) return;
        // 드라이버가 스스로 이어 받지 못한 에러만 여기로 온다 — 닫고 잠시 뒤 새로 연다
        console.error(`[realtime] ${feed.id} 스트림 에러:`, errorMessage(e));
        // 이어 받을 기록이 이미 지워졌으면(ChangeStreamHistoryLost) 처음부터 — 놓친 게 있으니 resync
        if ((e as { code?: number }).code === 286) feed.lastToken = undefined;
        void next.close().catch(() => undefined);
        feed.stream = null;
        fail(feed, errorMessage(e), true);
      });
    } catch (e) {
      if (feed.stopped) return;
      console.error(`[realtime] ${feed.id} 스트림 열기 실패:`, errorMessage(e));
      fail(feed, errorMessage(e), true);
    }
  };

  const stopFeed = (feed: Feed) => {
    if (feed.stopped) return;
    feed.stopped = true;
    if (feed.graceTimer) clearTimeout(feed.graceTimer);
    closeStream(feed);
    feed.releaseClient();
    if (feeds.get(feed.id) === feed) feeds.delete(feed.id);
  };

  // 소켓이 이 연결을 쓰기 시작 — 피드가 없으면 연다
  const acquire = (id: string): Feed | null => {
    const uri = connectionUri(id);
    if (!uri) return null;
    let feed = feeds.get(id);
    if (!feed) {
      feed = {
        id,
        uri,
        stream: null,
        streamState: 'connecting',
        retryDelay: 1000,
        retryTimer: null,
        stopped: false,
        users: 0,
        graceTimer: null,
        // 스트림이 쓰는 동안 클라이언트가 유휴 해제로 닫히지 않게 붙잡아 둔다
        releaseClient: retainClient(id),
        status: { state: 'connecting' },
        logBacklog: [],
        lagSamples: [],
        perSecond: new Map(),
        eventsTotal: 0,
      };
      feeds.set(id, feed);
      void open(feed);
    }
    feed.users += 1;
    if (feed.graceTimer) clearTimeout(feed.graceTimer);
    feed.graceTimer = null;
    return feed;
  };

  const release = (feed: Feed) => {
    if (feed.stopped) return;
    feed.users -= 1;
    if (feed.users > 0) return;
    feed.graceTimer = setTimeout(() => stopFeed(feed), FEED_GRACE_MS);
  };

  // 연결이 지워졌으면 닫고 알린다. 주소가 바뀌었으면 다른 클러스터일 수 있으니 기록을 비우고 처음부터 연다
  const offConnections = onConnectionsChange(() => {
    for (const feed of [...feeds.values()]) {
      const uri = connectionUri(feed.id);
      if (uri === null) {
        io.to(connRoom(feed.id)).emit('status', { state: 'error', error: GONE_ERROR, gone: true });
        stopFeed(feed);
      } else if (uri !== feed.uri) {
        closeStream(feed);
        feed.uri = uri;
        feed.lastToken = undefined;
        feed.retryDelay = 1000;
        feed.streamState = 'connecting';
        feed.streamError = undefined;
        feed.logBacklog = [];
        feed.lagSamples = [];
        feed.perSecond = new Map();
        feed.eventsTotal = 0;
        publish(feed);
        void open(feed);
      }
    }
  });

  // 하트비트로 닿음/안 닿음이 바뀌면 상태를 다시 알린다. 다시 닿았는데 스트림이 재시도를 기다리는 중이면 바로 연다
  const offHealth = onHealthChange((id, health) => {
    const feed = feeds.get(id);
    if (!feed) return;
    publish(feed);
    if (health.reachable && feed.retryTimer && feed.streamState === 'error') {
      clearTimeout(feed.retryTimer);
      feed.retryTimer = null;
      void open(feed);
    }
    // 단독이던 MongoDB가 replica set으로 다시 떴으면 실시간으로 바꾼다
    if (health.reachable && feed.streamState === 'polling' && health.topology !== 'standalone' && health.topology !== 'unknown') {
      feed.streamState = 'connecting';
      publish(feed);
      void open(feed);
    }
  });

  // ── 소켓 ──
  io.on('connection', (socket: Socket) => {
    // 이 소켓이 쓰는 연결의 피드. 'connection:use'로 정한다
    let feed: Feed | null = null;

    const leaveScope = () => {
      for (const room of socket.rooms) if (room !== socket.id) void socket.leave(room);
    };

    // 이 탭이 쓸 연결 — 바꾸면 이전 연결의 채널을 모두 떠난다
    socket.on('connection:use', (id: unknown) => {
      if (feed) release(feed);
      feed = null;
      leaveScope();
      if (typeof id !== 'string') return;
      const next = acquire(id);
      if (!next) {
        socket.emit('status', { state: 'error', error: GONE_ERROR, gone: true });
        return;
      }
      feed = next;
      void socket.join(connRoom(id));
      // 현재 상태만 알린다 — resync는 '그 순간' 놓친 게 있다는 신호라 지난 값을 새 연결에 다시 보내지 않는다
      // (끊겼다 다시 붙은 클라이언트는 스스로 resync한다)
      const { resync: _resync, ...current } = feed.status;
      socket.emit('status', current);
    });

    // 활동 패널: 열면 최근 기록부터 받고 이후 변경을 계속 받는다
    socket.on('log:subscribe', () => {
      if (!feed) return;
      void socket.join(logRoom(feed.id));
      socket.emit('log:backlog', feed.logBacklog);
    });
    socket.on('log:unsubscribe', () => {
      if (feed) void socket.leave(logRoom(feed.id));
    });
    // 브라우저↔서버 왕복 시간 측정용 — 받자마자 응답만 한다
    socket.on('rtt', (ack: unknown) => {
      if (typeof ack === 'function') (ack as () => void)();
    });

    // 클라이언트가 지금 보는 DB/컬렉션을 알려 오면 채널을 그에 맞게 바꾼다
    socket.on('view', (view: Partial<LiveView>) => {
      if (!feed) return;
      const prefix = `c:${feed.id}:`;
      // 보던 범위의 채널만 바꾼다(연결 채널, 활동 패널 채널은 그대로)
      for (const room of socket.rooms) {
        if (room.startsWith(`${prefix}db:`) || room.startsWith(`${prefix}col:`)) void socket.leave(room);
      }
      try {
        if (typeof view?.database !== 'string') return;
        const database = checkDatabaseName(view.database);
        void socket.join(dbRoom(feed.id, database));
        if (typeof view.collection === 'string') {
          void socket.join(colRoom(feed.id, database, checkCollectionName(view.collection)));
        }
      } catch {
        // 잘못된 이름/숨김 DB면 아무 채널에도 넣지 않는다
      }
    });

    socket.on('disconnect', () => {
      if (feed) release(feed);
      feed = null;
    });
  });

  return {
    stop: async () => {
      offConnections();
      offHealth();
      for (const feed of [...feeds.values()]) stopFeed(feed);
    },
  };
};
