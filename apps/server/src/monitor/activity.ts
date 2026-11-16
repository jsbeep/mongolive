// changeStream 쓰기 집계 — Monitor › Collections (9-2)
//
// 피드가 이미 받는 이벤트를 세기만 한다(DB에 묻지 않으니 부하 없음). 피드가 열린 뒤부터, 메모리에만.
//   B1·B2  1분 칸 60개(1시간): 칸마다 {컬렉션 → insert/update/replace/delete 수}
//   B3·B4  5분 칸 12개: 칸마다 {컬렉션 → 바뀐 경로 수, 문서 id 수} — 서로 다른 값이 많아질 수 있어서 거칠게 잡는다
//   B5     컬렉션별 마지막 쓰기
// 메모리 상한: 분 칸마다 컬렉션 500개, 5분 칸마다 경로+문서 2,000개. 넘친 건 세지 않고 partial로 알린다.
// 시각은 MongoDB에 기록된 시각(clusterTime) 기준 — 늦게 도착해도 쓴 때의 칸에 들어간다.
import type { ActivityCollection, ActivityOps, ActivityRange, ActivityReport, LastWrite, LiveChange, LiveOperation } from '@mongolive/shared';

export const MINUTE_MS = 60_000;
export const SLOT_MS = 5 * MINUTE_MS;
const KEEP_MINUTES = 60;
const KEEP_SLOTS = 12;
export const MAX_NS_PER_MINUTE = 500;
export const MAX_KEYS_PER_SLOT = 2000;
// 이벤트 하나에서 세는 경로 수 — $set 하나로 수백 필드를 바꿔도 한 번에 너무 많이 늘지 않게
const MAX_PATHS_PER_EVENT = 50;
const MAX_KEY_LENGTH = 200;
const TOP = 20;
const MAX_COLLECTIONS = 300;

const COUNTED_OPS = new Set<LiveOperation>(['insert', 'update', 'replace', 'delete']);
const RANGE_MS: Record<ActivityRange, number> = { '5m': 5 * MINUTE_MS, '1h': 60 * MINUTE_MS };

const emptyOps = (): ActivityOps => ({ insert: 0, update: 0, replace: 0, delete: 0 });
const addOps = (into: ActivityOps, from: ActivityOps) => {
  into.insert += from.insert;
  into.update += from.update;
  into.replace += from.replace;
  into.delete += from.delete;
};
const sumOps = (ops: ActivityOps) => ops.insert + ops.update + ops.replace + ops.delete;

// "db.collection" — DB 이름엔 '.'이 없으므로 첫 '.'에서 나눌 수 있다
const nsOf = (database: string, collection: string) => `${database}.${collection}`;
const splitNs = (ns: string): [string, string] => {
  const dot = ns.indexOf('.');
  return [ns.slice(0, dot), ns.slice(dot + 1)];
};

// 배열 번호는 묶는다: items.3.qty → items.[].qty — 같은 필드가 원소마다 따로 세지지 않게
export const normalizePath = (path: string): string =>
  path.split('.').map((part) => (/^\d+$/.test(part) ? '[]' : part)).join('.').slice(0, MAX_KEY_LENGTH);

interface MinuteBucket {
  start: number;
  byNs: Map<string, ActivityOps>;
}

interface SlotBucket {
  start: number;
  paths: Map<string, Map<string, number>>;
  docs: Map<string, Map<string, number>>;
  keys: number;
  // 상한에 걸려 못 센 게 있는 컬렉션
  overflow: Set<string>;
}

export interface ActivityQuery {
  database?: string | null;
  collection?: string | null;
  range: ActivityRange;
}

export interface ActivityStats {
  record: (change: LiveChange) => void;
  report: (query: ActivityQuery, now?: number) => ActivityReport;
  lastWrites: () => Record<string, LastWrite>;
  // 그 1분 동안의 컬렉션별 쓰기 — 기록 파일(monitor/history)이 1분 기록에 붙인다
  minuteWrites: (start: number) => Map<string, ActivityOps> | undefined;
  readonly since: number;
}

