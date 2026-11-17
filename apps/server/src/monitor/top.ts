// 컬렉션별 서버 시간 (9-6c) — Monitor › Collections의 Time spent 카드
//
// 샘플러 박자(10초)마다 admin `top`을 한 번 묻는다(읽기 전용). top은 mongod가 켜진 뒤 컬렉션마다 쌓은 누적값(시간 µs·횟수)이라
// 지난번 읽기와의 차이만 1분 칸에 더해 최근 1시간을 메모리에 둔다(파일에 적지 않는다 — 피드가 닫히면 사라진다).
//   읽기 = readLock (find·getMore·aggregate·count·distinct·collStats …)
//   쓰기 = writeLock(insert·update·delete·findAndModify·인덱스 만들기 …)   — 둘을 더하면 total
// 명령 하나 = 1회(문서가 몇 개든). 연결된 멤버(보통 primary)의 값이라 secondary에서 읽은 건 안 보인다. mongolive 자신의 쿼리도 들어간다.
// mongos·일부 Atlas 등급엔 top이 없다 → unsupported(다시 묻지 않는다). 권한(top 액션, clusterMonitor)이 없으면 denied(5분 뒤 다시).
// top 응답은 mongod가 켜진 뒤 건드린 모든 컬렉션을 담는다 — 1000개가 넘으면 1분마다만 묻는다.
import type { MongoClient } from 'mongodb';
import { TOP_OPS, type ActivityRange, type CollectionTopRow, type TopReport, type TopUsage } from '@mongolive/shared';
import { HIDDEN_DATABASES, isHiddenCollection } from '../names';
import { isUnauthorized, type OperationsScope } from './operations';
import { withTimeout } from './sampler';
import { dbOf, inScope } from './sizes';
import { RANGE_MS } from './slowQueries';

const MINUTE = 60_000;
const KEEP_MS = 60 * MINUTE;
const DENIED_RETRY_MS = 5 * MINUTE;
const MANY_NAMESPACES = 1000;
const SLOW_EVERY = 6;
const MAX_ROWS = 100;
const COMMAND_NOT_FOUND = 59;
const ATLAS_ERROR = 8000;

// 한 컬렉션의 값 = [time, count] × FIELDS 순서
const FIELDS = ['total', 'readLock', 'writeLock', ...TOP_OPS] as const;
type Counters = number[];

const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0) || 0);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown) => Number((e as { code?: unknown })?.code);

// top의 totals → "db.collection" → 값. 'note' 같은 숫자 아닌 항목, admin·local·config, system.*은 뺀다
export const readTop = (totals: Record<string, unknown> | undefined): Map<string, Counters> => {
  const out = new Map<string, Counters>();
  for (const [ns, entry] of Object.entries(totals ?? {})) {
    if (typeof entry !== 'object' || entry === null) continue;
    const dot = ns.indexOf('.');
    if (dot <= 0 || HIDDEN_DATABASES.has(ns.slice(0, dot)) || isHiddenCollection(ns.slice(dot + 1))) continue;
    const values: Counters = [];
    for (const field of FIELDS) {
      const usage = ((entry as Record<string, unknown>)[field] ?? {}) as { time?: unknown; count?: unknown };
      values.push(num(usage.time), num(usage.count));
    }
    out.set(ns, values);
  }
  return out;
};

// 두 읽기 사이에 늘어난 만큼. 지난번에 없던 컬렉션(새로 씀)이나 카운터가 줄어든 것(지우고 다시 만듦·재시작)은 지금 값 전체
export const topDelta = (prev: Map<string, Counters>, cur: Map<string, Counters>): Map<string, Counters> => {
  const out = new Map<string, Counters>();
  for (const [ns, now] of cur) {
    const before = prev.get(ns);
    const delta = !before || now[1] < before[1] ? now : now.map((v, i) => Math.max(0, v - before[i]));
    if (delta[1] > 0) out.set(ns, delta);
  }
  return out;
};

const addInto = (into: Counters, values: Counters) => {
  for (let i = 0; i < values.length; i++) into[i] += values[i];
};

const usageAt = (values: Counters, field: (typeof FIELDS)[number]): TopUsage => {
  const i = FIELDS.indexOf(field) * 2;
  return { time: values[i], count: values[i + 1] };
};

