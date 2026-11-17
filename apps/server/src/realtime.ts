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
//   c:<id>:monitor               Monitor 화면을 연 탭 — 10초마다 지표 한 칸(monitor/sampler)
//
// 상태: 드라이버 하트비트(db.ts healthOf)가 "닿지 않음"이면 스트림과 상관없이 error.
// 단독(standalone) MongoDB는 changeStream이 안 되므로 열지 않고 그 사실을 알린다(8-6에서 폴링).
//
// 흔적 없음: changeStream은 읽기 전용이다. 변경 전 문서(pre-image)는 DB 옵션을 켜야 해서 쓰지 않는다.
// 잠깐 끊기면 드라이버가 알아서 이어 받고, 스트림을 새로 열어야 할 땐 클라이언트에 resync를 보내 화면을 다시 받게 한다.
// 빈 구간(9-4): 스트림 위치를 기록 파일(state.json)에 남겨 두고, 피드를 새로 열 땐 지금 클러스터 시각 T0부터 실시간을 받는다.
// 지난번 위치 → T0 사이는 monitor/backfill이 따로 읽어 통계만 채운다(화면에는 보내지 않는다).
import type { ChangeStream, ChangeStreamDocument, Document as BsonDocument, ResumeToken } from 'mongodb';
import type { Server, Socket } from 'socket.io';
import {
  idString,
  type EjsonValue,
  type LiveChange,
  type LiveLogEntry,
  type LiveOperation,
  type LiveStatus,
  type LiveView,
  type MonitorSample,
} from '@mongolive/shared';
import { connectionUri, onConnectionsChange } from './connections';
import { clientFor, healthOf, onHealthChange, retainClient } from './db';
import { checkCollectionName, checkDatabaseName, HIDDEN_DATABASES } from './names';
import { toWire } from './wire';
import { createSampler, type Sampler } from './monitor/sampler';
import { createActivityStats, type ActivityStats } from './monitor/activity';
import { createRecorder, type Recorder, type ResumePoint } from './monitor/history';
import { createSlowLog, type SlowLog } from './monitor/slowQueries';
import { createSizes, type Sizes } from './monitor/sizes';
import { clusterNow, createBackfill, resumePointOf, toTimestamp, tokenTs, tsOf, type Backfill } from './monitor/backfill';
import { clusterFingerprint } from './monitor/identity';
import { SAMPLE_INTERVAL_MS } from './monitor/sampler';
import { getServerSettings } from './settings';

const DOCUMENT_OPS = new Set<LiveOperation>(['insert', 'update', 'replace', 'delete']);
const STRUCTURE_OPS = new Set<LiveOperation>(['create', 'drop', 'rename', 'dropDatabase']);

// DB 이름에는 ':'이 들어갈 수 없고 연결 id는 UUID나 'env'라 채널 이름이 겹치지 않는다
const connRoom = (id: string) => `c:${id}`;
const dbRoom = (id: string, database: string) => `c:${id}:db:${database}`;
const colRoom = (id: string, database: string, collection: string) => `c:${id}:col:${database}.${collection}`;
const logRoom = (id: string) => `c:${id}:log`;
const monitorRoom = (id: string) => `c:${id}:monitor`;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 실시간·불러오기 스트림 공통 — 숨김 DB(admin/config/local)는 빼고
const STREAM_PIPELINE: BsonDocument[] = [{ $match: { 'ns.db': { $nin: [...HIDDEN_DATABASES] } } }];

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
// 지표 한 칸(10초) 동안 지연을 모아 두는 최대 개수 — 이벤트가 폭주해도 메모리가 늘지 않게
const WINDOW_LAG_SAMPLES = 1000;
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
  // 지금 지표 칸(10초) 동안 받은 이벤트 수와 지연(DB 기록 → 서버 수신, ms) — 샘플러가 칸마다 비운다
  windowEvents: number;
  windowLags: number[];
  // Monitor 화면의 지표(serverStatus + ping)
  sampler: Sampler;
  // Monitor › Collections — 받은 쓰기를 컬렉션·분·필드·문서별로 센 것(monitor/activity)
  activity: ActivityStats;
  // 지표를 파일로 남긴다(monitor/history) — 설정 › Monitor에서 끌 수 있다
  recorder: Recorder;
  // 빈 구간 불러오기(monitor/backfill)
  backfill: Backfill;
  // 느린 쿼리(서버 로그, monitor/slowQueries) — 샘플러 박자에 읽는다
  slow: SlowLog;
  // 컬렉션 크기(monitor/sizes, 9-6a) — 열 때와 1시간마다 잰다
  sizes: Sizes;
  // 다음에 스트림을 새로 열 때 T0(지금 클러스터 시각)부터 열고 그 앞을 빈 구간으로 넘긴다 — 피드를 열 때·주소가 바뀔 때
  needsBoundary: boolean;
  // 실시간을 다시 받기 시작한 때(ms) — 맨 마지막 빈 구간을 다 채우면 메모리 집계의 '세기 시작'을 앞당긴다
  t0At: number | null;
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
  feed.activity.record(change);
  feed.windowEvents += 1;
  if (feed.windowLags.length < WINDOW_LAG_SAMPLES) feed.windowLags.push(Math.max(0, change.serverTime - change.clusterTime));
  const entry = toLogEntry(change);
  feed.logBacklog.push(entry);
  if (feed.logBacklog.length > LOG_BACKLOG) feed.logBacklog.shift();
  return entry;
};

