// Monitor › Operations › 느린 쿼리 (9-5b)
//
// MongoDB는 slowms(기본 100ms)보다 오래 걸린 작업을 자기 로그에 "Slow query"(id 51803)로 남긴다. 우리는 그걸 읽기만 한다
// (slowms·프로파일러는 바꾸지 않는다 — zero-footprint). 샘플러가 10초마다 getLog:'global'로 서버 로그의 최근 줄(약 1천 줄)을 받는다.
//
// 새 줄 가려내기: totalLinesWritten(서버가 켜진 뒤 쓴 줄 수)의 차이만큼이 새 줄. 차이가 받은 줄보다 많으면
//   그사이 넘어간 줄이 있다 → '놓쳤을 수 있음' 구간으로 남긴다. 처음 읽을 때는 지난번에 파일에 적은 마지막 시각(커서) 뒤만.
// 묶기: 분 × 쿼리 모양(queryHash, 없으면 명령의 모양) × 걸린 시간 구간(화면 필터 100ms·500ms·1s·5s)마다 한 줄 —
//   바쁜 서버에서도 줄 수가 모양 수 × 분으로 묶인다. 그 분에서 가장 느린 실행 하나를 예로 남긴다.
// 기록: 끝난 분만 slow-날짜.jsonl에 덧붙인다(monitor/history의 기록기 줄에 서서). 기록이 꺼져 있으면 메모리에 1시간만.
// 같은 수정·삭제는 로그에 두 번 남는다(문장마다 WRITE 줄 + 명령 전체 COMMAND 줄) — WRITE 줄이 있었으면 COMMAND 줄은 뺀다.
import { createHash } from 'node:crypto';
import { BSON, type Document as BsonDocument, type MongoClient } from 'mongodb';
import {
  SLOW_THRESHOLDS,
  valueKind,
  type EjsonObject,
  type MonitorRange,
  type RunningOpKind,
  type SlowGroup,
  type SlowLogStatus,
  type SlowMissed,
  type SlowQueriesReport,
  type SlowRun,
  type SlowThreshold,
} from '@mongolive/shared';
import { toWire } from '../wire';
import { readDayFiles, serverHistoryDir, type Recorder } from './history';
import { APP_NAME, cleanCommand, describeCommand, inScope, isUnauthorized, shortSummary, type OperationsScope } from './operations';
import { minuteStart } from './rollup';
import { SAMPLE_INTERVAL_MS, withTimeout } from './sampler';

const SLOW_QUERY_ID = 51803;
// 파일에 남기는 명령의 최대 길이(JSON) — 넘으면 요약만
const COMMAND_MAX = 4096;
const RUNS_PER_GROUP = 20;
const MAX_GROUPS = 200;
// 기록이 꺼져 있을 때 메모리에 두는 기간
const MEMORY_MS = 60 * 60 * 1000;
// 놓친 구간이 계속 이어지면 이만큼마다 끊어서 적는다
const MISSED_FLUSH_MS = 10 * 60 * 1000;
const SLOWMS_TTL_MS = 5 * 60 * 1000;
// 권한 없음·옛 버전이면 이만큼 뒤에 다시 물어본다(역할을 고쳤을 수 있다)
const RETRY_MS = 10 * 60 * 1000;

export const RANGE_MS: Record<MonitorRange, number | null> = {
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
  all: null,
};

// 로그 한 줄에서 꺼낸 한 번의 실행
export interface SlowEntry extends SlowRun {
  key: string;
  kind: RunningOpKind;
  ns: string;
  op: string;
  queryHash: string | null;
}

// slow 파일 한 줄 — 분(t)·모양(k)·걸린 시간 구간(b)마다. ex = 그 분에서 가장 느린 실행
export interface SlowBucketLine {
  t: number;
  k: string;
  b: number;
  kind: RunningOpKind;
  ns: string;
  op: string;
  h: string | null;
  n: number;
  sum: number;
  max: number;
  docs: number;
  keys: number;
  ret: number;
  last: number;
  ex: SlowRun;
}

// 못 본 줄이 있던 구간(t = 끝)
export interface SlowMissedLine {
  t: number;
  from: number;
  missed: number;
}

export type SlowLine = SlowBucketLine | SlowMissedLine;
const isMissed = (line: SlowLine): line is SlowMissedLine => 'missed' in line;

