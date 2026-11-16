// 기록 파일 읽기 — Monitor의 긴 기간(9-3b)
//
// 기간마다 읽는 파일과 한 칸의 길이(화면의 점이 400개를 넘지 않게):
//   24h → 분 기록을 5분 칸으로   7d → 시 기록 그대로   30d → 시 기록을 2시간 칸으로   90d → 6시간 칸으로   all → 일 기록
// 아직 합치지 않은 최근 기록도 넣는다: 시 기록 뒤쪽은 분 기록에서, 일 기록 뒤쪽은 시·분 기록에서(지금 시간·오늘이 빠지지 않게).
// 칸은 서버 시간대 기준(2시간 칸 = 자정부터 2시간씩).
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ActivityOps, HistoryFill, HistoryGap, HistoryPoint, HistoryReport, MonitorRange } from '@mongolive/shared';
import { readJsonl, serverHistoryDir } from './history';
import { average, dayStart, hourStart, MINUTE_MS, mergeRollups, METRIC_KEYS, nextDay, nextHour, TOP_WRITES, type Rollup } from './rollup';

const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const TOP_COLLECTIONS = 50;

type FileRange = Exclude<MonitorRange, '5m' | '1h'>;
const PLAN: Record<FileRange, { spanMs: number | null; bucketMs: number; from: 'minutes' | 'hours' | 'days' }> = {
  '24h': { spanMs: DAY_MS, bucketMs: 5 * MINUTE_MS, from: 'minutes' },
  '7d': { spanMs: 7 * DAY_MS, bucketMs: HOUR_MS, from: 'hours' },
  '30d': { spanMs: 30 * DAY_MS, bucketMs: 2 * HOUR_MS, from: 'hours' },
  '90d': { spanMs: 90 * DAY_MS, bucketMs: 6 * HOUR_MS, from: 'hours' },
  all: { spanMs: null, bucketMs: DAY_MS, from: 'days' },
};
export const isFileRange = (range: string): range is FileRange => range in PLAN;

// 칸 시작 — 분 단위 칸은 그대로 나누고, 시·일 단위는 서버 시간대의 시각에 맞춘다
const bucketOf = (t: number, bucketMs: number): number => {
  if (bucketMs < HOUR_MS) return Math.floor(t / bucketMs) * bucketMs;
  if (bucketMs >= DAY_MS) return dayStart(t);
  const d = new Date(hourStart(t));
  const step = bucketMs / HOUR_MS;
  d.setHours(d.getHours() - (d.getHours() % step));
  return d.getTime();
};

const readAll = async (dir: string, prefix: 'minutes' | 'hours' | 'days'): Promise<Rollup[]> => {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.jsonl')).sort();
  const out: Rollup[] = [];
  for (const name of files) out.push(...(await readJsonl<Rollup>(join(dir, name))));
  return out.sort((a, b) => a.t - b.t);
};

// 그 단계 기록이 덮는 끝 — 그 뒤는 아래 단계(더 잘게 나뉜) 기록에서 가져온다
const coverEnd = (records: Rollup[], next: (t: number) => number): number | null =>
  records.length ? next(records[records.length - 1].t) : null;

const sumOps = (o: ActivityOps) => o.insert + o.update + o.replace + o.delete;
const addOps = (a: ActivityOps, b: ActivityOps): ActivityOps => ({ insert: a.insert + b.insert, update: a.update + b.update, replace: a.replace + b.replace, delete: a.delete + b.delete });

export interface HistoryQuery {
  range: FileRange;
  writes?: boolean;
  database?: string | null;
  collection?: string | null;
}

export const readHistory = async (connectionId: string, fingerprint: string, query: HistoryQuery, now = Date.now()): Promise<HistoryReport> => {
  const plan = PLAN[query.range];
  const dir = serverHistoryDir(connectionId, fingerprint);
  const from = plan.spanMs === null ? 0 : now - plan.spanMs;

  // 원본 기록 모으기 — 큰 단위 기록 + 아직 합치지 않은 뒤쪽은 작은 단위에서
  let records: Rollup[] = [];
  const minutes = () => readAll(dir, 'minutes');
  if (plan.from === 'minutes') {
    records = await minutes();
  } else {
    const hours = await readAll(dir, 'hours');
    const days = plan.from === 'days' ? await readAll(dir, 'days') : [];
    const dayEnd = coverEnd(days, nextDay);
    const hoursAfter = dayEnd === null ? hours : hours.filter((r) => r.t >= dayEnd);
    const hourEnd = coverEnd(hours, nextHour) ?? dayEnd;
    const minutesAfter = (await minutes()).filter((r) => hourEnd === null || r.t >= hourEnd);
    records = [...days, ...hoursAfter, ...minutesAfter];
  }
  records = records.filter((r) => r.t + plan.bucketMs > from && r.t <= now);

  // 칸으로 묶기
  const groups = new Map<number, Rollup[]>();
  for (const r of records) {
    const key = bucketOf(r.t, plan.bucketMs);
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

  const gaps = (await readJsonl<HistoryGap>(join(dir, 'gaps.jsonl'))).filter((g) => g.to > from && g.from <= now);
  const fills = (await readJsonl<HistoryFill>(join(dir, 'fills.jsonl'))).filter((f) => f.to > from && f.from <= now);

  const report: HistoryReport = {
    range: query.range,
    bucketMs: plan.bucketMs,
    from: plan.spanMs === null ? (points[0]?.t ?? now) : from,
    to: now,
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