// 지표 한 칸을 닫는다 — 그 칸의 이벤트 수와 지연 p95를 돌려주고 비운다
const drainWindow = (feed: Feed): MonitorSample['stream'] => {
  const lags = feed.windowLags.sort((a, b) => a - b);
  const lagP95Ms = lags.length ? lags[Math.min(lags.length - 1, Math.floor(0.95 * lags.length))] : null;
  const stream = { events: feed.windowEvents, lagP95Ms };
  feed.windowEvents = 0;
  feed.windowLags = [];
  return stream;
};

// Monitor › Collections — 그 연결의 쓰기 집계. 피드가 없으면(쓰는 탭이 없음) null
export const activityOf = (connectionId: string): ActivityStats | null => feeds.get(connectionId)?.activity ?? null;

// 설정 › Monitor — 그 연결의 기록기. 피드가 없으면 null(기록 파일은 그대로 있다)
export const recorderOf = (connectionId: string): Recorder | null => feeds.get(connectionId)?.recorder ?? null;

// Monitor — 그 연결의 빈 구간 불러오기. 피드가 없으면 null
export const backfillOf = (connectionId: string): Backfill | null => feeds.get(connectionId)?.backfill ?? null;

// Monitor › Operations — 그 연결의 느린 쿼리. 피드가 없으면 null(안 읽는 중 — 기록 파일은 그대로 있다)
export const slowOf = (connectionId: string): SlowLog | null => feeds.get(connectionId)?.slow ?? null;
export const sizesOf = (connectionId: string): Sizes | null => feeds.get(connectionId)?.sizes ?? null;

