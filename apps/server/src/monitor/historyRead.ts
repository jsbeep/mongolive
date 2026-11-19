// 기록 파일 읽기 — Monitor의 긴 기간(9-3b)과 날짜로 찾기(C2)
//
// 기간마다 읽는 파일과 한 칸의 길이(화면의 점이 400개를 넘지 않게):
//   6h → 분 기록 그대로   12h → 2분 칸으로   24h → 5분 칸으로   7d → 시 기록 그대로   30d → 시 기록을 2시간 칸으로   90d → 6시간 칸으로   all → 일 기록
// 날짜로 찾기(구간 [from, to])는 STEPS 중 점이 360개 이하가 되는 가장 짧은 칸 — 1시간 아래면 분 기록, 1일 아래면 시 기록, 그 위는 일 기록.
//   그 시각의 분 기록이 이미 지워졌으면(보관 2·7·14일, 디스크 한도) 시 기록으로, 시 기록도 없으면 일 기록으로 굵게(coarse).
// 아직 합치지 않은 최근 기록도 넣는다: 시 기록 뒤쪽은 분 기록에서, 일 기록 뒤쪽은 시·분 기록에서(지금 시간·오늘이 빠지지 않게).
// 칸은 서버 시간대 기준(2시간 칸 = 자정부터 2시간씩).
// 파일은 기간과 겹치는 것만 연다(분 = 날짜, 시 = 달, 일 = 해 — 파일 이름의 키로 고른다).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActivityOps, HistoryFill, HistoryGap, HistoryPoint, HistoryRange, HistoryReport, MonitorWindow } from '@mongolive/shared';
import { readJsonl, serverHistoryDir } from './history';
import { average, dateKey, dayStart, hourStart, MINUTE_MS, mergeRollups, METRIC_KEYS, monthKey, nextDay, nextHour, TOP_WRITES, yearKey, type Rollup } from './rollup';

const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const TOP_COLLECTIONS = 50;

type FileRange = HistoryRange;
type Tier = 'minutes' | 'hours' | 'days';
const PLAN: Record<FileRange, { spanMs: number | null; bucketMs: number; from: Tier }> = {
  '6h': { spanMs: 6 * HOUR_MS, bucketMs: MINUTE_MS, from: 'minutes' },
  '12h': { spanMs: 12 * HOUR_MS, bucketMs: 2 * MINUTE_MS, from: 'minutes' },
  '24h': { spanMs: DAY_MS, bucketMs: 5 * MINUTE_MS, from: 'minutes' },
  '7d': { spanMs: 7 * DAY_MS, bucketMs: HOUR_MS, from: 'hours' },
  '30d': { spanMs: 30 * DAY_MS, bucketMs: 2 * HOUR_MS, from: 'hours' },
  '90d': { spanMs: 90 * DAY_MS, bucketMs: 6 * HOUR_MS, from: 'hours' },
  all: { spanMs: null, bucketMs: DAY_MS, from: 'days' },
};
export const isFileRange = (range: string): range is FileRange => Object.hasOwn(PLAN, range);

// 날짜로 찾기의 칸 후보(짧은 것부터)
const STEPS = [...[1, 2, 5, 10, 15, 30].map((m) => m * MINUTE_MS), ...[1, 2, 3, 6, 12].map((h) => h * HOUR_MS), DAY_MS];
const MAX_POINTS = 360;
export const pickStep = (spanMs: number): number => STEPS.find((step) => Math.ceil(spanMs / step) <= MAX_POINTS) ?? DAY_MS;
// 각 단계 기록 한 줄의 길이 = 그 단계로 읽을 때 가장 짧은 칸
const TIER_MS: Record<Tier, number> = { minutes: MINUTE_MS, hours: HOUR_MS, days: DAY_MS };
const tierOfStep = (step: number): Tier => (step < HOUR_MS ? 'minutes' : step < DAY_MS ? 'hours' : 'days');
const COARSER: Record<Tier, Tier[]> = { minutes: ['hours', 'days'], hours: ['days'], days: [] };

