// Monitor 기록 파일 (9-3) — ~/.mongolive/metrics/<연결 id>/<서버 신분>/
//
//   minutes-YYYY-MM-DD.jsonl   1분 기록(한 줄 = Rollup). 보관 기간(설정 › Monitor: 2·7·14일)이 지난 날짜 파일은 통째로 지운다
//   hours-YYYY-MM.jsonl        1시간 기록. 보관 기간(설정 › Monitor: 30일·90일·1년)이 지난 달 파일을 통째로 지운다
//   days-YYYY.jsonl            1일 기록. 지우지 않는다(하루 한 줄)
//   gaps.jsonl                 기록하지 않던 구간 — MongoDB가 그사이 재시작하지 않았으면 그동안의 합계(누적값 차이)
//   state.json                 어디까지 합쳤나 + 마지막 누적값(다음에 빈 구간을 계산할 재료)
//                              + changeStream 위치와 아직 안 불러온 빈 구간 목록(9-4)
//   fills.jsonl                빈 구간 중 쓰기를 다시 불러온 부분(9-4)
//   slow-YYYY-MM-DD.jsonl      느린 쿼리(9-5b) — 분·모양·걸린 시간 구간마다 한 줄. 시 기록과 같은 보관 기간이 지나면 통째로 지운다
//   sizes-YYYY-MM-DD.jsonl     컬렉션 크기(9-6a) — 측정마다 한 줄. 파일 첫 줄은 전부(full), 그다음은 바뀐 컬렉션만. 보관은 slow와 같다
//   alerts-YYYY-MM-DD.jsonl    끝난 알림(9-8a) — 한 건에 한 줄, 끝난 날짜의 파일에. 보관은 slow와 같다
//
// 디스크 한도(C1, 설정 › Monitor › Disk limit) — 정리할 때 연결 폴더 전체(옛 서버 포함)가 한도를 넘으면
//   오래된 slow·sizes·alerts 날짜 파일 → 오래된 분 파일 → 시·일 파일 순서로 지운다. 오늘·이번 달·올해 파일과 최근 이틀 분 파일은 남긴다.
//   지웠으면 state.json의 trimmed에 남긴다(설정 창이 보여 준다).
// 파일은 다시 쓰지 않는다 — 덧붙이기와 통째 삭제만(SD카드 쓰기를 줄이려고). state.json만 임시 파일 → 이름 바꾸기로 교체.
// 파일 작업은 한 줄로 세운다(queue) — 덧붙이기·합치기·지우기가 서로 끼어들지 않게.
// 시·일 경계는 서버의 시간대 기준. 피드가 닫혀 있던 동안 끝난 시·일은 다음에 피드가 열릴 때 따라잡아 합친다.
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HISTORY_BUDGET_BYTES, MINUTE_HISTORY_DAYS, MONITOR_HISTORY_DAYS, type ActivityOps, type HistoryFill, type HistoryBudget, type HistoryInfo, type MinuteHistory, type MonitorAlert, type MonitorHistory, type MonitorOp, type MonitorSample } from '@mongolive/shared';
import { metricsDirPath } from '../paths';
import {
  addSample,
  dateKey,
  dayStart,
  emptyRollup,
  hourStart,
  mergeRollups,
  minuteStart,
  monthKey,
  nextDay,
  nextHour,
  topWrites,
  TOP_WRITES,
  yearKey,
  type Rollup,
} from './rollup';
import type { StatusCounters } from './serverStatus';
import type { SizesLine, SizeTuple } from './sizes';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// 따라잡기 한도 — 닫혀 있던 동안 끝난 시간은 이틀까지만 합친다(분 보관 기간과 따로: 최소 보관이 2일이라 그 안의 분은 늘 있다)
const CATCH_UP_HOURS_MS = 2 * DAY_MS;
const CATCH_UP_DAYS_MS = 35 * DAY_MS;

export interface GapRecord {
  from: number;
  to: number;
  // MongoDB가 그사이 재시작했다 — 합계를 알 수 없다
  restarted: boolean;
  ops?: Record<MonitorOp, number>;
  docs?: { inserted: number; updated: number; deleted: number; returned: number };
}

// changeStream 위치 — token이 있으면 그 뒤부터(resumeAfter), 없으면 ts부터(startAtOperationTime)
export interface ResumePoint {
  token?: { _data: string };
  // 클러스터 시각(Timestamp의 초·증가값)
  ts: { t: number; i: number };
  // 그 위치의 시각(ms)
  at: number;
}