// 진단용 — 그 연결의 실시간 상태. 피드가 없으면(쓰는 탭이 없음) connecting
export const realtimeStatus = (connectionId: string): Omit<LiveStatus, 'resync'> => {
  const { resync: _resync, ...status } = feeds.get(connectionId)?.status ?? { state: 'connecting' as const };
  return status;
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
      // 새로 여는 피드면 지금 클러스터 시각부터 — 그 앞(지난번 위치부터)은 불러오기가 맡는다
      const boundary: ResumePoint | null = !feed.lastToken && feed.needsBoundary ? await clusterNow(client) : null;
      if (feed.stopped || feed.stream) return;
      const next = client.watch(STREAM_PIPELINE, {
        // create 같은 구조 이벤트도 받는다(MongoDB 6+)
        showExpandedEvents: true,
        ...(feed.lastToken ? { resumeAfter: feed.lastToken } : boundary ? { startAtOperationTime: toTimestamp(boundary.ts) } : {}),
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
        if (boundary && feed.needsBoundary) {
          feed.needsBoundary = false;
          feed.t0At = boundary.at;
          const { recorder, backfill } = feed;
          void recorder.openGap(boundary).then(() => (feed.stopped || feed.backfill !== backfill ? undefined : backfill.begin()));
        }
      };
      // 이벤트가 없어도 서버가 위치를 갱신해 준다 — 다시 열 때 여기서부터
      next.on('resumeTokenChanged', (token: ResumeToken) => {
        if (feed.stream !== next) return;
        feed.lastToken = token;
        markOpened();
        const ts = tokenTs(token);
        const point = resumePointOf(token, ts, ts ? ts.t * 1000 : Date.now());
        if (point) feed.recorder.noteResume(point);
      });
      next.on('change', (change: ChangeStreamDocument) => {
        if (feed.stream !== next) return;
        feed.lastToken = change._id;
        markOpened();
        const point = resumePointOf(change._id, tsOf((change as { clusterTime?: unknown }).clusterTime), clusterTimeMs(change));
        if (point) feed.recorder.noteResume(point);
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

  // 기록기가 지금 1분과 마지막 누적값을 다 적을 때까지의 약속을 돌려준다(서버 종료 때 기다린다)
  const stopFeed = (feed: Feed): Promise<void> => {
    if (feed.stopped) return Promise.resolve();
    feed.stopped = true;
    if (feed.graceTimer) clearTimeout(feed.graceTimer);
    feed.sampler.stop();
    closeStream(feed);
    if (feeds.get(feed.id) === feed) feeds.delete(feed.id);
    feed.sizes.stop();
    // 불러오기가 위치를 적고 멈춘 뒤 기록기를 닫는다(같은 파일 줄에 선다). 클라이언트는 그다음에 놓는다
    return feed.backfill
      .stop()
      .then(() => feed.slow.stop())
      .then(() => feed.recorder.stop())
      .finally(() => feed.releaseClient());
  };

  // 소켓이 이 연결을 쓰기 시작 — 피드가 없으면 연다
  const acquire = (id: string): Feed | null => {
    const uri = connectionUri(id);
    if (!uri) return null;
    let feed = feeds.get(id);
    if (!feed) {
      const created: Feed = {
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
        windowEvents: 0,
        windowLags: [],
        activity: createActivityStats(),
        recorder: createRecorder({
          connectionId: id,
          fingerprint: async () => clusterFingerprint(await clientFor(id), connectionUri(id) ?? ''),
          minuteWrites: (start) => created.activity.minuteWrites(start),
          retention: () => getServerSettings().monitorHistory,
          alive: () => connectionUri(id) !== null,
          intervalSec: SAMPLE_INTERVAL_MS / 1000,
        }),
        sampler: createSampler({
          label: id,
          client: () => clientFor(id),
          topology: () => healthOf(id).topology,
          drainStream: () => drainWindow(created),
          onSample: (tick) => {
            io.to(monitorRoom(id)).emit('monitor:sample', tick);
            created.recorder.addSample(tick.sample);
          },
          onReading: (counters, at) => created.recorder.addCounters(counters, at),
          eachTick: () => {
            created.sizes.tick();
            return created.slow.poll();
          },
        }),
        slow: createSlowLog({
          connectionId: id,
          client: () => clientFor(id),
          recorder: () => created.recorder,
          stored: () => getServerSettings().monitorHistory !== 'off',
        }),
        sizes: createSizes({
          connectionId: id,
          client: () => clientFor(id),
          recorder: () => created.recorder,
          stored: () => getServerSettings().monitorHistory !== 'off',
        }),
        backfill: createBackfill({
          connectionId: id,
          client: () => clientFor(id),
          recorder: () => created.recorder,
          pipeline: STREAM_PIPELINE,
          convert: toLiveChange,
          record: (change) => created.activity.record(change, true),
          filledUpTo: (from, to) => {
            if (created.t0At !== null && to >= created.t0At) created.activity.extendSince(from);
          },
          autoLimit: () => getServerSettings().backfillAuto,
          onReport: (report) => io.to(monitorRoom(id)).emit('monitor:backfill', report),
        }),
        needsBoundary: true,
        t0At: null,
      };
      feed = created;
      feeds.set(id, feed);
      void open(feed);
      feed.sampler.start();
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
        feed.windowEvents = 0;
        feed.windowLags = [];
        feed.activity = createActivityStats();
        // 느린 쿼리를 옛 서버 폴더에 먼저 적는다(기록기 reset보다 앞서 줄에 선다)
        void feed.slow.reset();
        feed.sizes.reset();
        feed.sampler.reset();
        feed.needsBoundary = true;
        feed.t0At = null;
        publish(feed);
        // 불러오기를 멈춰 위치를 옛 서버의 폴더에 적고, 지금 1분도 적은 뒤 새 주소의 서버 신분부터 다시
        // (같은 서버로 되돌리면 옛 폴더에 이어 붙는다). 그다음에 연다 — 새 빈 구간이 옛 폴더에 들어가지 않게
        const current = feed;
        void current.backfill
          .stop()
          .then(() => current.recorder.reset())
          .then(() => {
            if (!current.stopped) void open(current);
          });
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
    // Monitor 화면: 열면 최근 1시간을 받고 이후 10초마다 한 칸씩
    socket.on('monitor:subscribe', () => {
      if (!feed) return;
      void socket.join(monitorRoom(feed.id));
      socket.emit('monitor:backlog', feed.sampler.snapshot());
      socket.emit('monitor:backfill', feed.backfill.report());
    });
    socket.on('monitor:unsubscribe', () => {
      if (feed) void socket.leave(monitorRoom(feed.id));
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
      // 기록 파일에 마지막 1분을 적고 끝낸다(Ctrl+C로 꺼도 다음에 빈 구간 합계를 낼 수 있게)
      await Promise.all([...feeds.values()].map((feed) => stopFeed(feed)));
    },
  };
};
