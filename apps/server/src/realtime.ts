// 실시간 변경 전달 (5단계)
//
//   MongoDB ──changeStream(클러스터 전체에 1개)──▶ 이 모듈 ──socket.io──▶ 브라우저
//
// 채널(room):
//   col:<db>.<collection>  지금 그 컬렉션을 보는 클라이언트 — 문서 변경을 자세히(바뀐 경로·값)
//   db:<db>                그 DB를 보는 클라이언트 — 다른 컬렉션의 문서 변경은 요약만(문서 수 갱신용)
//   (전체)                 컬렉션/DB 생성·삭제·이름변경 — DB/컬렉션 목록이 바뀌므로 모두에게
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
import { getClient } from './db';
import { checkCollectionName, checkDatabaseName, HIDDEN_DATABASES } from './names';
import { toWire } from './wire';

const DOCUMENT_OPS = new Set<LiveOperation>(['insert', 'update', 'replace', 'delete']);
const STRUCTURE_OPS = new Set<LiveOperation>(['create', 'drop', 'rename', 'dropDatabase']);

const dbRoom = (database: string) => `db:${database}`;
const colRoom = (database: string, collection: string) => `col:${database}.${collection}`;

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

// ── 활동 패널용 기록(메모리에만) ───────────────────────────────────────────────
// 'log' 채널 = 활동 패널을 연 클라이언트. 클러스터 전체 변경을 값 없이 받는다.
const LOG_ROOM = 'log';
const LOG_BACKLOG = 200;
const LAG_SAMPLES = 200;
const RATE_WINDOW_SEC = 60;

const logBacklog: LiveLogEntry[] = [];
const lagSamples: number[] = [];
// 초(epoch sec) → 그 1초 동안 받은 이벤트 수
const perSecond = new Map<number, number>();
let eventsTotal = 0;
let currentStatus: LiveStatus = { state: 'connecting' };

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

const record = (change: LiveChange) => {
  eventsTotal += 1;
  const second = Math.floor(change.serverTime / 1000);
  perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
  for (const key of perSecond.keys()) if (key < second - RATE_WINDOW_SEC) perSecond.delete(key);
  lagSamples.push(Math.max(0, change.serverTime - change.clusterTime));
  if (lagSamples.length > LAG_SAMPLES) lagSamples.shift();
  const entry = toLogEntry(change);
  logBacklog.push(entry);
  if (logBacklog.length > LOG_BACKLOG) logBacklog.shift();
  return entry;
};

const lagStats = (): LagStats | null => {
  if (lagSamples.length === 0) return null;
  const sorted = [...lagSamples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1], samples: sorted.length };
};

export const realtimeMetrics = (): ServerMetrics['realtime'] => {
  const now = Math.floor(Date.now() / 1000);
  const eventsPerSecond = Array.from({ length: RATE_WINDOW_SEC }, (_, i) => perSecond.get(now - RATE_WINDOW_SEC + 1 + i) ?? 0);
  const { resync: _resync, ...status } = currentStatus;
  return { status, eventsTotal, eventsPerSecond, lag: lagStats() };
};

// ── 스트림 관리 ───────────────────────────────────────────────────────────────

