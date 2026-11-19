// 알림 (9-8a) — Monitor › Collections의 Alerts 카드 + 앱 어디서나 토스트
//
// 피드가 이미 받는 changeStream 이벤트만 센다(MongoDB에 묻지 않으니 부하 없음).
//   대량 삭제(mass-delete)  한 컬렉션에서 60초 안의 삭제가 한도 이상(설정 › Monitor › Alerts, 기본 1,000)
//   쓰기 폭주(burst)        한 컬렉션의 60초 쓰기가 한도 이상이면서 평소의 10배 이상
//                           평소 = 지켜본 최근 1시간의 분당 평균(쓰기 없던 분은 0). 5분 넘게 지켜보기 전엔 판단하지 않는다
//   삭제(drop)              컬렉션 drop — 같은 DB에서 10초 안에 이어지면 한 건. 이어서 dropDatabase가 오면 'DB 삭제' 한 건으로 바꾼다
//   이름 바꾸기(rename)     $out·mapReduce가 쓰는 임시 컬렉션(tmp.*)은 뺀다
// 60초 창 = 10초 칸 6개를 굴린 것 — 분 경계에 걸쳐 600 + 600으로 나뉘어도 잡힌다.
// 한 건(episode) = 처음 넘은 때부터 마지막으로 넘었던 때까지. 5분 안에 다시 넘으면 이어 붙이고(그 사이 이벤트도 센다),
// 5분 동안 안 넘으면 끝 → 기록 파일 alerts-YYYY-MM-DD.jsonl(끝난 날짜). 기록이 꺼져 있으면 메모리에 1시간.
// 빈 구간 불러오기(9-4)로 다시 읽은 이벤트는 따로 센다 — 시각이 과거라 실시간 창과 섞으면 안 된다.
//   filled로 표시하고 토스트는 없다. burst는 실시간만(지난 구간의 평소를 모른다).
// 시각은 MongoDB에 기록된 시각(clusterTime).
import type { AlertKind, AlertsReport, LiveChange, LiveOperation, MonitorAlert, MonitorPeriod } from '@mongolive/shared';
import { readDayFiles, serverHistoryDir, type Recorder } from './history';
import { periodBounds } from './slowQueries';

export const WINDOW_MS = 60_000;
const SLOT_MS = 10_000;
const MINUTE_MS = 60_000;
// 이만큼 안에 다시 넘으면 같은 건
export const MERGE_MS = 5 * MINUTE_MS;
// drop은 짧게 — dropDatabase·스크립트가 한꺼번에 지우는 것만 묶고, 따로 지운 건 따로 알린다
export const DROP_MERGE_MS = 10_000;
export const BURST_FACTOR = 10;
// 평소를 정하려면 이만큼(분) 지켜봐야 한다
export const BASELINE_MIN_MINUTES = 5;
const BASELINE_MS = 60 * MINUTE_MS;
// drop 토스트는 잠깐 기다렸다 보낸다 — 이어서 오는 drop·dropDatabase를 한 건으로 묶어 알리게
const DROP_SETTLE_MS = 2_000;
// 불러오기 이벤트가 이만큼 안 오면 불러오기가 끝난 것 — 열린 건을 다 닫는다
const FILL_IDLE_MS = 15_000;
const MEMORY_MS = 60 * MINUTE_MS;
const MAX_LISTED = 20;
const MAX_TRACKED_NS = 2_000;
const MAX_ALERTS = 200;

const WRITE_OPS = new Set<LiveOperation>(['insert', 'update', 'replace', 'delete']);

export interface AlertRules {
  // 0 = 끔
  deletes: number;
  burst: number;
  drops: boolean;
}

export interface AlertsHooks {
  connectionId: string;
  recorder: () => Recorder;
  // 기록 파일에 남기는가(설정 › Monitor 기록)
  stored: () => boolean;
  rules: () => AlertRules;
  // 실시간 알림이 새로 생김(소켓 'monitor:alert')
  onAlert: (alert: MonitorAlert) => void;
  clock?: () => number;
  settleMs?: number;
}

