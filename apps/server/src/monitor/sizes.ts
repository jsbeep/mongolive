// 컬렉션 크기 (9-6a) — Monitor › Collections의 Docs·Size·Index 칸과 Storage 카드
//
// 피드를 열 때 한 번, 그 뒤 1시간마다 모든 컬렉션에 $collStats(storageStats)를 묻는다(사용자 DB만, system.* 빼고).
// 하나씩 차례로, 각각 5초 제한 — 컬렉션이 많아도 MongoDB에 한꺼번에 몰리지 않게. 샘플러 박자에 '때가 됐나'만 본다(기다리지 않는다).
// 기록이 켜져 있으면 sizes-날짜.jsonl에 측정마다 한 줄(파일 첫 줄은 전부, 그다음은 바뀐 컬렉션만 — monitor/history appendSizes).
// 읽을 때는 기간 시작이 든 날짜 파일부터 차례로 되살려(replay) 추이와 기간 첫 측정(Δ의 기준)을 낸다.
import type { MongoClient } from 'mongodb';
import type { MonitorRange, SizeStats, SizesReport } from '@mongolive/shared';
import { HIDDEN_DATABASES, isHiddenCollection } from '../names';
import { readDayFiles, serverHistoryDir, type Recorder } from './history';
import { isUnauthorized, type OperationsScope } from './operations';
import { withTimeout } from './sampler';
import { RANGE_MS } from './slowQueries';

export const SIZE_INTERVAL_MS = 60 * 60_000;
// 지금 재기 버튼 — 이보다 자주는 안 잰다
const MANUAL_MIN_MS = 30_000;
// 추이 점이 이보다 많으면 시간 칸마다 마지막 점만
const MAX_TREND_POINTS = 400;
const DAY_MS = 86_400_000;

// [문서 수, 데이터 크기, 디스크 크기, 인덱스 크기] — 파일에 짧게 남기려고 배열
export type SizeTuple = [number, number, number, number];
// 측정 한 번. c의 키 = "db.collection"(DB 이름엔 점이 없다), null = 그사이 없어짐
export interface SizesLine {
  t: number;
  full?: true;
  c: Record<string, SizeTuple | null>;
}

const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0) || 0);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const stats = (t: SizeTuple): SizeStats => ({ count: t[0], size: t[1], storage: t[2], index: t[3] });
const zero = (): SizeStats => ({ count: 0, size: 0, storage: 0, index: 0 });
const addInto = (into: SizeStats, t: SizeTuple) => {
  into.count += t[0];
  into.size += t[1];
  into.storage += t[2];
  into.index += t[3];
};

export const dbOf = (key: string) => key.slice(0, key.indexOf('.'));
export const inScope = (key: string, scope: OperationsScope) =>
  scope.database === null || (scope.collection === null ? dbOf(key) === scope.database : key === `${scope.database}.${scope.collection}`);

// 컬렉션 하나 — 샤드 클러스터면 샤드마다 한 문서가 와서 더한다. WiredTiger 세부(수십 KB)는 서버에서 잘라 보낸다
const PROJECT = { _id: 0, 'storageStats.count': 1, 'storageStats.size': 1, 'storageStats.storageSize': 1, 'storageStats.totalIndexSize': 1 };
const collectionSize = async (client: MongoClient, database: string, collection: string): Promise<SizeTuple> => {
  const docs = await withTimeout(
    client.db(database).collection(collection).aggregate([{ $collStats: { storageStats: {} } }, { $project: PROJECT }], { maxTimeMS: 5000 }).toArray(),
  );
  const out: SizeTuple = [0, 0, 0, 0];
  for (const doc of docs) {
    const s = (doc as { storageStats?: Record<string, unknown> }).storageStats ?? {};
    out[0] += num(s.count);
    out[1] += num(s.size);
    out[2] += num(s.storageSize);
    out[3] += num(s.totalIndexSize);
  }
  return out;
};

