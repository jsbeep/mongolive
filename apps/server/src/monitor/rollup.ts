// 지표 롤업 — 10초 칸 → 1분 → 1시간 → 1일로 합치는 계산 (9-3, 파일 읽기·쓰기 없는 순수 함수)
//
// 한 기록(Rollup) = 그 구간의 지표마다 합(s) · 개수(c) · 최대(x).
//   평균 = s ÷ c (읽을 때 계산). 합·개수를 들고 있어서 1분 → 1시간으로 합쳐도 평균이 정확하고,
//   최대값을 따로 들고 있어서 시·일 단위로 합쳐도 순간 급증이 묻히지 않는다.
// 컬렉션별 쓰기 수(w)는 상위 N개만(분 50 · 시 100 · 일 200) — 컬렉션이 많아도 한 줄이 커지지 않게.
import { MONITOR_METRIC_KEYS, type ActivityOps, type MonitorMetricKey, type MonitorSample } from '@mongolive/shared';

// 지표 이름 — 파일에 그대로 들어간다(사람이 열어 봐도 알 수 있게). 목록은 shared(화면도 같은 이름을 쓴다)
export const METRIC_KEYS = MONITOR_METRIC_KEYS;
export type MetricKey = MonitorMetricKey;
type Metrics = Partial<Record<MetricKey, number>>;

export interface Rollup {
  // 구간 시작(ms)
  t: number;
  // 들어간 10초 칸 수(얼마나 덮었나 — 1분이면 최대 6)
  n: number;
  s: Metrics;
  c: Metrics;
  x: Metrics;
  // "db.collection" → 쓰기 수
  w?: Record<string, ActivityOps>;
}

export const TOP_WRITES = { minute: 50, hour: 100, day: 200 } as const;

// 10초 칸 하나 → 지표 값(못 잰 지표는 없음)
export const valuesOf = (sample: MonitorSample, intervalSec: number): Metrics => {
  const v: Metrics = {};
  const put = (key: MetricKey, value: number | null | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value)) v[key] = value;
  };
  const r = sample.rates;
  if (r) {
    put('insert', r.ops.insert);
    put('query', r.ops.query);
    put('update', r.ops.update);
    put('delete', r.ops.delete);
    put('getmore', r.ops.getmore);
    put('command', r.ops.command);
    put('returned', r.docs.returned);
    put('inserted', r.docs.inserted);
    put('updated', r.docs.updated);
    put('deleted', r.docs.deleted);
    put('latReads', r.latencyMs.reads);
    put('latWrites', r.latencyMs.writes);
    put('latCommands', r.latencyMs.commands);
    put('scannedKeys', r.scannedKeys);
    put('scannedDocs', r.scannedDocs);
    put('collScans', r.collectionScans);
    put('newConns', r.newConnections);
    put('asserts', r.asserts.regular + r.asserts.warning + r.asserts.msg + r.asserts.user);
    put('userAsserts', r.asserts.user);
    put('netIn', r.network.inBps);
    put('netOut', r.network.outBps);
  }
  put('conns', sample.gauges?.connections?.current);
  put('memMb', sample.gauges?.memResidentMb);
  put('ping', sample.pingMs);
  put('lag', sample.stream.lagP95Ms);
  if (sample.problem !== 'unreachable') put('events', sample.stream.events / intervalSec);
  return v;
};

const round = (value: number) => Math.round(value * 1000) / 1000;

export const emptyRollup = (t: number): Rollup => ({ t, n: 0, s: {}, c: {}, x: {} });

export const addSample = (into: Rollup, sample: MonitorSample, intervalSec: number): void => {
  into.n += 1;
  const values = valuesOf(sample, intervalSec);
  for (const key of Object.keys(values) as MetricKey[]) {
    const value = values[key] as number;
    into.s[key] = round((into.s[key] ?? 0) + value);
    into.c[key] = (into.c[key] ?? 0) + 1;
    into.x[key] = Math.max(into.x[key] ?? -Infinity, value);
  }
};

const addOps = (a: ActivityOps, b: ActivityOps): ActivityOps => ({
  insert: a.insert + b.insert,
  update: a.update + b.update,
  replace: a.replace + b.replace,
  delete: a.delete + b.delete,
});
const total = (ops: ActivityOps) => ops.insert + ops.update + ops.replace + ops.delete;

// 쓰기 수 많은 상위 n개만
export const topWrites = (writes: Map<string, ActivityOps> | Record<string, ActivityOps>, n: number): Record<string, ActivityOps> | undefined => {
  const entries = writes instanceof Map ? [...writes.entries()] : Object.entries(writes);
  const kept = entries.filter(([, ops]) => total(ops) > 0).sort((a, b) => total(b[1]) - total(a[1])).slice(0, n);
  return kept.length ? Object.fromEntries(kept) : undefined;
};

// 여러 기록 → 하나(1분들 → 1시간, 1시간들 → 1일)
export const mergeRollups = (t: number, records: Rollup[], topN: number): Rollup => {
  const out = emptyRollup(t);
  const writes = new Map<string, ActivityOps>();
  for (const r of records) {
    out.n += r.n;
    for (const key of Object.keys(r.s) as MetricKey[]) out.s[key] = round((out.s[key] ?? 0) + (r.s[key] ?? 0));
    for (const key of Object.keys(r.c) as MetricKey[]) out.c[key] = (out.c[key] ?? 0) + (r.c[key] ?? 0);
    for (const key of Object.keys(r.x) as MetricKey[]) out.x[key] = Math.max(out.x[key] ?? -Infinity, r.x[key] ?? -Infinity);
    for (const [ns, ops] of Object.entries(r.w ?? {})) writes.set(ns, addOps(writes.get(ns) ?? { insert: 0, update: 0, replace: 0, delete: 0 }, ops));
  }
  const w = topWrites(writes, topN);
  if (w) out.w = w;
  return out;
};

export const average = (r: Rollup, key: MetricKey): number | null => {
  const c = r.c[key];
  return c ? (r.s[key] ?? 0) / c : null;
};

// ── 시간 칸(서버의 시간대 기준 — 하루는 그 시간대의 자정부터) ──

export const MINUTE_MS = 60_000;
export const minuteStart = (t: number) => Math.floor(t / MINUTE_MS) * MINUTE_MS;
export const hourStart = (t: number) => {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};
export const nextHour = (h: number) => {
  const d = new Date(h);
  d.setHours(d.getHours() + 1);
  return d.getTime();
};
export const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
export const nextDay = (day: number) => {
  const d = new Date(day);
  d.setDate(d.getDate() + 1);
  return d.getTime();
};
const pad = (n: number) => String(n).padStart(2, '0');
export const dateKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const monthKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
export const yearKey = (t: number) => String(new Date(t).getFullYear());
