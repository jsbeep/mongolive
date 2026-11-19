// 트랜잭션 (9-8b) — Monitor › Collections의 Transactions 카드
//
// 피드가 받는 변경 중 트랜잭션 안의 쓰기(LiveChange.txn = lsid + txnNumber)를 트랜잭션 하나로 모아 센다. DB에 묻지 않는다.
// 한 트랜잭션의 이벤트는 커밋 시각(clusterTime)이 같고 연달아 온다 — 더 늦은 시각의 이벤트가 오거나
// 2초 동안 더 오지 않으면 끝난 것으로 보고 1분 칸에 넣는다(끝나기 전에도 보고서에는 든다).
// 1분 칸 = 컬렉션 조합별 {개수, 쓰기 수, 가장 큰 것 하나}. 최근 1시간만 메모리에(파일에 적지 않는다).
// 빈 구간을 불러온 쓰기(backfill)도 1시간 안이면 센다 — 실시간과 섞이지 않게 따로 모은다.
import { Binary } from 'mongodb';
import type { LiveChange, TransactionCombo, TransactionOps, TransactionSample, TransactionsReport } from '@mongolive/shared';

const MINUTE = 60_000;
const KEEP_MS = 60 * MINUTE;
const IDLE_MS = 2_000;
// 동시에 모으는 트랜잭션 — 넘으면 가장 먼저 연 것부터 끝낸다
const MAX_OPEN = 100;
// 조합·샘플에 적는 컬렉션 수 / 한 트랜잭션에서 따로 세는 컬렉션 수
const MAX_NS = 10;
const MAX_TRACKED_NS = 200;
// 1분 칸의 조합 수 — 넘으면 '기타' 하나로 센다(범위로 좁힌 숫자는 모자랄 수 있다)
const MAX_COMBOS = 200;
const TOP = 5;
const OTHER = '\u0000other';

const RANGE_MS = { '5m': 5 * MINUTE, '30m': 30 * MINUTE, '1h': 60 * MINUTE } as const;
export type TransactionsRange = keyof typeof RANGE_MS;

// 변경 이벤트의 트랜잭션 표시 — 세션 id(lsid.id, UUID)를 16진수로 + ':' + 그 세션의 트랜잭션 번호.
// 트랜잭션 밖의 쓰기(재시도 가능한 쓰기 포함)에는 change stream이 lsid·txnNumber를 붙이지 않는다
export const txnOf = (change: object): string | undefined => {
  const { lsid, txnNumber } = change as { lsid?: { id?: unknown }; txnNumber?: unknown };
  if (txnNumber === undefined || txnNumber === null || !lsid?.id) return undefined;
  const id = lsid.id;
  const hex = id instanceof Binary ? id.toString('hex') : typeof id === 'string' ? id : null;
  return hex ? `${hex}:${String(txnNumber)}` : undefined;
};

interface OpenTx {
  at: number;
  // 마지막으로 이벤트를 받은 때(서버 시각)
  seen: number;
  writes: number;
  ops: TransactionOps;
  ns: Map<string, number>;
}

interface Combo {
  namespaces: string[];
  more: number;
  count: number;
  writes: number;
  largest: TransactionSample;
}

const OP_KIND: Partial<Record<LiveChange['op'], keyof TransactionOps>> = {
  insert: 'insert',
  update: 'update',
  replace: 'update',
  delete: 'delete',
};

// 조합 = 건드린 컬렉션(이름순). 10개가 넘으면 앞 10개 + 나머지 수
const shapeOf = (tx: OpenTx) => {
  const all = [...tx.ns.keys()].sort();
  const namespaces = all.slice(0, MAX_NS);
  const more = all.length - namespaces.length;
  return { key: namespaces.join('\u0001') + (more ? `\u0001+${more}` : ''), namespaces, more };
};

// 샘플 — 컬렉션은 쓰기 많은 순
const sampleOf = (tx: OpenTx): TransactionSample => {
  const sorted = [...tx.ns].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const namespaces = sorted.slice(0, MAX_NS).map(([ns, writes]) => ({ ns, writes }));
  return { at: tx.at, writes: tx.writes, ops: { ...tx.ops }, namespaces, more: sorted.length - namespaces.length };
};

export interface TransactionsQuery {
  range: TransactionsRange;
  scope: { database: string | null; collection: string | null };
}

export interface Transactions {
  record: (change: LiveChange, backfill?: boolean) => void;
  // 샘플러 박자(10초)마다 — 조용해진 트랜잭션을 끝내고 1시간 지난 칸을 버린다
  tick: () => void;
  reset: () => void;
  report: (query: TransactionsQuery) => TransactionsReport;
}

export interface TransactionsHooks {
  // 세기 시작한 때 — 쓰기 집계(activity)와 같은 값(빈 구간을 다 채우면 앞당겨진다)
  since: () => number;
  clock?: () => number;
}