export interface Alerts {
  // backfill = 빈 구간 불러오기로 다시 읽은 이벤트
  record: (change: LiveChange, backfill?: boolean) => void;
  // 샘플러 박자마다 — 조용해진 건을 끝낸다
  tick: () => void;
  // 피드가 닫힐 때 — 열린 건을 다 끝내 적는다(기록기 stop보다 먼저)
  stop: () => Promise<void>;
  // 주소가 바뀜 — 옛 서버 폴더에 적고 처음부터(기록기 reset보다 먼저)
  reset: () => Promise<void>;
  report: (query: { period: MonitorPeriod; scope: { database: string | null; collection: string | null } }) => Promise<AlertsReport>;
}

interface Slot {
  deletes: number;
  writes: number;
  first: number;
}

interface NsCounter {
  // 10초 칸 시작 → 수(60초 창)
  slots: Map<number, Slot>;
  // 분 시작 → 쓰기 수(평소, 실시간만)
  minutes: Map<number, number>;
  touched: number;
  // 평소 계산 캐시 — 같은 10초 칸 동안은 다시 세지 않는다
  usual: { slot: number; value: number | null } | null;
}

interface Episode {
  alert: MonitorAlert;
  // 마지막으로 넘은 뒤 센 이벤트 — 다시 넘으면 붙인다(안 넘고 끝나면 버린다)
  pending: number;
  // 이만큼 안에 다시 오면 같은 건
  mergeMs: number;
  // drop 토스트를 기다리는 중
  timer: NodeJS.Timeout | null;
}

interface Stream {
  filled: boolean;
  counters: Map<string, NsCounter>;
  open: Map<string, Episode>;
  // 실시간: 지켜보기 시작한 때(평소 계산의 시작). 불러오기: 마지막 이벤트를 받은 때(서버 시계)
  since: number;
}

const slotStart = (t: number) => Math.floor(t / SLOT_MS) * SLOT_MS;
const minuteStart = (t: number) => Math.floor(t / MINUTE_MS) * MINUTE_MS;
// $out·mapReduce의 임시 컬렉션
const isTemp = (collection: string) => collection.startsWith('tmp.');

// t가 든 10초 칸과 그 앞 5칸(50~60초)
export const windowOf = (counter: Pick<NsCounter, 'slots'>, t: number): Slot => {
  const edge = slotStart(t);
  const out: Slot = { deletes: 0, writes: 0, first: t };
  for (const [start, slot] of counter.slots) {
    if (start < edge - WINDOW_MS + SLOT_MS || start > edge) continue;
    out.deletes += slot.deletes;
    out.writes += slot.writes;
    out.first = Math.min(out.first, slot.first);
  }
  return out;
};

// 60초 창이 시작되기 전의 온전한 분들(최근 1시간, 지켜보기 시작한 뒤)의 분당 평균. 5분이 안 되면 null
export const usualOf = (minutes: Map<number, number>, since: number, t: number): number | null => {
  const firstMinute = Math.ceil(Math.max(since, t - BASELINE_MS) / MINUTE_MS) * MINUTE_MS;
  const windowStart = slotStart(t) - WINDOW_MS + SLOT_MS;
  const count = Math.floor((windowStart - firstMinute) / MINUTE_MS);
  if (count < BASELINE_MIN_MINUTES) return null;
  let sum = 0;
  for (let i = 0; i < count; i += 1) sum += minutes.get(firstMinute + i * MINUTE_MS) ?? 0;
  return Math.round((sum / count) * 10) / 10;
};

const inScope = (a: MonitorAlert, scope: { database: string | null; collection: string | null }) => {
  const { database, collection } = scope;
  if (!database) return true;
  const here = a.database === database;
  const target = a.to?.database === database;
  if (!here && !target) return false;
  if (!collection) return true;
  // DB 삭제는 그 DB의 어느 컬렉션에서나(목록은 앞 20개뿐)
  return (here && (a.kind === 'drop-database' || a.collections.includes(collection))) || (target && a.to?.collection === collection);
};