// 아직 다 불러오지 않은 빈 구간(9-4) — 실시간을 안 받던 from부터 다시 받기 시작한 to까지
export interface StoredGap {
  id: string;
  from: ResumePoint;
  to: ResumePoint;
  // 불러온 데까지(멈췄다 이어 받기)
  progress: ResumePoint | null;
  loaded: number;
  partialFrom?: number;
  // 닫힐 때의 누적값 — 이벤트 수 추정(serverStatus 차이)
  before: { at: number; counters: StatusCounters } | null;
  // 사람이 멈춤 — 다음에 열려도 자동으로 다시 시작하지 않는다
  paused?: boolean;
  // 처음 잰 이벤트 수(구간 전체) — 누적값 차이는 그때만 낼 수 있어서 남겨 둔다
  estimated?: { events: number | null; source: 'counters' | 'oplog' | null };
}

// 빈 구간 목록 최대 길이 — 넘으면 가장 오래된 것을 '못 불러옴'으로 넘긴다
const MAX_GAPS = 20;

const compareTs = (a: { t: number; i: number }, b: { t: number; i: number }) => a.t - b.t || a.i - b.i;

interface StateFile {
  version: 1;
  // 합쳐 둔 마지막 시·일의 시작 시각
  rolledHour: number | null;
  rolledDay: number | null;
  // 마지막으로 본 누적값 — 다음에 열릴 때 빈 구간의 합계를 낸다
  last: { at: number; counters: StatusCounters } | null;
  // 실시간 스트림이 마지막으로 받은 위치 — 다음에 열릴 때 그 사이가 빈 구간
  resume: ResumePoint | null;
  gaps: StoredGap[];
  // 느린 쿼리를 파일에 적은 마지막 로그 시각 — 다음에 열려 서버 로그를 다시 읽을 때 그 뒤만 받는다(9-5b)
  slowCursor?: number | null;
  // 디스크 한도 때문에 마지막으로 지운 때와 크기(C1)
  trimmed?: { at: number; bytes: number } | null;
}

const emptyState = (): StateFile => ({ version: 1, rolledHour: null, rolledDay: null, last: null, resume: null, gaps: [], slowCursor: null });

// 연결 id는 UUID나 'env' — 그래도 경로에 쓰기 전에 거른다
const connectionDir = (connectionId: string) => join(metricsDirPath(), connectionId.replace(/[^A-Za-z0-9_-]/g, '_'));

// 그 연결의 그 서버 기록 폴더(monitor/historyRead가 읽는다)
export const serverHistoryDir = (connectionId: string, fingerprint: string) => join(connectionDir(connectionId), fingerprint);

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const readJsonl = async <T>(file: string): Promise<T[]> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 쓰다가 꺼져서 잘린 줄 — 그 줄만 버린다
    }
  }
  return out;
};

// 파싱한 날짜 파일 — 오늘·어제처럼 자꾸 다시 읽는 몇 개만(크기·수정 시각이 같으면 그대로)
const dayFileCache = new Map<string, { size: number; mtime: number; lines: unknown[] }>();
const DAY_FILE_CACHE_MAX = 6;

// <prefix>-YYYY-MM-DD.jsonl 중 from이 든 날짜부터(null = 전부) 날짜 순서대로 모든 줄
export const readDayFiles = async <T>(dir: string, prefix: 'slow' | 'sizes' | 'alerts', from: number | null): Promise<T[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const pattern = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
  const fromKey = from === null ? null : dateKey(from);
  const out: T[] = [];
  for (const name of names.sort()) {
    const m = pattern.exec(name);
    if (!m || (fromKey !== null && m[1] < fromKey)) continue;
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    const hit = dayFileCache.get(file);
    let lines: unknown[];
    if (hit && hit.size === info.size && hit.mtime === info.mtimeMs) {
      lines = hit.lines;
    } else {
      lines = await readJsonl<unknown>(file);
      dayFileCache.delete(file);
      dayFileCache.set(file, { size: info.size, mtime: info.mtimeMs, lines });
      while (dayFileCache.size > DAY_FILE_CACHE_MAX) dayFileCache.delete(dayFileCache.keys().next().value as string);
    }
    // 큰 배열은 펼쳐 넣지 않는다(인자 수 한도)
    for (const line of lines) out.push(line as T);
  }
  return out;
};

const appendLine = (file: string, value: unknown) => appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');