// 칸 시작 — 분 단위 칸은 그대로 나누고, 시·일 단위는 서버 시간대의 시각에 맞춘다
const bucketOf = (t: number, bucketMs: number): number => {
  if (bucketMs < HOUR_MS) return Math.floor(t / bucketMs) * bucketMs;
  if (bucketMs >= DAY_MS) return dayStart(t);
  const d = new Date(hourStart(t));
  const step = bucketMs / HOUR_MS;
  d.setHours(d.getHours() - (d.getHours() % step));
  return d.getTime();
};

const FILE_KEY = { minutes: dateKey, hours: monthKey, days: yearKey } as const;
// 파일 이름 키가 덮는 처음(서버 시간대의 그날 0시·그달 1일·그해 1월 1일)
const KEY_START: Record<Tier, (key: string) => number> = {
  minutes: (k) => new Date(`${k}T00:00:00`).getTime(),
  hours: (k) => new Date(`${k}-01T00:00:00`).getTime(),
  days: (k) => new Date(`${k}-01-01T00:00:00`).getTime(),
};
const fileKeys = (names: string[], prefix: Tier): string[] =>
  names.filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.jsonl')).map((n) => n.slice(prefix.length + 1, -6)).sort();

// 그 단계의 파일 중 [from, to]와 겹치는 날짜·달·해만(from 0 = 처음부터) — 키가 YYYY-MM-DD·YYYY-MM·YYYY라 문자열 비교로 고른다
export const readAll = async (dir: string, prefix: Tier, from = 0, to = Infinity): Promise<Rollup[]> => {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const fromKey = from > 0 ? FILE_KEY[prefix](from) : '';
  const toKey = Number.isFinite(to) ? FILE_KEY[prefix](to) : null;
  const keys = fileKeys(names, prefix).filter((k) => k >= fromKey && (toKey === null || k <= toKey));
  const out: Rollup[] = [];
  for (const key of keys) out.push(...(await readJsonl<Rollup>(join(dir, `${prefix}-${key}.jsonl`))));
  return out.sort((a, b) => a.t - b.t);
};

// 그 단계 기록이 덮는 끝 — 그 뒤는 아래 단계(더 잘게 나뉜) 기록에서 가져온다
const coverEnd = (records: Rollup[], next: (t: number) => number): number | null =>
  records.length ? next(records[records.length - 1].t) : null;

const sumOps = (o: ActivityOps) => o.insert + o.update + o.replace + o.delete;
const addOps = (a: ActivityOps, b: ActivityOps): ActivityOps => ({ insert: a.insert + b.insert, update: a.update + b.update, replace: a.replace + b.replace, delete: a.delete + b.delete });

export interface HistoryQuery {
  // 이름 붙은 기간 또는 날짜로 찾기의 구간(checkWindow를 거친 것)
  range: FileRange | MonitorWindow;
  writes?: boolean;
  database?: string | null;
  collection?: string | null;
}

// 그 단계부터 [from, to]의 원본 기록 — 큰 단위 기록 + 아직 합치지 않은 뒤쪽은 작은 단위에서
const collect = async (dir: string, tier: Tier, from: number, to: number): Promise<Rollup[]> => {
  if (tier === 'minutes') return readAll(dir, 'minutes', from, to);
  const days = tier === 'days' ? await readAll(dir, 'days', from, to) : [];
  const dayEnd = coverEnd(days, nextDay);
  const hours = await readAll(dir, 'hours', Math.max(from, dayEnd ?? 0), to);
  const hoursAfter = dayEnd === null ? hours : hours.filter((r) => r.t >= dayEnd);
  const hourEnd = coverEnd(hours, nextHour) ?? dayEnd;
  const minutesAfter = (await readAll(dir, 'minutes', Math.max(from, hourEnd ?? 0), to)).filter((r) => hourEnd === null || r.t >= hourEnd);
  return [...days, ...hoursAfter, ...minutesAfter];
};