export const toTopRow = (ns: string, values: Counters): CollectionTopRow => ({
  database: dbOf(ns),
  collection: ns.slice(ns.indexOf('.') + 1),
  total: usageAt(values, 'total'),
  read: usageAt(values, 'readLock'),
  write: usageAt(values, 'writeLock'),
  ops: Object.fromEntries(TOP_OPS.map((op) => [op, usageAt(values, op)])) as CollectionTopRow['ops'],
});

export interface TopHooks {
  client: () => Promise<MongoClient>;
  clock?: () => number;
}

export interface Top {
  // 샘플러 박자마다 — 끝나야 다음 칸을 예약한다(겹치지 않게). 실패해도 던지지 않는다
  poll: () => Promise<void>;
  // 주소가 바뀜(다른 서버일 수 있다) — 지난 값을 버리고 처음부터
  reset: () => void;
  report: (query: { range: ActivityRange; scope: OperationsScope }) => TopReport;
}

export const createTop = (hooks: TopHooks): Top => {
  const clock = hooks.clock ?? Date.now;
  let prev: Map<string, Counters> | null = null;
  // 1분 칸 시작 → 컬렉션 → 그 1분 동안 늘어난 값
  let minutes = new Map<number, Map<string, Counters>>();
  let baselineAt: number | null = null;
  let lastAt: number | null = null;
  let status: TopReport['status'] = 'ok';
  let error: string | null = null;
  let retryAt = 0;
  let every = 1;
  let ticks = 0;
  let generation = 0;

  const record = (at: number, delta: Map<string, Counters>) => {
    const start = Math.floor(at / MINUTE) * MINUTE;
    let bucket = minutes.get(start);
    if (!bucket) minutes.set(start, (bucket = new Map()));
    for (const [ns, values] of delta) {
      const into = bucket.get(ns);
      if (into) addInto(into, values);
      else bucket.set(ns, [...values]);
    }
    for (const key of minutes.keys()) if (key < start - KEEP_MS) minutes.delete(key);
  };

  return {
    async poll() {
      if (status === 'unsupported' || clock() < retryAt) return;
      ticks += 1;
      if (ticks % every !== 0) return;
      const gen = generation;
      try {
        const result = await withTimeout((await hooks.client()).db('admin').command({ top: 1 }));
        if (gen !== generation) return;
        const at = clock();
        const totals = result.totals as Record<string, unknown> | undefined;
        every = Object.keys(totals ?? {}).length > MANY_NAMESPACES ? SLOW_EVERY : 1;
        const cur = readTop(totals);
        if (prev) record(at, topDelta(prev, cur));
        else baselineAt = at;
        prev = cur;
        lastAt = at;
        status = 'ok';
        error = null;
      } catch (e) {
        if (gen !== generation) return;
        if (isUnauthorized(e)) {
          status = 'denied';
          retryAt = clock() + DENIED_RETRY_MS;
          // 다시 허락되면 그사이 쌓인 것을 한 칸에 몰지 않게 처음부터
          prev = null;
          baselineAt = null;
        } else if (codeOf(e) === COMMAND_NOT_FOUND || codeOf(e) === ATLAS_ERROR) {
          status = 'unsupported';
        } else {
          // 잠깐의 실패(시간 초과 등) — 지난 값을 두고 다음 박자에 이어서(차이가 두 칸에 걸칠 뿐)
          status = 'error';
          error = errorMessage(e);
        }
      }
    },
    reset() {
      generation += 1;
      prev = null;
      minutes = new Map();
      baselineAt = null;
      lastAt = null;
      status = 'ok';
      error = null;
      retryAt = 0;
      every = 1;
      ticks = 0;
    },
    report({ range, scope }) {
      const now = clock();
      // 1분 칸 단위 — 기간 시작이 든 칸부터(5m = 5~6분)
      const from = Math.floor((now - (RANGE_MS[range] ?? KEEP_MS)) / MINUTE) * MINUTE;
      const sums = new Map<string, Counters>();
      for (const [start, bucket] of minutes) {
        if (start < from) continue;
        for (const [ns, values] of bucket) {
          if (!inScope(ns, scope)) continue;
          const into = sums.get(ns);
          if (into) addInto(into, values);
          else sums.set(ns, [...values]);
        }
      }
      const rows = [...sums].map(([ns, values]) => toTopRow(ns, values)).sort((a, b) => b.total.time - a.total.time);
      return {
        status,
        error,
        since: baselineAt === null ? null : Math.max(baselineAt, from),
        at: lastAt,
        rows: rows.slice(0, MAX_ROWS),
        more: Math.max(0, rows.length - MAX_ROWS),
      };
    },
  };
};