const loadState = async (dir: string): Promise<StateFile> => {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as Partial<StateFile>;
    return { ...emptyState(), ...raw, gaps: Array.isArray(raw.gaps) ? raw.gaps : [], version: 1 };
  } catch {
    return emptyState();
  }
};

const saveState = async (dir: string, state: StateFile) => {
  const tmp = join(dir, 'state.json.tmp');
  await writeFile(tmp, JSON.stringify(state), 'utf8');
  await rename(tmp, join(dir, 'state.json'));
};

// 누적값 차이 = 기록하지 않던 동안의 합계. 재시작했으면(uptime이 흐른 시간만큼 늘지 않음) 합계 없이
export const gapBetween = (last: { at: number; counters: StatusCounters }, counters: StatusCounters, at: number): GapRecord => {
  const expected = last.counters.uptimeMs + (at - last.at);
  const base = { from: last.at, to: at };
  if (Math.abs(counters.uptimeMs - expected) > 120_000) return { ...base, restarted: true };
  const ops = Object.fromEntries(
    (Object.keys(counters.ops) as MonitorOp[]).map((op) => [op, counters.ops[op] - last.counters.ops[op]]),
  ) as Record<MonitorOp, number>;
  const docs = {
    inserted: counters.docs.inserted - last.counters.docs.inserted,
    updated: counters.docs.updated - last.counters.docs.updated,
    deleted: counters.docs.deleted - last.counters.docs.deleted,
    returned: counters.docs.returned - last.counters.docs.returned,
  };
  if ([...Object.values(ops), ...Object.values(docs)].some((n) => n < 0)) return { ...base, restarted: true };
  return { ...base, restarted: false, ops, docs };
};

export interface RecorderHooks {
  connectionId: string;
  // 서버 신분(monitor/identity) — 실패하면 그 분은 건너뛰고 다음 분에 다시
  fingerprint: () => Promise<string>;
  // 그 1분 동안 changeStream으로 본 컬렉션별 쓰기(monitor/activity)
  minuteWrites: (start: number) => Map<string, ActivityOps> | undefined;
  retention: () => MonitorHistory;
  // 1분 기록 보관(없으면 2일)·디스크 한도(없으면 끔) — C1
  minuteRetention?: () => MinuteHistory;
  budget?: () => HistoryBudget;
  // 연결이 아직 있는가 — 지운 연결의 폴더를 다시 만들지 않게
  alive: () => boolean;
  intervalSec: number;
  clock?: () => number;
}

export interface Recorder {
  addSample: (sample: MonitorSample) => void;
  // serverStatus의 누적값(샘플러가 읽을 때마다) — 빈 구간 계산용
  addCounters: (counters: StatusCounters, at: number) => void;
  // 지금 1분을 적고 멈춘다(피드가 닫힐 때)
  stop: () => Promise<void>;
  // 다른 서버일 수 있다(주소가 바뀜) — 적고 나서 신분부터 다시
  reset: () => Promise<void>;
  // 이 연결의 기록을 모두 지운다(설정 › Monitor)
  clear: () => Promise<void>;
  // ── 빈 구간 불러오기(9-4) ──
  // 실시간 스트림의 지금 위치(이벤트·하트비트마다) — 1분 기록 때와 닫힐 때 state.json에 남긴다
  noteResume: (point: ResumePoint) => void;
  // 실시간을 새로 받기 시작함(t0) — 지난번 위치가 있으면 그 사이를 빈 구간 목록에 넣는다
  openGap: (t0: ResumePoint) => Promise<void>;
  gaps: () => StoredGap[];
  updateGap: (id: string, patch: Partial<StoredGap>) => Promise<void>;
  // 불러온 분별 컬렉션 쓰기를 알맞은 기록 파일에 덧붙이고 진행 위치를 남긴다
  writeFill: (id: string, minutes: Map<number, Map<string, ActivityOps>>, patch: Partial<StoredGap>) => Promise<void>;
  // 다 불러왔거나 잃음 — 목록에서 빼고 fills.jsonl에 남긴다
  finishGap: (id: string, fill: HistoryFill) => Promise<void>;
  // 지금 누적값(샘플러가 마지막으로 읽은 것)
  latestCounters: () => { at: number; counters: StatusCounters } | null;
  currentFingerprint: () => string | null;
  // ── 느린 쿼리(9-5b) ──
  // 지난번에 적은 마지막 로그 시각(기록이 꺼져 있거나 폴더를 못 정하면 null)
  slowCursor: () => Promise<number | null>;
  // 줄을 그 날짜의 slow 파일에 덧붙이고 커서를 남긴다
  appendSlow: (lines: { t: number }[], cursor: number | null) => Promise<void>;
  // ── 컬렉션 크기(9-6a) ──
  // 측정 한 번을 그 날짜의 sizes 파일에 — 파일이 새로 생기면 full, 아니면 changes(null = 처음이라 full)
  appendSizes: (t: number, full: Record<string, SizeTuple>, changes: Record<string, SizeTuple | null> | null) => Promise<void>;
  // ── 알림(9-8a) ──
  // 끝난 알림을 끝난 날짜의 alerts 파일에(범위 읽기가 끝난 시각으로 날짜 파일을 고르므로)
  appendAlerts: (alerts: MonitorAlert[]) => Promise<void>;
  // 줄 서 있는 파일 작업이 끝날 때까지(테스트)
  idle: () => Promise<void>;
}