// 0: 100ms 미만(서버 slowms를 낮춰 둔 경우), 1: 100ms~, 2: 500ms~, 3: 1s~, 4: 5s~
export const bandOf = (ms: number): number => SLOW_THRESHOLDS.filter((t) => ms >= t).length;

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const plain = (value: unknown): BsonDocument | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as BsonDocument) : null;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 로그의 명령(relaxed EJSON) → 세션 정보를 뺀 Canonical EJSON. 못 바꾸면 그대로
const toCommand = (value: unknown): EjsonObject | null => {
  const cleaned = cleanCommand(value);
  if (!cleaned) return null;
  try {
    return toWire<EjsonObject>(BSON.EJSON.deserialize(cleaned, { relaxed: false }));
  } catch {
    return cleaned as EjsonObject;
  }
};

// 값은 버리고 모양만 — 배열은 원소마다(같은 모양이 이어지면 하나로: $in 길이가 달라도 같은 모양)
const shapeOf = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const shapes = value.map(shapeOf).map((s) => JSON.stringify(s));
    return shapes.filter((s, i) => i === 0 || s !== shapes[i - 1]);
  }
  if (valueKind(value) !== 'object') return '?';
  return Object.fromEntries(Object.entries(value as BsonDocument).map(([k, v]) => [k, shapeOf(v)]));
};

const shapeKey = (command: EjsonObject | null): string =>
  `s${createHash('sha1').update(JSON.stringify(shapeOf(command ?? {}))).digest('hex').slice(0, 10)}`;

const lineTime = (line: string | undefined): number | null => {
  if (!line) return null;
  const m = /^\{"t":\{"\$date":"([^"]+)"/.exec(line);
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
};

const kindOf = (app: string | null, client: string | null, ns: string, op: string): RunningOpKind => {
  if (app === APP_NAME) return 'mongolive';
  if (!client || ns.startsWith('local.') || op === 'hello' || op === 'isMaster' || op === 'ismaster') return 'system';
  return 'user';
};

// 한 줄 → 실행 하나(느린 쿼리 줄이 아니거나 뺄 줄이면 null).
// writes = 연결(ctx)마다 아직 COMMAND 줄이 안 온 WRITE 줄 수 — 줄을 읽는 동안 이어서 쓴다
export const parseSlowLine = (line: string, writes: Map<string, number>): SlowEntry | null => {
  if (!line.includes(`"id":${SLOW_QUERY_ID}`)) return null;
  let doc: BsonDocument;
  try {
    doc = JSON.parse(line) as BsonDocument;
  } catch {
    return null;
  }
  const attr = plain(doc.attr);
  if (doc.id !== SLOW_QUERY_ID || !attr) return null;
  const at = Date.parse(String(plain(doc.t)?.$date ?? ''));
  const ms = num(attr.durationMillis);
  let ns = str(attr.ns);
  if (!Number.isFinite(at) || ms === null || !ns) return null;
  const ctx = typeof doc.ctx === 'string' ? doc.ctx : '';
  const raw = plain(attr.command);

  let op: string;
  let command: EjsonObject | null;
  let summary: string;
  if (doc.c === 'WRITE') {
    // 수정·삭제의 한 문장 — 뒤따르는 같은 명령의 COMMAND 줄은 뺀다
    if (writes.size > 1000) writes.clear();
    writes.set(ctx, (writes.get(ctx) ?? 0) + 1);
    op = attr.type === 'remove' ? 'delete' : String(attr.type ?? 'write');
    command = toCommand(raw);
    const collection = ns.slice(ns.indexOf('.') + 1);
    summary =
      op === 'update' || op === 'delete'
        ? describeCommand({ [op]: collection, [op === 'update' ? 'updates' : 'deletes']: [command ?? {}] })
        : op;
  } else {
    const name = raw ? Object.keys(raw)[0] : undefined;
    const hadWrites = (writes.get(ctx) ?? 0) > 0;
    writes.delete(ctx);
    if ((name === 'update' || name === 'delete') && hadWrites) return null;
    op = name ?? String(attr.type ?? 'command');
    // 드라이버가 서버 소식을 기다리며 걸어 둔 hello(최대 10초) — 일이 아니라 대기라서 일찍 돌아오면 느리게 찍힌다
    if ((op === 'hello' || op === 'isMaster' || op === 'ismaster') && raw?.maxAwaitTimeMS !== undefined) return null;
    if (op === 'getMore') {
      command = toCommand(attr.originatingCommand);
      summary = command ? `getMore · ${describeCommand(command)}` : 'getMore';
    } else {
      command = toCommand(raw);
      summary = describeCommand(command);
    }
    // 명령 줄의 ns가 "db.$cmd"면 명령이 가리키는 컬렉션으로
    const target = name && raw ? raw[name] : undefined;
    if (ns.endsWith('.$cmd') && typeof target === 'string') ns = `${ns.slice(0, -'.$cmd'.length)}.${target}`;
  }

  const queryHash = str(attr.queryHash);
  const app = str(attr.appName);
  const client = str(attr.remote);
  const kind = kindOf(app, client, ns, op);
  summary = shortSummary(summary || op);
  const kept = command && JSON.stringify(command).length > COMMAND_MAX ? { $truncated: summary } : command;
  return {
    key: `${kind}|${ns}|${op}|${queryHash ?? shapeKey(command)}`,
    kind,
    ns,
    op,
    queryHash,
    at,
    ms,
    app,
    client,
    plan: str(attr.planSummary),
    docsExamined: num(attr.docsExamined),
    keysExamined: num(attr.keysExamined),
    returned: num(attr.nreturned) ?? num(attr.nMatched) ?? num(attr.ndeleted),
    summary,
    command: kept,
  };
};