// 서버 전체를 한 번 잰다. 컬렉션 하나가 실패하면 지난번 값을 그대로 둔다(없으면 뺀다). 전부 권한 없음이면 던진다
export const measureSizes = async (client: MongoClient, previous: Map<string, SizeTuple> | null, cancelled: () => boolean): Promise<Map<string, SizeTuple>> => {
  const { databases } = await withTimeout(client.db('admin').admin().listDatabases({ nameOnly: true }));
  const out = new Map<string, SizeTuple>();
  let tried = 0;
  let denied: unknown = null;
  for (const { name: database } of [...databases].sort((a, b) => a.name.localeCompare(b.name))) {
    if (HIDDEN_DATABASES.has(database)) continue;
    if (cancelled()) return out;
    const infos = await withTimeout(client.db(database).listCollections({}, { nameOnly: false }).toArray()).catch(() => []);
    const names = infos
      .filter((c) => (c.type === 'collection' || c.type === 'timeseries') && !isHiddenCollection(c.name))
      .map((c) => c.name)
      .sort();
    for (const collection of names) {
      if (cancelled()) return out;
      const key = `${database}.${collection}`;
      tried += 1;
      try {
        out.set(key, await collectionSize(client, database, collection));
      } catch (e) {
        if (isUnauthorized(e)) denied = e;
        const before = previous?.get(key);
        if (before) out.set(key, before);
      }
    }
  }
  if (denied && out.size === 0 && tried > 0) throw denied;
  return out;
};

// 지난번 적은 것과 다른 컬렉션만(없어진 건 null)
export const sizeChanges = (before: Map<string, SizeTuple>, after: Map<string, SizeTuple>): Record<string, SizeTuple | null> => {
  const out: Record<string, SizeTuple | null> = {};
  for (const [key, value] of after) {
    const old = before.get(key);
    if (!old || old.some((v, i) => v !== value[i])) out[key] = value;
  }
  for (const key of before.keys()) if (!after.has(key)) out[key] = null;
  return out;
};

// 파일 줄(시각 순) + 지금 메모리 값 → 보고서의 rows·합계·기준·추이
export const summarizeSizes = (
  lines: SizesLine[],
  opts: { from: number | null; scope: OperationsScope; latest: { at: number; map: Map<string, SizeTuple> } | null; history: boolean },
): Pick<SizesReport, 'at' | 'rows' | 'total' | 'baseAt' | 'baseTotal' | 'trend'> => {
  let state = new Map<string, SizeTuple>();
  let lastAt: number | null = null;
  let base: Map<string, SizeTuple> | null = null;
  let baseAt: number | null = null;
  let trend: SizesReport['trend'] = [];
  for (const line of lines) {
    if (line.full) state = new Map(Object.entries(line.c).filter((e): e is [string, SizeTuple] => e[1] !== null));
    else for (const [key, value] of Object.entries(line.c)) value === null ? state.delete(key) : state.set(key, value);
    lastAt = line.t;
    if (opts.from !== null && line.t < opts.from) continue;
    if (!base) {
      base = new Map(state);
      baseAt = line.t;
    }
    const total = zero();
    for (const [key, value] of state) if (inScope(key, opts.scope)) addInto(total, value);
    trend.push({ t: line.t, ...total });
  }

  // 추이가 길면(몇 달) 시간 칸마다 마지막 점만
  if (trend.length > MAX_TREND_POINTS) {
    const first = trend[0].t;
    const width = (trend[trend.length - 1].t - first) / MAX_TREND_POINTS || 1;
    const kept = new Map<number, (typeof trend)[number]>();
    for (const point of trend) kept.set(Math.floor((point.t - first) / width), point);
    trend = [...kept.values()];
  }

  const current = opts.latest ?? (lastAt !== null && state.size ? { at: lastAt, map: state } : null);
  const rows: SizesReport['rows'] = [];
  const total = zero();
  const baseTotal = zero();
  for (const [key, value] of current?.map ?? []) {
    if (!inScope(key, opts.scope)) continue;
    const before = opts.history ? base?.get(key) : undefined;
    rows.push({ database: dbOf(key), collection: key.slice(key.indexOf('.') + 1), ...stats(value), base: before ? stats(before) : null });
    addInto(total, value);
  }
  if (opts.history && base) for (const [key, value] of base) if (inScope(key, opts.scope)) addInto(baseTotal, value);
  const withBase = opts.history && base !== null;
  return {
    at: current?.at ?? null,
    rows,
    total,
    baseAt: withBase ? baseAt : null,
    baseTotal: withBase ? baseTotal : null,
    trend: opts.history ? trend : [],
  };
};

