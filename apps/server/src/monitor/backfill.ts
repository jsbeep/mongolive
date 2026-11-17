// 빈 구간 불러오기 (9-4) — 탭이 없어 실시간을 안 받던 동안의 쓰기를 changeStream으로 다시 읽어 통계만 채운다
//
//   지난번 위치(state.json) ──불러오기 스트림──▶ … ─┐
//                                                   T0 = 피드가 실시간을 다시 받기 시작한 클러스터 시각
//                                                   └── 실시간 스트림(startAtOperationTime: T0) ──▶
// 두 스트림이 T0에서 나뉘어 겹치지도 비지도 않는다. 불러오기는 화면에 변경을 보내지 않고(깜빡임 없음) 세기만 한다:
//   최근 1시간 안의 이벤트 → Monitor › Collections의 메모리 집계(monitor/activity, 기록 파일엔 따로 적으므로 표시해 둔다)
//   전부 → 분별 컬렉션 쓰기 수로 모아 기록 파일에(recorder.writeFill) — 1시간치마다 쓰고 어디까지 했는지 남긴다
//
// 추정(불러오기 전에 보여 줄 것): 이어 받을 수 있나(oplog 가장 오래된 ts), 이벤트 수(serverStatus 누적값 차이 →
// 안 되면 oplog 세기, 5초 제한), 크기(oplog 평균 항목 × 수), 언제까지 불러와야 하나(시작 지점이 oplog에서 밀려날 때).
// 추정이 설정 › Monitor의 한도 이하면 바로 불러오고, 넘으면 기다린다(POST /monitor/backfill/start).
// oplog가 이미 시작 지점을 지나갔으면 남아 있는 데부터만(partialFrom).
//
// 흔적 없음: changeStream과 local.oplog.rs를 읽기만 한다. 피드가 닫히면(탭이 다 떠남) 멈추고 위치를 남긴다 — 다음에 이어서.
import { Timestamp, type ChangeStream, type ChangeStreamDocument, type Document as BsonDocument, type MongoClient } from 'mongodb';
import type { ActivityOps, BackfillEstimate, BackfillReport, HistoryFill, LiveChange, LiveOperation } from '@mongolive/shared';
import { gapBetween, type Recorder, type ResumePoint, type StoredGap } from './history';
import { isFull, oplogEdge, oplogStorage } from './oplog';
import { withTimeout } from './sampler';

type Ts = { t: number; i: number };

const MINUTE_MS = 60_000;
const COUNTED_OPS = new Set<LiveOperation>(['insert', 'update', 'replace', 'delete']);
// 이만큼 셀 때마다(또는 1시간이 넘어갈 때) 파일에 쓰고 위치를 남긴다
const FLUSH_EVENTS = 50_000;
// 이만큼마다 한 번 다른 일(실시간 스트림·요청)에 차례를 넘긴다
const YIELD_EVENTS = 500;
// 피드가 열린 뒤 누적값(샘플러의 첫 읽기)을 기다리는 최대 시간
const COUNTERS_WAIT_MS = 15_000;
const HISTORY_LOST = 286;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const compareTs = (a: Ts, b: Ts) => a.t - b.t || a.i - b.i;
export const toTimestamp = (ts: Ts) => new Timestamp({ t: ts.t, i: ts.i });
export const tsOf = (value: unknown): Ts | null => {
  const v = value as { getHighBits?: () => number; getLowBits?: () => number } | null;
  if (!v?.getHighBits || !v.getLowBits) return null;
  return { t: v.getHighBits() >>> 0, i: v.getLowBits() >>> 0 };
};

// resume token의 _data 앞부분 = 클러스터 시각('82' + 초 4바이트 + 증가값 4바이트, MongoDB 4.2+). 모르는 모양이면 null
export const tokenTs = (token: unknown): Ts | null => {
  const data = (token as { _data?: unknown } | null)?._data;
  if (typeof data !== 'string' || !/^82[0-9a-fA-F]{16}/.test(data)) return null;
  return { t: parseInt(data.slice(2, 10), 16), i: parseInt(data.slice(10, 18), 16) };
};