export const createRecorder = (hooks: RecorderHooks): Recorder => {
  const clock = hooks.clock ?? Date.now;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((e) => console.error(`[monitor] ${hooks.connectionId} 기록 실패:`, errorMessage(e)));
    return queue;
  };

  let dir: string | null = null;
  let fingerprint: string | null = null;
  let state = emptyState();
  let current: Rollup | null = null;
  let latest: { at: number; counters: StatusCounters } | null = null;
  // 이번에 열린 뒤 처음 본 누적값인가 — 그때 지난번과 비교해 빈 구간을 남긴다
  let firstCounters = true;
  // 실시간 스트림의 지금 위치(메모리) — 1분 기록 때 state.resume으로
  let liveResume: ResumePoint | null = null;
  // 폴더를 정할 때 파일에서 읽은 지난번 위치·누적값 — openGap이 한 번 쓴다(그 전에 1분 기록이 state를 덮어도 남게)
  let closed: { resume: ResumePoint | null; last: StateFile['last'] } | null = null;

  const enabled = () => hooks.retention() !== 'off';

  // 폴더 정하기(신분 묻기) — 줄 선 작업 안에서만 부른다
  const resolveDir = async (): Promise<string | null> => {
    if (dir) return dir;
    if (!hooks.alive()) return null;
    try {
      fingerprint = await hooks.fingerprint();
    } catch {
      return null;
    }
    const next = join(connectionDir(hooks.connectionId), fingerprint);
    await mkdir(next, { recursive: true });
    dir = next;
    state = await loadState(next);
    closed = { resume: state.resume, last: state.last };
    // 닫혀 있던 동안 끝난 시·일은 첫 1분을 적은 뒤 flushMinute의 rollUp이 따라잡는다 —
    // 여기서 먼저 합치면 방금 끝난 시간을 그 마지막 1분을 적기 전에 '합쳤음'으로 표시해 버린다
    return dir;
  };

  // upTo = 방금 적은 1분의 시각. 그보다 앞의 시·일만 '끝났다'고 본다 — 시계가 아니라 적은 기록 기준이라
  // 그 시간의 분이 다 적힌 뒤에만 합친다(닫혀 있던 동안 끝난 시간은 다음 첫 1분이 적힐 때 따라잡는다)
  const rollUp = async (upTo: number) => {
    if (!dir) return;
    const now = upTo;
    let changed = false;
    // 시: 끝난 시간마다 그 시간의 분 기록을 합친다
    const minuteFiles = new Map<string, Rollup[]>();
    const minutesOf = async (h: number) => {
      const key = dateKey(h);
      if (!minuteFiles.has(key)) minuteFiles.set(key, await readJsonl<Rollup>(join(dir as string, `minutes-${key}.jsonl`)));
      return minuteFiles.get(key) as Rollup[];
    };
    const currentHour = hourStart(now);
    let h = state.rolledHour !== null ? nextHour(state.rolledHour) : hourStart(now - CATCH_UP_HOURS_MS);
    h = Math.max(h, hourStart(now - CATCH_UP_HOURS_MS));
    for (; h < currentHour; h = nextHour(h)) {
      const end = nextHour(h);
      const inHour = (await minutesOf(h)).filter((r) => r.t >= h && r.t < end);
      if (inHour.length) await appendLine(join(dir, `hours-${monthKey(h)}.jsonl`), mergeRollups(h, inHour, TOP_WRITES.hour));
      state.rolledHour = h;
      changed = true;
    }
    // 일: 끝난 날마다 그날의 시 기록을 합친다(그날의 시는 위에서 이미 다 합쳤다)
    const hourFiles = new Map<string, Rollup[]>();
    const hoursOf = async (d: number) => {
      const key = monthKey(d);
      if (!hourFiles.has(key)) hourFiles.set(key, await readJsonl<Rollup>(join(dir as string, `hours-${key}.jsonl`)));
      return hourFiles.get(key) as Rollup[];
    };
    const currentDay = dayStart(now);
    let d = state.rolledDay !== null ? nextDay(state.rolledDay) : dayStart(now - CATCH_UP_DAYS_MS);
    d = Math.max(d, dayStart(now - CATCH_UP_DAYS_MS));
    for (; d < currentDay; d = nextDay(d)) {
      const end = nextDay(d);
      const inDay = (await hoursOf(d)).filter((r) => r.t >= d && r.t < end);
      if (inDay.length) await appendLine(join(dir, `days-${yearKey(d)}.jsonl`), mergeRollups(d, inDay, TOP_WRITES.day));
      state.rolledDay = d;
      changed = true;
    }
    // 시가 끝났거나(1시간마다) 보관·한도 설정이 바뀌었으면 정리한다 — 열린 뒤 첫 1분에도(설정 키가 아직 없으니)
    if (changed || pruneKey() !== prunedWith) await prune(clock());
  };

  const minuteDays = () => MINUTE_HISTORY_DAYS[hooks.minuteRetention?.() ?? '2d'];
  const budgetOf = () => hooks.budget?.() ?? 'off';
  const pruneKey = () => `${hooks.retention()}|${minuteDays()}|${budgetOf()}`;
  // 마지막으로 정리할 때의 설정(바뀌면 다음 1분 기록 때 다시 정리)
  let prunedWith: string | null = null;

  // 보관 기간이 지난 파일을 통째로 지운다
  const prune = async (now: number) => {
    if (!dir || !enabled()) return;
    prunedWith = pruneKey();
    const retention = hooks.retention();
    const keepHoursMs = retention === 'off' ? Infinity : MONITOR_HISTORY_DAYS[retention] * DAY_MS;
    const oldestMinuteKey = dateKey(now - minuteDays() * DAY_MS);
    for (const name of await readdir(dir)) {
      const minute = /^minutes-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (minute && minute[1] < oldestMinuteKey) await rm(join(dir, name), { force: true });
      const slow = /^(?:slow|sizes|alerts)-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
      if (slow) {
        // 그날의 마지막 순간(다음 날 0시)이 보관 기간보다 오래됐으면
        const dayEnd = new Date(Number(slow[1]), Number(slow[2]) - 1, Number(slow[3]) + 1).getTime();
        if (dayEnd < now - keepHoursMs) await rm(join(dir, name), { force: true });
      }
      const hour = /^hours-(\d{4})-(\d{2})\.jsonl$/.exec(name);
      if (hour) {
        // 그달의 마지막 순간(다음 달 1일)이 보관 기간보다 오래됐으면
        const monthEnd = new Date(Number(hour[1]), Number(hour[2]), 1).getTime();
        if (monthEnd < now - keepHoursMs) await rm(join(dir, name), { force: true });
      }
    }
    const budget = budgetOf();
    if (budget !== 'off') {
      const bytes = await trimToBudget(connectionDir(hooks.connectionId), HISTORY_BUDGET_BYTES[budget], now);
      if (bytes > 0) {
        state.trimmed = { at: now, bytes };
        console.warn(`[monitor] ${hooks.connectionId} 디스크 한도(${budget})를 넘어 오래된 기록 ${bytes} B를 지웠다`);
      }
    }
  };

  // writes = 그 1분의 컬렉션별 쓰기(줄 세울 때 미리 받아 둔다 — 주소가 바뀌면 집계가 곧바로 새로 시작하므로)
  const flushMinute = async (minute: Rollup, writes: Map<string, ActivityOps> | undefined) => {
    if (!enabled()) return;
    const target = await resolveDir();
    if (!target || !hooks.alive()) return;
    const w = topWrites(writes ?? new Map<string, ActivityOps>(), TOP_WRITES.minute);
    await appendLine(join(target, `minutes-${dateKey(minute.t)}.jsonl`), w ? { ...minute, w } : minute);
    if (latest) state.last = latest;
    if (liveResume) state.resume = liveResume;
    await rollUp(minute.t);
    await saveState(target, state);
  };

  // 불러온 쓰기를 기록 파일에 덧붙인다(9-4). 단계마다 따로 정한다:
  //   그 시·일을 나중에 rollUp이 합칠 예정이면 → 아래 단계에만(합칠 때 같이 들어간다)
  //   이미 합쳤거나 따라잡기 한도 밖이면 → 그 단계 파일에도 한 줄 더(읽을 때 같은 칸끼리 더한다)
  // 줄 선 작업 안에서만 부른다 — rollUp과 엇갈리지 않게
  const appendFill = async (target: string, minutes: Map<number, Map<string, ActivityOps>>) => {
    const now = clock();
    // 한도 경계는 1시간·1일 여유를 둔다(지금 판단한 뒤 다음 rollUp 전에 한도 밖으로 밀려나지 않게)
    const hourWillRoll = (h: number) => (state.rolledHour === null || h > state.rolledHour) && h >= nextHour(hourStart(now - CATCH_UP_HOURS_MS));
    const dayWillRoll = (d: number) => (state.rolledDay === null || d > state.rolledDay) && d >= nextDay(dayStart(now - CATCH_UP_DAYS_MS));
    const retention = hooks.retention();
    const keepHoursFrom = retention === 'off' ? Infinity : now - MONITOR_HISTORY_DAYS[retention] * DAY_MS;
    const keepMinutesKey = dateKey(now - minuteDays() * DAY_MS);
    const hours = new Map<number, Map<string, ActivityOps>>();
    const days = new Map<number, Map<string, ActivityOps>>();
    const add = (into: Map<number, Map<string, ActivityOps>>, t: number, writes: Map<string, ActivityOps>) => {
      let sum = into.get(t);
      if (!sum) {
        sum = new Map();
        into.set(t, sum);
      }
      for (const [ns, ops] of writes) {
        const prev = sum.get(ns);
        sum.set(ns, prev ? { insert: prev.insert + ops.insert, update: prev.update + ops.update, replace: prev.replace + ops.replace, delete: prev.delete + ops.delete } : { ...ops });
      }
    };
    for (const [m, writes] of [...minutes].sort((a, b) => a[0] - b[0])) {
      const w = topWrites(writes, TOP_WRITES.minute);
      if (!w) continue;
      if (dateKey(m) >= keepMinutesKey) await appendLine(join(target, `minutes-${dateKey(m)}.jsonl`), { ...emptyRollup(m), w });
      const h = hourStart(m);
      if (!hourWillRoll(h) && h >= keepHoursFrom) add(hours, h, writes);
      const d = dayStart(m);
      if (!dayWillRoll(d)) add(days, d, writes);
    }
    for (const [h, writes] of hours) {
      const w = topWrites(writes, TOP_WRITES.hour);
      if (w) await appendLine(join(target, `hours-${monthKey(h)}.jsonl`), { ...emptyRollup(h), w });
    }
    for (const [d, writes] of days) {
      const w = topWrites(writes, TOP_WRITES.day);
      if (w) await appendLine(join(target, `days-${yearKey(d)}.jsonl`), { ...emptyRollup(d), w });
    }
  };

  // 빈 구간 작업 — 기록을 꺼 뒀거나 폴더를 못 정했으면 아무것도 안 한다
  const withGap = (id: string, task: (target: string, gap: StoredGap) => Promise<void>) =>
    enqueue(async () => {
      if (!enabled() || !hooks.alive()) return;
      const target = await resolveDir();
      const gap = state.gaps.find((g) => g.id === id);
      if (!target || !gap) return;
      await task(target, gap);
      await saveState(target, state);
    });

  const stop = () => {
    const done = current;
    current = null;
    if (done && done.n > 0) {
      const writes = hooks.minuteWrites(done.t);
      void enqueue(() => flushMinute(done, writes));
    }
    return enqueue(async () => {
      if (dir && (latest || liveResume) && hooks.alive()) {
        if (latest) state.last = latest;
        if (liveResume) state.resume = liveResume;
        await saveState(dir, state);
      }
    });
  };

  return {
    addSample(sample) {
      if (!enabled()) {
        current = null;
        return;
      }
      const start = minuteStart(sample.at);
      if (current && current.t !== start) {
        const done = current;
        const writes = hooks.minuteWrites(done.t);
        void enqueue(() => flushMinute(done, writes));
        current = null;
      }
      current ??= emptyRollup(start);
      addSample(current, sample, hooks.intervalSec);
    },
    addCounters(counters, at) {
      latest = { at, counters };
      if (!firstCounters || !enabled()) return;
      firstCounters = false;
      void enqueue(async () => {
        const target = await resolveDir();
        if (!target) return;
        const last = state.last;
        // 10초 칸 3개 넘게 비었으면 빈 구간
        if (last && at - last.at > hooks.intervalSec * 3 * 1000) {
          await appendLine(join(target, 'gaps.jsonl'), gapBetween(last, counters, at));
        }
        state.last = latest;
        await saveState(target, state);
      });
    },
    stop,
    async reset() {
      await stop();
      await enqueue(async () => {
        dir = null;
        fingerprint = null;
        state = emptyState();
        latest = null;
        firstCounters = true;
        liveResume = null;
        closed = null;
      });
    },
    clear() {
      current = null;
      return enqueue(async () => {
        await rm(connectionDir(hooks.connectionId), { recursive: true, force: true });
        dir = null;
        fingerprint = null;
        state = emptyState();
        // 지운 직후의 누적값과 비교할 '지난번'이 없으니 빈 구간을 만들지 않는다
        firstCounters = false;
        closed = null;
      });
    },
    noteResume(point) {
      liveResume = point;
    },
    openGap(t0) {
      return enqueue(async () => {
        if (!enabled()) return;
        const target = await resolveDir();
        if (!target || !hooks.alive()) return;
        const prev = closed?.resume ?? null;
        const before = closed?.last ?? null;
        closed = null;
        if (prev && t0.at - prev.at >= 1000 && compareTs(prev.ts, t0.ts) < 0) {
          state.gaps.push({ id: `${prev.at}-${t0.at}`, from: prev, to: t0, progress: null, loaded: 0, before });
          while (state.gaps.length > MAX_GAPS) {
            const dropped = state.gaps.shift() as StoredGap;
            const fill: HistoryFill = { from: dropped.from.at, to: dropped.to.at, events: dropped.loaded, lost: dropped.loaded === 0 };
            await appendLine(join(target, 'fills.jsonl'), fill);
          }
        }
        state.resume = liveResume ?? t0;
        await saveState(target, state);
      });
    },
    gaps: () => state.gaps.map((g) => ({ ...g })),
    updateGap(id, patch) {
      return withGap(id, async (_target, gap) => {
        Object.assign(gap, patch);
      });
    },
    writeFill(id, minutes, patch) {
      return withGap(id, async (target, gap) => {
        await appendFill(target, minutes);
        Object.assign(gap, patch);
      });
    },
    finishGap(id, fill) {
      return withGap(id, async (target) => {
        state.gaps = state.gaps.filter((g) => g.id !== id);
        await appendLine(join(target, 'fills.jsonl'), fill);
      });
    },
    slowCursor() {
      let cursor: number | null = null;
      return enqueue(async () => {
        if (!enabled() || !(await resolveDir())) return;
        cursor = state.slowCursor ?? null;
      }).then(() => cursor);
    },
    appendSlow(lines, cursor) {
      return enqueue(async () => {
        if (!enabled() || !hooks.alive()) return;
        const target = await resolveDir();
        if (!target) return;
        const byDay = new Map<string, { t: number }[]>();
        for (const line of lines) {
          const key = dateKey(line.t);
          byDay.set(key, [...(byDay.get(key) ?? []), line]);
        }
        for (const [key, dayLines] of byDay) {
          await appendFile(join(target, `slow-${key}.jsonl`), dayLines.map((l) => `${JSON.stringify(l)}\n`).join(''), 'utf8');
        }
        if (cursor !== null && cursor > (state.slowCursor ?? 0)) {
          state.slowCursor = cursor;
          await saveState(target, state);
        }
      });
    },
    appendSizes(t, full, changes) {
      return enqueue(async () => {
        if (!enabled() || !hooks.alive()) return;
        const target = await resolveDir();
        if (!target) return;
        const file = join(target, `sizes-${dateKey(t)}.jsonl`);
        // 날짜가 바뀌었거나 기록을 지웠으면 새 파일 — 첫 줄은 전부 적어 그 파일만 읽어도 되게
        const fresh = changes === null || !(await stat(file).then(() => true, () => false));
        const line: SizesLine = fresh ? { t, full: true, c: full } : { t, c: changes };
        await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');
      });
    },
    appendAlerts(alerts) {
      return enqueue(async () => {
        if (!enabled() || !hooks.alive()) return;
        const target = await resolveDir();
        if (!target) return;
        const byDay = new Map<string, MonitorAlert[]>();
        for (const alert of alerts) {
          const key = dateKey(alert.end);
          byDay.set(key, [...(byDay.get(key) ?? []), alert]);
        }
        for (const [key, dayAlerts] of byDay) {
          await appendFile(join(target, `alerts-${key}.jsonl`), dayAlerts.map((a) => `${JSON.stringify(a)}\n`).join(''), 'utf8');
        }
      });
    },
    latestCounters: () => latest,
    currentFingerprint: () => fingerprint,
    idle: () => queue,
  };
};