// clock: 테스트가 시간을 정할 수 있게
export const createActivityStats = (since = Date.now(), clock: () => number = Date.now): ActivityStats => {
  const minutes = new Map<number, MinuteBucket>();
  const slots = new Map<number, SlotBucket>();
  const last = new Map<string, LastWrite>();

  const minuteOf = (start: number) => {
    let bucket = minutes.get(start);
    if (!bucket) {
      bucket = { start, byNs: new Map() };
      minutes.set(start, bucket);
      // 1시간보다 오래된 칸은 버린다(Map은 넣은 순서 — 대개 앞쪽이 오래된 것)
      for (const key of minutes.keys()) if (key <= start - KEEP_MINUTES * MINUTE_MS) minutes.delete(key);
    }
    return bucket;
  };
  const slotOf = (start: number) => {
    let bucket = slots.get(start);
    if (!bucket) {
      bucket = { start, paths: new Map(), docs: new Map(), keys: 0, overflow: new Set() };
      slots.set(start, bucket);
      for (const key of slots.keys()) if (key <= start - KEEP_SLOTS * SLOT_MS) slots.delete(key);
    }
    return bucket;
  };
  const bump = (slot: SlotBucket, kind: 'paths' | 'docs', ns: string, key: string) => {
    let counts = slot[kind].get(ns);
    if (!counts) {
      counts = new Map();
      slot[kind].set(ns, counts);
    }
    const current = counts.get(key);
    if (current !== undefined) counts.set(key, current + 1);
    else if (slot.keys < MAX_KEYS_PER_SLOT) {
      counts.set(key, 1);
      slot.keys += 1;
    } else slot.overflow.add(ns);
  };

  const record = (change: LiveChange) => {
    if (!change.collection) return;
    const ns = nsOf(change.database, change.collection);
    const at = change.clusterTime;
    last.set(ns, { at, op: change.op });
    if (!COUNTED_OPS.has(change.op)) return;

    const minuteStart = Math.floor(at / MINUTE_MS) * MINUTE_MS;
    // 1시간보다 오래된 이벤트(이어 받기로 늦게 온 것 등)는 칸에 넣지 않는다
    if (minuteStart <= clock() - KEEP_MINUTES * MINUTE_MS) return;
    const minute = minuteOf(minuteStart);
    let ops = minute.byNs.get(ns);
    if (!ops) {
      // 컬렉션이 너무 많으면 새 컬렉션은 세지 않는다(대신 그 칸의 기존 컬렉션은 계속 센다)
      if (minute.byNs.size >= MAX_NS_PER_MINUTE) return;
      ops = emptyOps();
      minute.byNs.set(ns, ops);
    }
    ops[change.op as keyof ActivityOps] += 1;

    const slot = slotOf(Math.floor(at / SLOT_MS) * SLOT_MS);
    if (change.documentId) bump(slot, 'docs', ns, change.documentId.slice(0, MAX_KEY_LENGTH));
    if (change.op === 'update') {
      const paths = [
        ...Object.keys(change.updatedFields ?? {}),
        ...(change.removedFields ?? []),
        ...(change.truncatedArrays ?? []).map((t) => t.field),
      ];
      const seen = new Set<string>();
      for (const path of paths) {
        if (seen.size >= MAX_PATHS_PER_EVENT) break;
        const normalized = normalizePath(path);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        bump(slot, 'paths', ns, normalized);
      }
    }
  };

  const report = ({ database = null, collection = null, range }: ActivityQuery, now = clock()): ActivityReport => {
    const inScope = (ns: string) => {
      if (!database) return true;
      const [db, col] = splitNs(ns);
      return db === database && (!collection || col === collection);
    };
    const currentMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const count = RANGE_MS[range] / MINUTE_MS;
    // 범위의 분 칸들 — 세기 시작 전 칸은 빼고(모르는 구간을 0으로 그리지 않게)
    const firstMinute = Math.max(currentMinute - (count - 1) * MINUTE_MS, Math.floor(since / MINUTE_MS) * MINUTE_MS);
    const starts: number[] = [];
    for (let t = firstMinute; t <= currentMinute; t += MINUTE_MS) starts.push(t);

    const timeline = starts.map((at) => {
      const ops = emptyOps();
      minutes.get(at)?.byNs.forEach((o, ns) => inScope(ns) && addOps(ops, o));
      return { at, ops };
    });

    // 컬렉션별 합계·추세 — 범위 안에 쓰기가 있었거나 마지막 쓰기를 아는 컬렉션
    const rows = new Map<string, ActivityCollection>();
    const rowOf = (ns: string) => {
      let row = rows.get(ns);
      if (!row) {
        const [db, col] = splitNs(ns);
        row = { database: db, collection: col, total: 0, ops: emptyOps(), trend: starts.map(() => 0), lastWrite: last.get(ns) ?? null };
        rows.set(ns, row);
      }
      return row;
    };
    starts.forEach((at, i) => {
      minutes.get(at)?.byNs.forEach((ops, ns) => {
        if (!inScope(ns)) return;
        const row = rowOf(ns);
        addOps(row.ops, ops);
        row.trend[i] += sumOps(ops);
      });
    });
    for (const ns of last.keys()) if (inScope(ns)) rowOf(ns);
    const collections = [...rows.values()]
      .map((row) => ({ ...row, total: sumOps(row.ops) }))
      .sort((a, b) => b.total - a.total || (b.lastWrite?.at ?? 0) - (a.lastWrite?.at ?? 0))
      .slice(0, MAX_COLLECTIONS);

    const result: ActivityReport = { since, range, timeline, collections };
    if (database && collection) {
      const ns = nsOf(database, collection);
      // 범위에 걸치는 5분 칸들
      const fromSlot = Math.floor((now - RANGE_MS[range]) / SLOT_MS) * SLOT_MS;
      const fields = new Map<string, number>();
      const docs = new Map<string, number>();
      let partial = false;
      for (const slot of slots.values()) {
        if (slot.start < fromSlot) continue;
        slot.paths.get(ns)?.forEach((n, key) => fields.set(key, (fields.get(key) ?? 0) + n));
        slot.docs.get(ns)?.forEach((n, key) => docs.set(key, (docs.get(key) ?? 0) + n));
        if (slot.overflow.has(ns)) partial = true;
      }
      const top = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
      result.fields = top(fields).map(([path, n]) => ({ path, count: n }));
      result.documents = top(docs).map(([id, n]) => ({ id, count: n }));
      if (partial) result.partial = true;
    }
    return result;
  };

  return {
    record,
    report,
    lastWrites: () => Object.fromEntries(last),
    minuteWrites: (start) => {
      const byNs = minutes.get(start)?.byNs;
      // 복사본 — 나중에 도착한 이벤트가 이미 넘긴 값을 바꾸지 않게
      return byNs ? new Map([...byNs].map(([ns, ops]) => [ns, { ...ops }])) : undefined;
    },
    since,
  };
};