// 실시간 스트림의 위치 → 저장할 모양. token이 문자열 _data가 아니면 저장하지 않는다
export const resumePointOf = (token: unknown, ts: Ts | null, at: number): ResumePoint | null => {
  const data = (token as { _data?: unknown } | null)?._data;
  const t = ts ?? tokenTs(token);
  if (typeof data !== 'string' || !t) return null;
  return { token: { _data: data }, ts: t, at };
};

// 지금 클러스터 시각 — 세션으로 가벼운 명령 하나를 보내고 그 operationTime(없으면 clusterTime)을 읽는다.
// operationTime은 마지막 쓰기의 시각과 같을 수 있다 → 증가값 +1: 그 쓰기까지는 불러오기 몫, 실시간은 그 뒤 새 쓰기만
export const clusterNow = async (client: MongoClient): Promise<ResumePoint | null> => {
  const session = client.startSession();
  try {
    await withTimeout(client.db('admin').command({ ping: 1 }, { session }));
    const ts = tsOf(session.operationTime) ?? tsOf(session.clusterTime?.clusterTime);
    return ts ? { ts: { t: ts.t, i: ts.i + 1 }, at: Date.now() } : null;
  } catch {
    return null;
  } finally {
    await session.endSession().catch(() => undefined);
  }
};

interface OplogInfo {
  oldest: Ts | null;
  avgBytes: number | null;
  // 크기 한도까지 거의 찼나(찬 뒤에야 앞에서부터 지워진다). 모르면 null
  full: boolean | null;
}

// oplog의 가장 오래된 항목과 평균 크기 — local 읽기 권한이 없으면 null (읽는 법은 monitor/oplog와 같다)
const oplogInfo = async (client: MongoClient): Promise<OplogInfo> => {
  let oldest: Ts | null = null;
  let avgBytes: number | null = null;
  let full: boolean | null = null;
  try {
    oldest = tsOf((await oplogEdge(client, 1))?.ts);
  } catch {
    // 권한 없음 등
  }
  try {
    const storage = await oplogStorage(client);
    avgBytes = storage.avgBytes;
    full = isFull(storage);
  } catch {
    // 권한 없음 등
  }
  return { oldest, avgBytes, full };
};

// 구간 전체의 이벤트 수 — 닫힐 때와 다시 열린 직후의 serverStatus 누적값 차이, 안 되면 oplog 세기(5초 제한)
const countEvents = async (
  client: MongoClient,
  gap: StoredGap,
  latest: { at: number; counters: Parameters<typeof gapBetween>[1] } | null,
): Promise<NonNullable<StoredGap['estimated']>> => {
  if (gap.before && latest && !gap.progress) {
    const diff = gapBetween(gap.before, latest.counters, latest.at);
    if (!diff.restarted && diff.docs) return { events: diff.docs.inserted + diff.docs.updated + diff.docs.deleted, source: 'counters' };
  }
  try {
    const start = gap.progress ?? gap.from;
    const n = await withTimeout(
      client.db('local').collection('oplog.rs').countDocuments(
        { ts: { $gt: toTimestamp(start.ts), $lt: toTimestamp(gap.to.ts) }, op: { $in: ['i', 'u', 'd'] }, ns: { $not: /^(admin|config)\./ } },
        { maxTimeMS: 5000 },
      ),
    );
    return { events: gap.loaded + n, source: 'oplog' };
  } catch {
    return { events: null, source: null };
  }
};

const remainingOf = (gap: StoredGap): number | null =>
  gap.estimated?.events == null ? null : Math.max(0, gap.estimated.events - gap.loaded);

const estimateOf = (gap: StoredGap, oplog: OplogInfo, now: number): BackfillEstimate => {
  const start = gap.progress ?? gap.from;
  const events = remainingOf(gap);
  const resumable = oplog.oldest ? compareTs(start.ts, oplog.oldest) >= 0 : null;
  return {
    resumable,
    events,
    total: gap.estimated?.events ?? null,
    source: gap.estimated?.source ?? null,
    bytes: events !== null && oplog.avgBytes !== null ? Math.round(events * oplog.avgBytes) : null,
    // 시작 지점과 oplog 맨 앞의 거리만큼 더 지나면 시작 지점이 밀려난다(쓰기 속도가 그대로라면).
    // 아직 크기 한도까지 안 찼으면 아무것도 지워지지 않으니 기한이 없다(null)
    deadline: resumable && oplog.oldest && oplog.full !== false ? now + (start.ts.t - oplog.oldest.t) * 1000 : null,
  };
};