const runOf = (e: SlowEntry): SlowRun => ({
  at: e.at,
  ms: e.ms,
  app: e.app,
  client: e.client,
  plan: e.plan,
  docsExamined: e.docsExamined,
  keysExamined: e.keysExamined,
  returned: e.returned,
  summary: e.summary,
  command: e.command,
});

export const addToBucket = (buckets: Map<string, SlowBucketLine>, e: SlowEntry) => {
  const t = minuteStart(e.at);
  const b = bandOf(e.ms);
  const id = `${t}|${e.key}|${b}`;
  const cur = buckets.get(id);
  if (!cur) {
    buckets.set(id, {
      t,
      k: e.key,
      b,
      kind: e.kind,
      ns: e.ns,
      op: e.op,
      h: e.queryHash,
      n: 1,
      sum: e.ms,
      max: e.ms,
      docs: e.docsExamined ?? 0,
      keys: e.keysExamined ?? 0,
      ret: e.returned ?? 0,
      last: e.at,
      ex: runOf(e),
    });
    return;
  }
  cur.n += 1;
  cur.sum += e.ms;
  cur.docs += e.docsExamined ?? 0;
  cur.keys += e.keysExamined ?? 0;
  cur.ret += e.returned ?? 0;
  cur.last = Math.max(cur.last, e.at);
  if (e.ms > cur.max) {
    cur.max = e.ms;
    cur.ex = runOf(e);
  }
};

// 줄들 → 화면의 묶음. from = 이 시각 뒤(null = 전부), min보다 빠른 구간은 뺀다
export const summarize = (
  lines: SlowLine[],
  { from, scope, min }: { from: number | null; scope: OperationsScope; min: SlowThreshold },
): { groups: SlowGroup[]; hidden: number; missed: SlowMissed[] } => {
  const minBand = bandOf(min);
  const groups = new Map<string, SlowGroup>();
  const missed: SlowMissed[] = [];
  let hidden = 0;
  for (const line of lines) {
    if (isMissed(line)) {
      if (from === null || line.t >= from) missed.push({ from: line.from, to: line.t, lines: line.missed });
      continue;
    }
    if ((from !== null && line.last < from) || !inScope(line.ns, scope)) continue;
    if (line.b < minBand) {
      hidden += line.n;
      continue;
    }
    let g = groups.get(line.k);
    if (!g) {
      g = {
        key: line.k,
        kind: line.kind,
        ns: line.ns,
        op: line.op,
        queryHash: line.h,
        summary: line.ex.summary,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        docsExamined: 0,
        keysExamined: 0,
        returned: 0,
        plan: line.ex.plan,
        last: 0,
        runs: [],
      };
      groups.set(line.k, g);
    }
    g.count += line.n;
    g.totalMs += line.sum;
    g.docsExamined += line.docs;
    g.keysExamined += line.keys;
    g.returned += line.ret;
    g.last = Math.max(g.last, line.last);
    if (line.max > g.maxMs) {
      g.maxMs = line.max;
      g.summary = line.ex.summary;
      g.plan = line.ex.plan;
    }
    g.runs.push(line.ex);
  }
  const list = [...groups.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, MAX_GROUPS);
  for (const g of list) g.runs = g.runs.sort((a, b) => b.at - a.at).slice(0, RUNS_PER_GROUP);
  // 이어진 구간은 하나로(10분마다 끊어 적은 것·바로 이어진 것)
  missed.sort((a, b) => a.from - b.from);
  const merged: SlowMissed[] = [];
  for (const m of missed) {
    const prev = merged[merged.length - 1];
    if (prev && m.from - prev.to <= SAMPLE_INTERVAL_MS * 6) {
      prev.to = Math.max(prev.to, m.to);
      prev.lines += m.lines;
    } else merged.push({ ...m });
  }
  return { groups: list, hidden, missed: merged };
};