export const createAlerts = (hooks: AlertsHooks): Alerts => {
  const clock = hooks.clock ?? Date.now;
  const settleMs = hooks.settleMs ?? DROP_SETTLE_MS;
  const newStream = (filled: boolean): Stream => ({ filled, counters: new Map(), open: new Map(), since: clock() });
  let live = newStream(false);
  let filled = newStream(true);
  // 기록이 꺼져 있을 때만 — 끝난 건 최근 1시간
  let memory: MonitorAlert[] = [];
  const timers = new Set<NodeJS.Timeout>();

  // 기록기 줄에 바로 선다(await 전에) — 뒤이은 기록기 reset/stop보다 먼저 적히게
  const write = (list: MonitorAlert[]): Promise<void> => {
    if (!list.length) return Promise.resolve();
    if (hooks.stored()) return hooks.recorder().appendAlerts(list);
    const keepFrom = clock() - MEMORY_MS;
    memory = [...memory, ...list].filter((a) => a.end >= keepFrom);
    return Promise.resolve();
  };

  const send = (alert: MonitorAlert) => hooks.onAlert({ ...alert, collections: [...alert.collections] });
  const emit = (stream: Stream, alert: MonitorAlert) => {
    if (!stream.filled) send(alert);
  };
  // drop — 잠깐 기다렸다 그때의 모습으로 알린다. 알린 뒤에 더 묶이면 한 번 더(기다리는 동안 온 건 그 한 번에)
  const notifyLater = (stream: Stream, ep: Episode) => {
    if (stream.filled || ep.timer) return;
    if (settleMs <= 0) return send(ep.alert);
    const timer = setTimeout(() => {
      timers.delete(timer);
      ep.timer = null;
      send(ep.alert);
    }, settleMs);
    ep.timer = timer;
    timers.add(timer);
  };
  const episode = (alert: MonitorAlert, mergeMs: number): Episode => ({ alert, pending: 0, mergeMs, timer: null });

  const make = (stream: Stream, kind: AlertKind, database: string, collections: string[], start: number, end: number, extra: Partial<MonitorAlert> = {}): MonitorAlert => ({
    id: `${stream.filled ? 'f' : 'l'}:${kind}:${database}.${collections[0] ?? ''}:${start}`,
    kind,
    database,
    collections,
    start,
    end,
    count: 1,
    peak: 1,
    usual: null,
    limit: null,
    ongoing: true,
    filled: stream.filled,
    ...extra,
  });

  const finish = (stream: Stream, key: string, ep: Episode): MonitorAlert => {
    stream.open.delete(key);
    ep.alert.ongoing = false;
    return ep.alert;
  };

  // 조건을 넘었나(over) — 넘었으면 열거나 늘리고, 아니면 열린 건의 '사이 이벤트'로 센다
  const step = (stream: Stream, key: string, t: number, over: boolean, value: number, create: () => MonitorAlert) => {
    let ep = stream.open.get(key);
    if (ep && t - ep.alert.end > ep.mergeMs) {
      void write([finish(stream, key, ep)]);
      ep = undefined;
    }
    if (ep) {
      if (over) {
        ep.alert.count += ep.pending + 1;
        ep.pending = 0;
        ep.alert.end = Math.max(ep.alert.end, t);
        ep.alert.peak = Math.max(ep.alert.peak, value);
      } else ep.pending += 1;
      return;
    }
    if (!over) return;
    const alert = create();
    stream.open.set(key, episode(alert, MERGE_MS));
    emit(stream, alert);
  };

  const onWrite = (stream: Stream, change: LiveChange, collection: string, t: number, rules: AlertRules) => {
    const { database } = change;
    const ns = `${database}.${collection}`;
    let counter = stream.counters.get(ns);
    if (!counter) {
      // 너무 많은 컬렉션에 한꺼번에 쓰면 새 컬렉션은 세지 않는다(메모리 상한)
      if (stream.counters.size >= MAX_TRACKED_NS) return;
      counter = { slots: new Map(), minutes: new Map(), touched: t, usual: null };
      stream.counters.set(ns, counter);
    }
    counter.touched = Math.max(counter.touched, t);
    const s = slotStart(t);
    let slot = counter.slots.get(s);
    if (!slot) {
      slot = { deletes: 0, writes: 0, first: t };
      counter.slots.set(s, slot);
      for (const key of counter.slots.keys()) if (key < s - WINDOW_MS || key > s + WINDOW_MS) counter.slots.delete(key);
    }
    slot.writes += 1;
    if (change.op === 'delete') slot.deletes += 1;
    slot.first = Math.min(slot.first, t);
    if (!stream.filled) {
      const m = minuteStart(t);
      const prev = counter.minutes.get(m);
      counter.minutes.set(m, (prev ?? 0) + 1);
      if (prev === undefined) for (const key of counter.minutes.keys()) if (key < m - BASELINE_MS - MINUTE_MS) counter.minutes.delete(key);
    }
    const w = windowOf(counter, t);

    if (change.op === 'delete') {
      const key = `mass-delete|${ns}`;
      const limit = rules.deletes;
      if (limit > 0 || stream.open.has(key)) {
        step(stream, key, t, limit > 0 && w.deletes >= limit, w.deletes, () =>
          make(stream, 'mass-delete', database, [collection], w.first, t, { count: w.deletes, peak: w.deletes, limit }),
        );
      }
    }

    if (stream.filled) return;
    const key = `burst|${ns}`;
    const limit = rules.burst;
    const ep = stream.open.get(key);
    if (limit <= 0 && !ep) return;
    let over = false;
    let usual: number | null = null;
    if (limit > 0 && w.writes >= limit) {
      if (ep && t - ep.alert.end <= MERGE_MS) {
        // 이어지는 중 — 넘을 때의 평소로 판단(폭주가 평소를 끌어올리지 않게)
        over = w.writes >= BURST_FACTOR * (ep.alert.usual ?? 0);
      } else {
        if (counter.usual?.slot !== s) counter.usual = { slot: s, value: usualOf(counter.minutes, stream.since, t) };
        usual = counter.usual.value;
        over = usual !== null && w.writes >= BURST_FACTOR * usual;
      }
    }
    step(stream, key, t, over, w.writes, () => make(stream, 'burst', database, [collection], w.first, t, { count: w.writes, peak: w.writes, usual, limit }));
  };

  const onDrop = (stream: Stream, database: string, collection: string | null, t: number) => {
    const key = `drop|${database}`;
    let ep = stream.open.get(key);
    if (ep && t - ep.alert.end > ep.mergeMs) {
      void write([finish(stream, key, ep)]);
      ep = undefined;
    }
    if (collection === null) {
      // dropDatabase — 바로 앞의 drop들을 흡수해 'DB 삭제' 한 건으로 끝낸다(뒤이은 drop은 새 건)
      if (ep) {
        ep.alert.kind = 'drop-database';
        ep.alert.end = Math.max(ep.alert.end, t);
        void write([finish(stream, key, ep)]);
      } else {
        ep = episode(make(stream, 'drop-database', database, [], t, t, { count: 0, peak: 0, ongoing: false }), DROP_MERGE_MS);
        void write([ep.alert]);
      }
      notifyLater(stream, ep);
      return;
    }
    if (ep) {
      ep.alert.count += 1;
      ep.alert.peak = ep.alert.count;
      if (ep.alert.collections.length < MAX_LISTED && !ep.alert.collections.includes(collection)) ep.alert.collections.push(collection);
      ep.alert.end = Math.max(ep.alert.end, t);
    } else {
      ep = episode(make(stream, 'drop', database, [collection], t, t), DROP_MERGE_MS);
      stream.open.set(key, ep);
    }
    notifyLater(stream, ep);
  };

  const record = (change: LiveChange, backfill = false) => {
    const stream = backfill ? filled : live;
    const t = change.clusterTime;
    if (backfill) stream.since = clock();
    const rules = hooks.rules();
    if (WRITE_OPS.has(change.op)) {
      if (change.collection) onWrite(stream, change, change.collection, t, rules);
      return;
    }
    const drop = `drop|${change.database}`;
    if (!rules.drops && !stream.open.has(drop)) return;
    if (change.op === 'drop' && change.collection && !isTemp(change.collection)) onDrop(stream, change.database, change.collection, t);
    else if (change.op === 'dropDatabase') onDrop(stream, change.database, null, t);
    else if (change.op === 'rename' && rules.drops && change.collection && change.to?.collection && !isTemp(change.collection)) {
      const alert = make(stream, 'rename', change.database, [change.collection], t, t, {
        to: { database: change.to.database, collection: change.to.collection },
        ongoing: false,
      });
      void write([alert]);
      emit(stream, alert);
    }
  };

  const closeAll = (): MonitorAlert[] => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const out: MonitorAlert[] = [];
    for (const stream of [live, filled]) for (const [key, ep] of [...stream.open]) out.push(finish(stream, key, ep));
    return out;
  };

  return {
    record,
    tick() {
      const now = clock();
      const done: MonitorAlert[] = [];
      for (const [key, ep] of [...live.open]) if (now - ep.alert.end > ep.mergeMs) done.push(finish(live, key, ep));
      // 1시간 넘게 안 쓴 컬렉션은 잊는다(평소 0과 같다)
      for (const [ns, counter] of live.counters) if (counter.touched < now - BASELINE_MS - MINUTE_MS) live.counters.delete(ns);
      // 불러오기가 멎었으면 열린 건을 다 끝내고 센 것을 버린다
      if (now - filled.since > FILL_IDLE_MS && (filled.open.size || filled.counters.size)) {
        for (const [key, ep] of [...filled.open]) done.push(finish(filled, key, ep));
        filled.counters.clear();
      }
      if (!hooks.stored() && memory.length) memory = memory.filter((a) => a.end >= now - MEMORY_MS);
      void write(done);
    },
    stop() {
      return write(closeAll());
    },
    reset() {
      const done = write(closeAll());
      live = newStream(false);
      filled = newStream(true);
      memory = [];
      return done;
    },
    async report({ period, scope }) {
      const now = clock();
      const { from, to } = periodBounds(period, now);
      const stored = hooks.stored();
      const all: MonitorAlert[] = [];
      if (stored) {
        const fingerprint = hooks.recorder().currentFingerprint();
        // 큰 배열은 펼쳐 넣지 않는다(인자 수 한도)
        if (fingerprint) for (const a of await readDayFiles<MonitorAlert>(serverHistoryDir(hooks.connectionId, fingerprint), 'alerts', from, to)) all.push(a);
      } else {
        for (const a of memory) all.push(a);
      }
      for (const stream of [live, filled]) for (const ep of stream.open.values()) all.push({ ...ep.alert, collections: [...ep.alert.collections] });
      const seen = new Set<string>();
      const rows: MonitorAlert[] = [];
      for (const a of all) {
        // 구간과 겹친 것(날짜로 찾기면 구간 뒤에 시작한 건 뺀다)
        if ((from !== null && a.end < from) || (to !== null && a.start > to) || !inScope(a, scope) || seen.has(a.id)) continue;
        seen.add(a.id);
        rows.push(a);
      }
      rows.sort((a, b) => b.end - a.end);
      return {
        status: 'ok',
        at: now,
        stored,
        since: live.since,
        rules: hooks.rules(),
        alerts: rows.slice(0, MAX_ALERTS),
        more: Math.max(0, rows.length - MAX_ALERTS),
      };
    },
  };
};