export interface BackfillHooks {
  connectionId: string;
  client: () => Promise<MongoClient>;
  recorder: () => Recorder;
  // 실시간과 같은 필터(숨김 DB 빼기)
  pipeline: BsonDocument[];
  convert: (change: ChangeStreamDocument) => LiveChange | null;
  // 메모리 집계에(최근 1시간 것만 남는다)
  record: (change: LiveChange) => void;
  // 맨 마지막 빈 구간(실시간 바로 앞)을 다 채움 — 메모리 집계가 그때부터 센 셈
  filledUpTo: (from: number, to: number) => void;
  autoLimit: () => number;
  // 바뀌면 알린다(불러오는 중엔 1초에 한 번)
  onReport: (report: BackfillReport) => void;
  clock?: () => number;
}

export interface Backfill {
  // 피드가 실시간을 다시 받기 시작함(recorder.openGap 다음) — 추정하고, 한도 이하면 바로 불러온다
  begin: () => Promise<void>;
  report: () => BackfillReport;
  // 불러오기/계속 — id가 없으면 전부
  load: (id?: string) => Promise<void>;
  // 멈춤 — 자동으로 다시 시작하지 않는다
  pause: (id?: string) => Promise<void>;
  // 피드가 닫힘 — 멈추고 위치를 남긴다(다음에 열리면 다시 판단)
  stop: () => Promise<void>;
}

interface Run {
  id: string;
  aborted: boolean;
  loaded: number;
  loadedTo: number | null;
  partialFrom?: number;
  done: Promise<void>;
}