export const startRealtime = (io: Server) => {
  let stream: ChangeStream | null = null;
  let retryDelay = 1000;
  let stopped = false;
  // 마지막으로 받은 위치 — 스트림을 새로 열 때 이어 받기에 쓴다(메모리에만)
  let lastToken: ResumeToken | undefined;

  const setStatus = (next: LiveStatus) => {
    currentStatus = next;
    io.emit('status', next);
  };

  const dispatch = (change: LiveChange) => {
    io.to(LOG_ROOM).emit('log', record(change));
    if (STRUCTURE_OPS.has(change.op) || !change.collection) {
      io.emit('change', summarize(change));
      return;
    }
    // 이 컬렉션을 보는 클라이언트에겐 자세히, 같은 DB의 나머지에겐 요약만
    // (socket.io는 한 소켓이 두 방에 다 있어도 except로 중복 없이 나눌 수 있다)
    const col = colRoom(change.database, change.collection);
    io.to(col).emit('change', change);
    io.to(dbRoom(change.database)).except(col).emit('change', summarize(change));
  };

  const open = async () => {
    if (stopped) return;
    try {
      const client = await getClient();
      const pipeline: BsonDocument[] = [{ $match: { 'ns.db': { $nin: [...HIDDEN_DATABASES] } } }];
      const next = client.watch(pipeline, {
        // create 같은 구조 이벤트도 받는다(MongoDB 6+)
        showExpandedEvents: true,
        ...(lastToken ? { resumeAfter: lastToken } : {}),
      });
      stream = next;

      // 스트림이 실제로 열렸다는 신호: 서버의 첫 응답에는 항상 위치(postBatchResumeToken)가 실려 오고,
      // 드라이버는 그걸 'resumeTokenChanged'로 알린다('init'은 이 드라이버 버전에서 바깥으로 전달되지 않음).
      // 권한·설정 에러면 이 신호 없이 'error'가 온다.
      const resumed = lastToken !== undefined;
      let opened = false;
      const markOpened = () => {
        if (opened) return;
        opened = true;
        retryDelay = 1000;
        // 새로 연 스트림이면(이어 받기가 아니면) 그 사이 변경을 놓쳤을 수 있다 → 화면 다시 받기
        setStatus({ state: 'running', resync: !resumed });
        console.log(`[realtime] changeStream ${resumed ? '이어 받기' : '시작'}`);
      };
      // 이벤트가 없어도 서버가 위치를 갱신해 준다 — 다시 열 때 여기서부터
      next.on('resumeTokenChanged', (token: ResumeToken) => {
        lastToken = token;
        markOpened();
      });
      next.on('change', (change: ChangeStreamDocument) => {
        lastToken = change._id;
        markOpened();
        const live = toLiveChange(change);
        if (live) dispatch(live);
      });
      next.on('error', (e: unknown) => {
        // 드라이버가 스스로 이어 받지 못한 에러만 여기로 온다 — 닫고 잠시 뒤 새로 연다
        console.error('[realtime] 스트림 에러:', errorMessage(e));
        // 이어 받을 기록이 이미 지워졌으면(ChangeStreamHistoryLost) 처음부터 — 놓친 게 있으니 resync
        if ((e as { code?: number }).code === 286) lastToken = undefined;
        setStatus({ state: 'error', error: errorMessage(e) });
        void next.close().catch(() => undefined);
        if (stream === next) stream = null;
        scheduleReopen();
      });
    } catch (e) {
      console.error('[realtime] 스트림 열기 실패:', errorMessage(e));
      setStatus({ state: 'error', error: errorMessage(e) });
      scheduleReopen();
    }
  };

  const scheduleReopen = () => {
    if (stopped) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, 30_000);
    setTimeout(() => void open(), delay);
  };

  // ── 소켓 ──
  io.on('connection', (socket: Socket) => {
    // 현재 상태만 알린다 — resync는 '그 순간' 놓친 게 있다는 신호라 지난 값을 새 연결에 다시 보내지 않는다
    // (끊겼다 다시 붙은 클라이언트는 스스로 resync한다)
    const { resync: _resync, ...current } = currentStatus;
    socket.emit('status', current);

    // 활동 패널: 열면 최근 기록부터 받고 이후 변경을 계속 받는다
    socket.on('log:subscribe', () => {
      void socket.join(LOG_ROOM);
      socket.emit('log:backlog', logBacklog);
    });
    socket.on('log:unsubscribe', () => void socket.leave(LOG_ROOM));
    // 브라우저↔서버 왕복 시간 측정용 — 받자마자 응답만 한다
    socket.on('rtt', (ack: unknown) => {
      if (typeof ack === 'function') (ack as () => void)();
    });

    // 클라이언트가 지금 보는 DB/컬렉션을 알려 오면 채널을 그에 맞게 바꾼다
    socket.on('view', (view: Partial<LiveView>) => {
      // 보던 범위의 채널만 바꾼다(활동 패널 'log' 채널은 그대로)
      for (const room of socket.rooms) {
        if (room.startsWith('db:') || room.startsWith('col:')) void socket.leave(room);
      }
      try {
        if (typeof view?.database !== 'string') return;
        const database = checkDatabaseName(view.database);
        void socket.join(dbRoom(database));
        if (typeof view.collection === 'string') {
          void socket.join(colRoom(database, checkCollectionName(view.collection)));
        }
      } catch {
        // 잘못된 이름/숨김 DB면 아무 채널에도 넣지 않는다
      }
    });
  });

  void open();

  return {
    stop: async () => {
      stopped = true;
      await stream?.close().catch(() => undefined);
    },
  };
};