// ── 연결 단위 관리 ──

// 한도를 넘는 동안 지울 파일 순서 — 낮은 단계부터, 같은 단계 안에서는 끝 시각이 이른 것부터.
// 지우지 않는 것: 오늘의 날짜 파일, 오늘·어제의 분 파일(24시간 차트), 이번 달 시 파일, 올해 일 파일, state·gaps·fills
const trimOrder = (name: string, now: number): { tier: number; end: number } | null => {
  const day = /^(slow|sizes|alerts|minutes)-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
  if (day) {
    const end = new Date(Number(day[2]), Number(day[3]) - 1, Number(day[4]) + 1).getTime();
    if (day[1] === 'minutes') return end <= dayStart(now) - DAY_MS ? { tier: 1, end } : null;
    return end <= dayStart(now) ? { tier: 0, end } : null;
  }
  const hour = /^hours-(\d{4})-(\d{2})\.jsonl$/.exec(name);
  if (hour) {
    const end = new Date(Number(hour[1]), Number(hour[2]), 1).getTime();
    return end <= now ? { tier: 2, end } : null;
  }
  const year = /^days-(\d{4})\.jsonl$/.exec(name);
  if (year) {
    const end = new Date(Number(year[1]) + 1, 0, 1).getTime();
    return end <= now ? { tier: 2, end } : null;
  }
  return null;
};