export const createBackfill = (hooks: BackfillHooks): Backfill => {
  const clock = hooks.clock ?? Date.now;
  const label = `[backfill] ${hooks.connectionId}`;
  let closed = true;
  let current: Run | null = null;
  const wanted = new Set<string>();
  const estimates = new Map<string, BackfillEstimate>();
  const errors = new Map<string, string>();
  let oplog: OplogInfo = { oldest: null, avgBytes: null, full: null };
  let notifyTimer: NodeJS.Timeout | null = null;

  const report = (): BackfillReport => ({
    autoLimit: hooks.autoLimit(),
    gaps: hooks.recorder().gaps().map((g) => {
      const run = current?.id === g.id ? current : null;
      return {
        id: g.id,
        from: g.from.at,
        to: g.to.at,
        status: run || wanted.has(g.id) ? 'loading' : errors.has(g.id) ? 'error' : g.paused ? 'paused' : 'pending',
        loadedTo: run?.loadedTo ?? g.progress?.at ?? null,
        loaded: run?.loaded ?? g.loaded,
        ...((run?.partialFrom ?? g.partialFrom) !== undefined ? { partialFrom: run?.partialFrom ?? g.partialFrom } : {}),
        ...(errors.has(g.id) ? { error: errors.get(g.id) } : {}),
        estimate: estimates.get(g.id) ?? null,
      };
    }),
  });

  const notify = (now = false) => {
    if (now) {
      if (notifyTimer) clearTimeout(notifyTimer);
      notifyTimer = null;
      hooks.onReport(report());
      return;
    }
    notifyTimer ??= setTimeout(() => {
      notifyTimer = null;
      hooks.onReport(report());
    }, 1000);
  };

  const refreshEstimates = async (client: MongoClient) => {
    oplog = await oplogInfo(client);
    const now = clock();
    for (const g of hooks.recorder().gaps()) estimates.set(g.id, estimateOf(g, oplog, now));
  };

  // 한 구간을 스트림 하나로 읽는다. 끝 = 'done' | 'aborted' | 'lost'(시작 지점이 oplog에서 밀려남)
  const readStream = async (client: MongoClient, gap: StoredGap, start: ResumePoint, inclusive: boolean, run: Run): Promise<'done' | 'aborted' | 'lost'> => {
    // 시작 지점이 token이 없는 T0면(지난번 실시간이 이벤트 하나 못 받고 닫힘) 그 시각의 이벤트는 실시간이 이미 받았다
    const skipThrough = !start.token && !inclusive ? start.ts : null;
    const stream: ChangeStream = client.watch([...hooks.pipeline, { $project: { fullDocument: 0 } }], {
      showExpandedEvents: true,
      batchSize: 1000,
      maxAwaitTimeMS: 1000,
      ...(start.token ? { resumeAfter: start.token } : { startAtOperationTime: toTimestamp(start.ts) }),
    });
    let minutes = new Map<number, Map<string, ActivityOps>>();
    let pending = 0;
    let bufferHour: number | null = null;
    let last: ResumePoint | null = null;
    let sinceYield = 0;
    let emptyAt: number | null = null;

    const flush = async () => {
      if (!last) return;
      const batch = minutes;
      minutes = new Map();
      pending = 0;
      await hooks.recorder().writeFill(gap.id, batch, { progress: last, loaded: run.loaded, ...(run.partialFrom !== undefined ? { partialFrom: run.partialFrom } : {}) });
    };

    try {
      while (!run.aborted) {
        const doc = (await stream.tryNext()) as ChangeStreamDocument | null;
        if (!doc) {
          // 지금까지 쌓인 걸 다 읽음 — 위치가 T0 바로 앞(= 열 때의 마지막 쓰기, clusterNow의 +1 참고)까지 왔으면 끝.
          // 아니면 서버가 위치를 앞으로 옮겨 줄 때까지(한가하면 10초마다 no-op) — 위치를 못 읽으면 10초 뒤 끝
          const at = tokenTs(stream.resumeToken);
          const reached = at && (compareTs(at, gap.to.ts) >= 0 || (at.t === gap.to.ts.t && at.i + 1 >= gap.to.ts.i));
          if (reached || (!at && (emptyAt ??= clock()) < clock() - 10_000)) break;
          continue;
        }
        const ts = tsOf((doc as { clusterTime?: unknown }).clusterTime);
        if (ts && compareTs(ts, gap.to.ts) >= 0) break;
        if (ts && skipThrough && compareTs(ts, skipThrough) <= 0) continue;
        const live = hooks.convert(doc);
        const at = live?.clusterTime ?? (ts ? ts.t * 1000 : clock());
        const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
        const hour = new Date(minute).setMinutes(0, 0, 0);
        // 1시간이 넘어가거나 많이 쌓였으면 지금까지를 적는다(위치는 직전 이벤트까지)
        if (pending > 0 && (hour !== bufferHour || pending >= FLUSH_EVENTS)) await flush();
        bufferHour = hour;
        const point = resumePointOf(doc._id, ts, at);
        if (point) last = point;
        if (live?.collection && COUNTED_OPS.has(live.op)) {
          const ns = `${live.database}.${live.collection}`;
          let byNs = minutes.get(minute);
          if (!byNs) {
            byNs = new Map();
            minutes.set(minute, byNs);
          }
          const ops = byNs.get(ns) ?? { insert: 0, update: 0, replace: 0, delete: 0 };
          ops[live.op as keyof ActivityOps] += 1;
          byNs.set(ns, ops);
          pending += 1;
          run.loaded += 1;
        }
        if (live) hooks.record(live);
        run.loadedTo = at;
        notify();
        if (++sinceYield >= YIELD_EVENTS) {
          sinceYield = 0;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
      await flush();
      return run.aborted ? 'aborted' : 'done';
    } catch (e) {
      await flush().catch(() => undefined);
      if ((e as { code?: number }).code === HISTORY_LOST) return 'lost';
      throw e;
    } finally {
      await stream.close().catch(() => undefined);
    }
  };

  const runGap = async (gap: StoredGap, run: Run) => {
    const client = await hooks.client();
    let start = gap.progress ?? gap.from;
    let inclusive = false;
    for (let attempt = 0; ; attempt++) {
      const outcome = await readStream(client, gap, start, inclusive, run);
      if (outcome === 'aborted') return;
      if (outcome === 'done') {
        const fill: HistoryFill = { from: gap.from.at, to: gap.to.at, events: run.loaded, ...(run.partialFrom !== undefined ? { partialFrom: run.partialFrom } : {}) };
        await hooks.recorder().finishGap(gap.id, fill);
        hooks.filledUpTo(run.partialFrom ?? gap.from.at, gap.to.at);
        console.log(`${label} 빈 구간 채움: 이벤트 ${run.loaded}개${run.partialFrom !== undefined ? ' (앞부분은 이미 지워짐)' : ''}`);
        return;
      }
      // 시작 지점이 oplog에서 밀려났다 — 남은 맨 앞부터 한 번만 다시
      const { oldest } = await oplogInfo(client);
      if (attempt > 0 || !oldest || compareTs(oldest, gap.to.ts) >= 0) {
        await hooks.recorder().finishGap(gap.id, { from: gap.from.at, to: gap.to.at, events: run.loaded, lost: run.loaded === 0, ...(run.partialFrom !== undefined ? { partialFrom: run.partialFrom } : {}) });
        console.log(`${label} 빈 구간을 불러올 수 없음 — oplog에서 이미 지워짐`);
        return;
      }
      start = { ts: oldest, at: oldest.t * 1000 };
      inclusive = true;
      run.partialFrom = start.at;
    }
  };

  const runNext = () => {
    if (closed || current) return;
    const gap = hooks.recorder().gaps().find((g) => wanted.has(g.id));
    if (!gap) {
      wanted.clear();
      return;
    }
    errors.delete(gap.id);
    const run: Run = { id: gap.id, aborted: false, loaded: gap.loaded, loadedTo: gap.progress?.at ?? null, partialFrom: gap.partialFrom, done: Promise.resolve() };
    current = run;
    notify(true);
    run.done = runGap(gap, run)
      .catch((e) => {
        console.error(`${label} 불러오기 실패:`, errorMessage(e));
        errors.set(gap.id, errorMessage(e));
      })
      .finally(async () => {
        wanted.delete(gap.id);
        current = null;
        try {
          if (!closed) await refreshEstimates(await hooks.client());
        } catch {
          // 다음 추정 때
        }
        notify(true);
        runNext();
      });
  };

  // 지금 도는 것을 멈추고 끝날 때까지(위치 저장 포함) 기다린다
  const abortCurrent = async (id?: string) => {
    const run = current;
    if (!run || (id && run.id !== id)) return;
    run.aborted = true;
    await run.done;
  };

  return {
    async begin() {
      closed = false;
      const recorder = hooks.recorder();
      try {
        const client = await hooks.client();
        // 누적값 차이로 셀 구간이 있으면 샘플러의 첫 읽기를 잠깐 기다린다
        const needsCounters = recorder.gaps().some((g) => !g.estimated && g.before && !g.progress);
        for (let waited = 0; needsCounters && !recorder.latestCounters() && waited < COUNTERS_WAIT_MS && !closed; waited += 500) await sleep(500);
        for (const g of recorder.gaps()) {
          if (closed) return;
          if (!g.estimated) await recorder.updateGap(g.id, { estimated: await countEvents(client, g, recorder.latestCounters()) });
        }
        if (closed) return;
        await refreshEstimates(client);
      } catch (e) {
        console.error(`${label} 추정 실패:`, errorMessage(e));
      }
      const limit = hooks.autoLimit();
      for (const g of recorder.gaps()) {
        const remaining = remainingOf(g);
        const est = estimates.get(g.id);
        console.log(`${label} 빈 구간 ${Math.round((g.to.at - g.from.at) / 1000)}초: 남은 이벤트 ${remaining ?? '?'}(${g.estimated?.source ?? '모름'}), 이어 받기 ${est?.resumable ?? '?'}`);
        // 0건이면 한도가 꺼져 있어도 바로 정리한다(읽을 게 없다)
        if (!g.paused && remaining !== null && (remaining === 0 || (limit > 0 && remaining <= limit))) wanted.add(g.id);
      }
      notify(true);
      runNext();
    },
    report,
    async load(id) {
      const gaps = hooks.recorder().gaps().filter((g) => !id || g.id === id);
      for (const g of gaps) {
        wanted.add(g.id);
        if (g.paused) await hooks.recorder().updateGap(g.id, { paused: false });
      }
      notify(true);
      runNext();
    },
    async pause(id) {
      const gaps = hooks.recorder().gaps().filter((g) => !id || g.id === id);
      for (const g of gaps) wanted.delete(g.id);
      await abortCurrent(id);
      for (const g of gaps) await hooks.recorder().updateGap(g.id, { paused: true });
      notify(true);
    },
    async stop() {
      closed = true;
      wanted.clear();
      if (notifyTimer) clearTimeout(notifyTimer);
      notifyTimer = null;
      await abortCurrent();
    },
  };
};