// 날짜 파일 읽기는 크기 기록(9-6a)과 같이 쓴다(monitor/history readDayFiles)
export const readSlowFiles = (dir: string, from: number | null): Promise<SlowLine[]> => readDayFiles<SlowLine>(dir, 'slow', from);

export interface SlowLogHooks {
  connectionId: string;
  client: () => Promise<MongoClient>;
  recorder: () => Recorder;
  // 기록 파일에 남기는가(설정 › Monitor 기록)
  stored: () => boolean;
  clock?: () => number;
}

export interface SlowLog {
  // 샘플러 박자마다 — 서버 로그를 읽고 끝난 분을 적는다
  poll: () => Promise<void>;
  // 피드가 닫힐 때 — 지금 분까지 다 적는다
  stop: () => Promise<void>;
  // 주소가 바뀜 — 지금까지 것을 옛 서버 폴더에 적고 처음부터(기록기 reset보다 먼저 부른다)
  reset: () => Promise<void>;
  report: (query: { range: MonitorRange; scope: OperationsScope; min: SlowThreshold }) => Promise<SlowQueriesReport>;
}

export const createSlowLog = (hooks: SlowLogHooks): SlowLog => {
  const clock = hooks.clock ?? Date.now;
  let status: SlowLogStatus = 'ok';
  let error: string | null = null;
  let retryAt = 0;
  // 이번에 열린 뒤 지난번 읽기 — 서버가 쓴 줄 수, 그때 받은 가장 새 줄의 시각
  let prevTotal: number | null = null;
  let prevNewest: number | null = null;
  // 처음 읽을 때 — 이 시각 뒤만(지난번에 파일에 적은 마지막)
  let started = false;
  let since: number | null = null;
  let generation = 0;
  const writes = new Map<string, number>();
  let pending = new Map<string, SlowBucketLine>();
  let missedOpen: SlowMissedLine | null = null;
  let missedClosed: SlowMissedLine[] = [];
  // 기록이 꺼져 있을 때만 — 최근 1시간
  let memory: SlowLine[] = [];
  let slowms: { value: number | null; at: number } | null = null;

  const noteMissed = (from: number, to: number, lines: number) => {
    if (missedOpen && from - missedOpen.t <= SAMPLE_INTERVAL_MS * 3) {
      missedOpen.t = Math.max(missedOpen.t, to);
      missedOpen.missed += lines;
      return;
    }
    if (missedOpen) missedClosed.push(missedOpen);
    missedOpen = { t: to, from, missed: lines };
  };

  // 적을 줄을 꺼낸다(동기) — all이면 지금 분까지, 아니면 끝난 분만
  const take = (all: boolean): SlowLine[] => {
    const edge = minuteStart(clock());
    const out: SlowLine[] = [];
    for (const [id, line] of pending) {
      if (all || line.t < edge) {
        out.push(line);
        pending.delete(id);
      }
    }
    if (all && missedOpen) {
      missedClosed.push(missedOpen);
      missedOpen = null;
    }
    out.push(...missedClosed);
    missedClosed = [];
    return out;
  };

  // 기록기 줄에 바로 선다(await 전에) — 뒤이은 기록기 reset/stop보다 먼저 적히게
  const write = (out: SlowLine[]): Promise<void> => {
    if (!out.length) return Promise.resolve();
    if (hooks.stored()) {
      const newest = out.reduce((n, l) => (isMissed(l) ? n : Math.max(n, l.last)), -Infinity);
      return hooks.recorder().appendSlow(out, Number.isFinite(newest) ? newest : null);
    }
    const keepFrom = clock() - MEMORY_MS;
    memory = [...memory, ...out].filter((l) => (isMissed(l) ? l.t : l.last) >= keepFrom);
    return Promise.resolve();
  };

  const poll = async () => {
    const now = clock();
    if ((status === 'denied' || status === 'unsupported') && now < retryAt) return;
    const mine = generation;
    let res: BsonDocument;
    try {
      const client = await hooks.client();
      res = await withTimeout(client.db('admin').command({ getLog: 'global' }));
    } catch (e) {
      if (mine !== generation) return;
      if (isUnauthorized(e)) {
        status = 'denied';
        error = null;
        retryAt = now + RETRY_MS;
      } else {
        status = 'error';
        error = message(e);
      }
      return;
    }
    if (mine !== generation) return;
    const lines = (Array.isArray(res.log) ? res.log : []).filter((l): l is string => typeof l === 'string');
    const total = Number(res.totalLinesWritten);
    // 4.4 전에는 로그가 JSON이 아닌 글자
    if (lines.length && !lines[0].startsWith('{')) {
      status = 'unsupported';
      error = null;
      retryAt = now + RETRY_MS;
      return;
    }
    status = 'ok';
    error = null;
    if (!started) {
      started = true;
      since = hooks.stored() ? await hooks.recorder().slowCursor() : null;
      if (mine !== generation) return;
    }

    let fresh = lines;
    let missedNow = false;
    if (prevTotal !== null && Number.isFinite(total)) {
      // 줄 수가 줄었으면 MongoDB가 재시작했다 — 그 뒤 쓴 줄이 전부 새 줄
      const delta = total < prevTotal ? total : total - prevTotal;
      if (delta > lines.length) {
        const oldest = lineTime(lines[0]) ?? now;
        noteMissed(prevNewest ?? oldest, oldest, delta - lines.length);
        missedNow = true;
      }
      fresh = delta >= lines.length ? lines : lines.slice(lines.length - delta);
    }
    // 처음 읽기는 지난번에 적은 것 뒤만(같은 분에 두 번 세지 않게)
    const after = prevTotal === null ? since : null;
    for (const line of fresh) {
      const entry = parseSlowLine(line, writes);
      if (entry && (after === null || entry.at > after)) addToBucket(pending, entry);
    }
    if (Number.isFinite(total)) prevTotal = total;
    prevNewest = lineTime(lines[lines.length - 1]) ?? prevNewest;
    if (missedOpen && (!missedNow || now - missedOpen.from >= MISSED_FLUSH_MS)) {
      missedClosed.push(missedOpen);
      missedOpen = null;
    }
    await write(take(false));
  };

  const readSlowms = async (): Promise<number | null> => {
    const now = clock();
    if (slowms && now - slowms.at < SLOWMS_TTL_MS) return slowms.value;
    let value: number | null = null;
    try {
      const res = await withTimeout((await hooks.client()).db('admin').command({ profile: -1 }));
      value = num(Number(res.slowms));
    } catch {
      value = null;
    }
    slowms = { value, at: now };
    return value;
  };

  return {
    poll,
    stop() {
      generation += 1;
      return write(take(true));
    },
    reset() {
      const done = write(take(true));
      generation += 1;
      status = 'ok';
      error = null;
      retryAt = 0;
      prevTotal = null;
      prevNewest = null;
      started = false;
      since = null;
      writes.clear();
      pending = new Map();
      memory = [];
      slowms = null;
      return done;
    },
    async report({ range, scope, min }) {
      const now = clock();
      const span = RANGE_MS[range];
      const from = span === null ? null : now - span;
      const stored = hooks.stored();
      const lines: SlowLine[] = [];
      if (stored) {
        const fingerprint = hooks.recorder().currentFingerprint();
        // 큰 배열은 펼쳐 넣지 않는다(인자 수 한도)
        if (fingerprint) for (const line of await readSlowFiles(serverHistoryDir(hooks.connectionId, fingerprint), from)) lines.push(line);
      } else {
        lines.push(...memory);
      }
      lines.push(...pending.values(), ...missedClosed);
      if (missedOpen) lines.push(missedOpen);
      return {
        at: now,
        range,
        status,
        error,
        slowms: await readSlowms(),
        min,
        stored,
        ...summarize(lines, { from, scope, min }),
      };
    },
  };
};