export const createTransactions = ({ since, clock = Date.now }: TransactionsHooks): Transactions => {
  let buckets = new Map<number, Map<string, Combo>>();
  let streams = { live: new Map<string, OpenTx>(), filled: new Map<string, OpenTx>() };

  const finish = (tx: OpenTx) => {
    if (tx.writes === 0 || tx.at < clock() - KEEP_MS) return;
    const minute = Math.floor(tx.at / MINUTE) * MINUTE;
    let bucket = buckets.get(minute);
    if (!bucket) {
      bucket = new Map();
      buckets.set(minute, bucket);
    }
    const shape = shapeOf(tx);
    const key = bucket.has(shape.key) || bucket.size < MAX_COMBOS ? shape.key : OTHER;
    const combo = bucket.get(key);
    if (!combo) {
      const other = key === OTHER;
      bucket.set(key, { namespaces: other ? [] : shape.namespaces, more: other ? 0 : shape.more, count: 1, writes: tx.writes, largest: sampleOf(tx) });
      return;
    }
    combo.count += 1;
    combo.writes += tx.writes;
    if (tx.writes >= combo.largest.writes) combo.largest = sampleOf(tx);
  };

  const finishAll = (stream: Map<string, OpenTx>, done: (tx: OpenTx) => boolean) => {
    for (const [key, tx] of stream) {
      if (!done(tx)) continue;
      stream.delete(key);
      finish(tx);
    }
  };

  const record: Transactions['record'] = (change, backfill = false) => {
    const stream = backfill ? streams.filled : streams.live;
    // 더 늦은 커밋 시각의 이벤트 — 그 앞에 모으던 트랜잭션은 다 왔다
    if (stream.size) finishAll(stream, (tx) => tx.at < change.clusterTime);
    const kind = OP_KIND[change.op];
    if (!change.txn || !kind || !change.collection) return;
    const now = clock();
    if (change.clusterTime < now - KEEP_MS) return;
    let tx = stream.get(change.txn);
    if (!tx) {
      if (stream.size >= MAX_OPEN) {
        const [oldestKey, oldest] = stream.entries().next().value as [string, OpenTx];
        stream.delete(oldestKey);
        finish(oldest);
      }
      tx = { at: change.clusterTime, seen: now, writes: 0, ops: { insert: 0, update: 0, delete: 0 }, ns: new Map() };
      stream.set(change.txn, tx);
    }
    tx.seen = now;
    tx.writes += 1;
    tx.ops[kind] += 1;
    const ns = `${change.database}.${change.collection}`;
    if (tx.ns.has(ns) || tx.ns.size < MAX_TRACKED_NS) tx.ns.set(ns, (tx.ns.get(ns) ?? 0) + 1);
  };

  const tick = () => {
    const now = clock();
    finishAll(streams.live, (tx) => now - tx.seen > IDLE_MS);
    finishAll(streams.filled, (tx) => now - tx.seen > IDLE_MS);
    const cutoff = Math.floor((now - KEEP_MS) / MINUTE) * MINUTE;
    for (const minute of buckets.keys()) if (minute < cutoff) buckets.delete(minute);
  };

  const report = ({ range, scope }: TransactionsQuery): TransactionsReport => {
    const now = clock();
    const from = now - RANGE_MS[range];
    const firstMinute = Math.floor(from / MINUTE) * MINUTE;
    const start = Math.max(firstMinute, since());
    const prefix = scope.database ? `${scope.database}.` : '';
    const exact = scope.database && scope.collection ? `${scope.database}.${scope.collection}` : null;
    const matches = (namespaces: string[]) =>
      !scope.database || namespaces.some((ns) => (exact ? ns === exact : ns.startsWith(prefix)));

    let count = 0;
    let writes = 0;
    let maxWrites = 0;
    let partial = false;
    const combos = new Map<string, TransactionCombo>();
    const samples: TransactionSample[] = [];
    const add = (key: string, part: Omit<Combo, 'largest'>, largest: TransactionSample) => {
      count += part.count;
      writes += part.writes;
      maxWrites = Math.max(maxWrites, largest.writes);
      if (largest.at >= from) samples.push(largest);
      if (key === OTHER) return;
      const combo = combos.get(key);
      if (combo) {
        combo.count += part.count;
        combo.writes += part.writes;
      } else {
        combos.set(key, { namespaces: part.namespaces, more: part.more, count: part.count, writes: part.writes });
      }
    };

    for (const [minute, bucket] of buckets) {
      if (minute < firstMinute) continue;
      for (const [key, combo] of bucket) {
        if (key === OTHER) {
          if (scope.database) {
            partial = true;
            continue;
          }
        } else if (!matches(combo.namespaces)) continue;
        add(key, combo, combo.largest);
      }
    }
    // 아직 모으는 중인 것도 — 방금 커밋한 트랜잭션이 바로 보이게
    for (const stream of [streams.live, streams.filled]) {
      for (const tx of stream.values()) {
        if (tx.writes === 0 || tx.at < firstMinute) continue;
        const shape = shapeOf(tx);
        if (!matches(shape.namespaces)) continue;
        add(shape.key, { namespaces: shape.namespaces, more: shape.more, count: 1, writes: tx.writes }, sampleOf(tx));
      }
    }

    const minutes = Math.max(1, (now - start) / MINUTE);
    return {
      status: 'ok',
      at: now,
      since: since(),
      count,
      writes,
      perMinute: count / minutes,
      maxWrites,
      combos: [...combos.values()].sort((a, b) => b.count - a.count || b.writes - a.writes).slice(0, TOP),
      largest: samples.sort((a, b) => b.writes - a.writes || b.at - a.at).slice(0, TOP),
      partial,
    };
  };

  const reset = () => {
    buckets = new Map();
    streams = { live: new Map(), filled: new Map() };
  };

  return { record, tick, reset, report };
};