// 날짜로 찾기 — 칸이 원하는 단계의 기록이 from부터 있나. 없으면(지워짐) 그 앞 구간을 굵은 단계가 갖고 있을 때만 굵은 단계로
// (그 앞에 아무 기록도 없으면 — 기록을 그 뒤에 시작했으면 — 잘게 그대로)
const pickTier = async (dir: string, want: Tier, from: number, to: number): Promise<Tier> => {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return want;
  }
  let tier = want;
  while (COARSER[tier].length) {
    const oldest = fileKeys(names, tier)[0];
    const start = oldest === undefined ? Infinity : KEY_START[tier](oldest);
    if (start <= from) return tier;
    const until = Math.min(start, to);
    let older = false;
    for (const coarser of COARSER[tier]) {
      older = (await readAll(dir, coarser, from, until)).some((r) => r.t + TIER_MS[coarser] > from && r.t < until);
      if (older) break;
    }
    if (!older) return tier;
    tier = COARSER[tier][0];
  }
  return tier;
};

export const readHistory = async (connectionId: string, fingerprint: string, query: HistoryQuery, now = Date.now()): Promise<HistoryReport> => {
  const dir = serverHistoryDir(connectionId, fingerprint);
  let from: number;
  let to: number;
  let bucketMs: number;
  let coarse = false;
  let records: Rollup[];
  if (typeof query.range === 'object') {
    ({ from, to } = query.range);
    const ideal = pickStep(to - from);
    const tier = await pickTier(dir, tierOfStep(ideal), from, to);
    bucketMs = Math.max(ideal, TIER_MS[tier]);
    coarse = bucketMs > ideal;
    records = await collect(dir, tier, from, to);
  } else {
    const plan = PLAN[query.range];
    from = plan.spanMs === null ? 0 : now - plan.spanMs;
    to = now;
    bucketMs = plan.bucketMs;
    records = await collect(dir, plan.from, from, to);
  }
  records = records.filter((r) => r.t + bucketMs > from && r.t <= to);

  // 칸으로 묶기
  const groups = new Map<number, Rollup[]>();
  for (const r of records) {
    const key = bucketOf(r.t, bucketMs);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const merged = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([t, list]) => mergeRollups(t, list, TOP_WRITES.day));
  const points: HistoryPoint[] = merged.map((r) => {
    const avg: HistoryPoint['avg'] = {};
    const max: HistoryPoint['max'] = {};
    for (const key of METRIC_KEYS) {
      const a = average(r, key);
      if (a !== null) avg[key] = Math.round(a * 1000) / 1000;
      if (r.x[key] !== undefined) max[key] = r.x[key];
    }
    return { t: r.t, n: r.n, avg, max };
  });

  const gaps = (await readJsonl<HistoryGap>(join(dir, 'gaps.jsonl'))).filter((g) => g.to > from && g.from <= to);
  const fills = (await readJsonl<HistoryFill>(join(dir, 'fills.jsonl'))).filter((f) => f.to > from && f.from <= to);

  const report: HistoryReport = {
    range: typeof query.range === 'object' ? 'custom' : query.range,
    bucketMs,
    ...(coarse ? { coarse: true as const } : {}),
    from: query.range === 'all' ? (points[0]?.t ?? now) : from,
    to,
    points,
    gaps,
    ...(fills.length ? { fills } : {}),
    ready: true,
  };

  if (query.writes) {
    const inScope = (ns: string) => {
      if (!query.database) return true;
      const dot = ns.indexOf('.');
      return ns.slice(0, dot) === query.database && (!query.collection || ns.slice(dot + 1) === query.collection);
    };
    const totals = new Map<string, ActivityOps>();
    for (const r of merged) {
      for (const [ns, ops] of Object.entries(r.w ?? {})) {
        if (inScope(ns)) totals.set(ns, addOps(totals.get(ns) ?? { insert: 0, update: 0, replace: 0, delete: 0 }, ops));
      }
    }
    report.collections = [...totals.entries()]
      .sort((a, b) => sumOps(b[1]) - sumOps(a[1]))
      .slice(0, TOP_COLLECTIONS)
      .map(([ns, ops]) => {
        const dot = ns.indexOf('.');
        return {
          database: ns.slice(0, dot),
          collection: ns.slice(dot + 1),
          total: sumOps(ops),
          ops,
          trend: merged.map((r) => (r.w?.[ns] ? sumOps(r.w[ns]) : 0)),
        };
      });
  }
  return report;
};