export interface SizesHooks {
  connectionId: string;
  client: () => Promise<MongoClient>;
  recorder: () => Recorder;
  // 기록 파일에 남기는가(설정 › Monitor 기록이 켜져 있음)
  stored: () => boolean;
  clock?: () => number;
}

export interface Sizes {
  // 샘플러 박자마다 — 때가 됐으면 재기 시작(기다리지 않는다)
  tick: () => void;
  // 지금 재기(버튼). 재는 중이거나 30초 안에 쟀으면 false
  measureNow: () => boolean;
  // 피드가 닫힘 — 재는 중이면 다음 컬렉션 앞에서 그만둔다(기록하지 않는다)
  stop: () => void;
  // 주소가 바뀜(다른 서버일 수 있다) — 지난 값을 버리고 다음 박자에 다시 잰다
  reset: () => void;
  report: (query: { range: MonitorRange; scope: OperationsScope }) => Promise<SizesReport>;
}

export const createSizes = (hooks: SizesHooks): Sizes => {
  const clock = hooks.clock ?? Date.now;
  let latest: Map<string, SizeTuple> | null = null;
  let at: number | null = null;
  // 기록 파일이 지금 담고 있는 값(바뀐 것만 적으려고). 기록이 꺼져 있었으면 null → 다음엔 전부
  let written: Map<string, SizeTuple> | null = null;
  let measuring = false;
  let error: string | null = null;
  let nextAt = 0;
  let generation = 0;

  const sweep = async (gen: number) => {
    measuring = true;
    try {
      const map = await measureSizes(await hooks.client(), latest, () => gen !== generation);
      if (gen !== generation) return;
      latest = map;
      at = clock();
      error = null;
      if (hooks.stored()) {
        // 같은 동기 구간에서 줄을 세운다 — stop() 뒤 기록기가 닫히기 전에 들어간다
        void hooks.recorder().appendSizes(at, Object.fromEntries(map), written ? sizeChanges(written, map) : null);
        written = map;
      } else written = null;
    } catch (e) {
      if (gen !== generation) return;
      error = isUnauthorized(e) ? 'Not allowed to read collection stats — the user needs the collStats action (e.g. the read role)' : errorMessage(e);
    } finally {
      if (gen === generation) {
        measuring = false;
        nextAt = clock() + SIZE_INTERVAL_MS;
      }
    }
  };

  return {
    tick() {
      if (measuring || clock() < nextAt) return;
      void sweep(generation);
    },
    measureNow() {
      if (measuring || (at !== null && clock() - at < MANUAL_MIN_MS)) return false;
      void sweep(generation);
      return true;
    },
    stop() {
      generation += 1;
      measuring = false;
    },
    reset() {
      generation += 1;
      latest = null;
      at = null;
      written = null;
      measuring = false;
      error = null;
      nextAt = 0;
    },
    async report({ range, scope }) {
      const now = clock();
      const span = RANGE_MS[range];
      const live = range === '5m' || range === '1h';
      const stored = hooks.stored();
      const from = span === null ? null : now - span;
      let lines: SizesLine[] = [];
      // 실시간 기간은 추이·Δ가 없다(1시간마다 재므로) — 아직 못 쟀을 때만 파일의 마지막 값을 빌린다
      if (stored && (!live || latest === null)) {
        const fingerprint = hooks.recorder().currentFingerprint();
        if (fingerprint) lines = await readDayFiles<SizesLine>(serverHistoryDir(hooks.connectionId, fingerprint), 'sizes', live ? now - 2 * DAY_MS : from);
      }
      const summary = summarizeSizes(lines, { from: live ? null : from, scope, latest: latest && at !== null ? { at, map: latest } : null, history: stored && !live });
      return { status: error ? 'error' : 'ok', error, measuring, stored, ...summary };
    },
  };
};