// 연결 폴더(모든 서버)가 limit 바이트 아래가 될 때까지 오래된 기록을 지운다 — 지운 바이트
export const trimToBudget = async (root: string, limit: number, now: number): Promise<number> => {
  const files: { path: string; size: number; tier: number; end: number }[] = [];
  let total = 0;
  for (const server of await readdir(root).catch(() => [] as string[])) {
    const serverDir = join(root, server);
    const names = await readdir(serverDir).catch(() => null);
    if (!names) continue;
    for (const name of names) {
      const info = await stat(join(serverDir, name)).catch(() => null);
      if (!info?.isFile()) continue;
      total += info.size;
      const order = trimOrder(name, now);
      if (order) files.push({ path: join(serverDir, name), size: info.size, ...order });
    }
  }
  if (total <= limit) return 0;
  files.sort((a, b) => a.tier - b.tier || a.end - b.end);
  let freed = 0;
  for (const file of files) {
    if (total - freed <= limit) break;
    await rm(file.path, { force: true });
    freed += file.size;
  }
  return freed;
};

// 연결을 지웠을 때 — 그 연결의 기록 폴더 전체(옛 서버 것까지)
export const dropConnectionHistory = (connectionId: string) => rm(connectionDir(connectionId), { recursive: true, force: true });

