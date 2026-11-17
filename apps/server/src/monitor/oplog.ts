// Oplog 창 (9-7b) — Monitor › Server의 Oplog 카드
//
// Server 탭이 보이는 동안만, 열 때와 60초마다 묻는다(기록하지 않는다). mongosh의 rs.printReplicationInfo()와 같은 셋, 모두 읽기 전용:
//   local.oplog.rs 맨 앞 한 항목($natural: 1)   — 가장 오래된 쓰기의 시각
//   local.oplog.rs 맨 뒤 한 항목($natural: -1)  — 가장 최근 쓰기의 시각(쓰기가 없어도 primary가 10초마다 noop을 남긴다)
//   $collStats storageStats                     — 쓰는 크기·최대 크기
// oplog 창 = 최근 − 가장 오래된. 멤버가 이보다 오래 멈춰 있으면 처음부터 다시 복사해야 하고(initial sync),
// 빈 구간 불러오기(9-4)도 이만큼 뒤까지만 된다. 아직 안 찼으면 창은 계속 자란다 — 찰 때까지 남은 시간을 지금까지의 평균 속도로 어림한다.
// 연결한 멤버의 oplog다(멤버마다 크기가 다를 수 있다). replSetGetStatus처럼 primary가 없어도 읽게 primaryPreferred.
import type { MongoClient, ReadPreferenceLike } from 'mongodb';
import type { OplogReport } from '@mongolive/shared';
import { isUnauthorized } from './operations';
import { withTimeout } from './sampler';

// 최대 크기의 이만큼을 넘으면 '찼다' — 그 뒤로는 가장 오래된 항목부터 지워진다
export const FULL_RATIO = 0.9;
const NAMESPACE_NOT_FOUND = 26;
const ANY_MEMBER: ReadPreferenceLike = 'primaryPreferred';

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown) => Number((e as { code?: unknown })?.code);
// 큰 값은 Long으로 올 수 있다
const num = (v: unknown): number | null =>
  typeof v === 'number' ? v : v && typeof v === 'object' && 'toNumber' in v ? (v as { toNumber: () => number }).toNumber() : null;

export interface OplogEntry {
  ts?: unknown;
  wall?: unknown;
}

// 맨 앞(1) 또는 맨 뒤(-1) 항목의 ts·wall. 비었으면 null
export const oplogEdge = async (client: MongoClient, direction: 1 | -1, readPreference?: ReadPreferenceLike): Promise<OplogEntry | null> => {
  const [entry] = await withTimeout(
    client
      .db('local')
      .collection('oplog.rs')
      .find({}, { projection: { _id: 0, ts: 1, wall: 1 }, sort: { $natural: direction }, limit: 1, maxTimeMS: 5000, ...(readPreference ? { readPreference } : {}) })
      .toArray(),
  );
  return (entry as OplogEntry | undefined) ?? null;
};

export interface OplogStorage {
  usedBytes: number | null;
  maxBytes: number | null;
  avgBytes: number | null;
}

export const oplogStorage = async (client: MongoClient, readPreference?: ReadPreferenceLike): Promise<OplogStorage> => {
  const [stats] = await withTimeout(
    client
      .db('local')
      .collection('oplog.rs')
      .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: 5000, ...(readPreference ? { readPreference } : {}) })
      .toArray(),
  );
  const storage = (stats as { storageStats?: Record<string, unknown> } | undefined)?.storageStats;
  const avg = num(storage?.avgObjSize);
  const maxBytes = num(storage?.maxSize);
  return { usedBytes: num(storage?.size), maxBytes: maxBytes !== null && maxBytes > 0 ? maxBytes : null, avgBytes: avg !== null && avg > 0 ? avg : null };
};

export const isFull = ({ usedBytes, maxBytes }: Pick<OplogStorage, 'usedBytes' | 'maxBytes'>): boolean | null =>
  usedBytes !== null && maxBytes !== null ? usedBytes >= maxBytes * FULL_RATIO : null;

// 항목의 시각(ms) — wall(ms 단위, 3.6+)이 있으면 그것, 없으면 ts의 초
export const entryTime = (entry: OplogEntry | null): number | null => {
  if (entry?.wall instanceof Date) return entry.wall.getTime();
  const ts = entry?.ts as { getHighBits?: () => number } | undefined;
  return ts?.getHighBits ? (ts.getHighBits() >>> 0) * 1000 : null;
};

// 아직 안 찼을 때 찰 때까지 남은 시간 — 지금까지 (쓴 크기 ÷ 창) 속도로 (최대 − 쓴 크기)를 채운다고 어림
export const fillsIn = (first: number | null, last: number | null, usedBytes: number | null, maxBytes: number | null): number | null => {
  if (first === null || last === null || usedBytes === null || maxBytes === null) return null;
  if (isFull({ usedBytes, maxBytes }) !== false || usedBytes <= 0 || last <= first) return null;
  return ((maxBytes - usedBytes) * (last - first)) / usedBytes;
};

export const readOplog = async (client: () => Promise<MongoClient>, clock: () => number = Date.now): Promise<OplogReport> => {
  const at = clock();
  const empty = { at, first: null, last: null, usedBytes: null, maxBytes: null, full: null, fillsInMs: null };
  try {
    const c = await client();
    const [oldest, newest, storage] = await Promise.all([oplogEdge(c, 1, ANY_MEMBER), oplogEdge(c, -1, ANY_MEMBER), oplogStorage(c, ANY_MEMBER)]);
    const first = entryTime(oldest);
    const last = entryTime(newest);
    if (first === null && last === null && storage.maxBytes === null) return { status: 'none', error: null, ...empty };
    return {
      status: 'ok',
      error: null,
      at,
      first,
      last,
      usedBytes: storage.usedBytes,
      maxBytes: storage.maxBytes,
      full: isFull(storage),
      fillsInMs: fillsIn(first, last, storage.usedBytes, storage.maxBytes),
    };
  } catch (e) {
    if (isUnauthorized(e)) return { status: 'denied', error: null, ...empty };
    // standalone엔 local.oplog.rs가 없다
    if (codeOf(e) === NAMESPACE_NOT_FOUND) return { status: 'none', error: null, ...empty };
    return { status: 'error', error: errorMessage(e), ...empty };
  }
};