// 파일 첫 줄의 t — 가장 오래된 기록 시각을 찾는 데만 쓴다(통째로 읽지 않는다)
const firstRecordTime = async (file: string): Promise<number | null> => {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    const t = (JSON.parse(line) as { t?: unknown }).t;
    return typeof t === 'number' ? t : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
};

export const historyInfo = async (connectionId: string, current: string | null): Promise<HistoryInfo> => {
  const root = connectionDir(connectionId);
  let bytes = 0;
  let servers = 0;
  let oldest: number | null = null;
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return { bytes: 0, servers: 0, oldest: null, current, trimmed: null };
  }
  let trimmed: HistoryInfo['trimmed'] = null;
  for (const server of entries) {
    const serverDir = join(root, server);
    if (!(await stat(serverDir)).isDirectory()) continue;
    servers += 1;
    const state = await loadState(serverDir);
    if (state.trimmed && (!trimmed || state.trimmed.at > trimmed.at)) trimmed = state.trimmed;
    for (const name of await readdir(serverDir)) {
      const file = join(serverDir, name);
      bytes += (await stat(file)).size;
      if (/^(minutes|hours|days)-/.test(name)) {
        const t = await firstRecordTime(file);
        if (t !== null && (oldest === null || t < oldest)) oldest = t;
      }
    }
  }
  return { bytes, servers, oldest, current, trimmed };
};
