// 인덱스 사용량 (9-6b) — Monitor › Collections를 컬렉션 하나로 좁혔을 때의 Indexes 카드
//
// 화면이 열 때와 새로고침 버튼을 누를 때만 묻는다(기록하지 않는다). 셋 다 읽기 전용:
//   listIndexes                         — 정의(키·unique·TTL·부분·숨김)
//   $indexStats                         — 쓰인 횟수와 언제부터 셌나. 연결된 멤버(보통 primary)의 카운터라 재시작하면 0부터
//   $collStats storageStats.indexSizes  — 인덱스마다 디스크 크기
// 샤드 클러스터면 $indexStats·$collStats가 샤드마다 한 문서씩 와서 더한다(since는 가장 늦은 것 — 모든 샤드가 센 구간).
// 권한: $indexStats는 indexStats 액션(clusterMonitor 등) — 없으면 정의·크기만 보여 준다.
import type { Document as BsonDocument, Collection, MongoClient } from 'mongodb';
import { formatQueryValue, type EjsonValue, type IndexesReport, type IndexUsageRow } from '@mongolive/shared';
import { toWire } from '../wire';
import { isUnauthorized } from './operations';
import { withTimeout } from './sampler';

const NAMESPACE_NOT_FOUND = 26;
const VIEW_NOT_SUPPORTED = 166;

const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = typeof (value as { toNumber?: unknown }).toNumber === 'function' ? (value as { toNumber: () => number }).toNumber() : Number(value);
  return Number.isFinite(n) ? n : null;
};
const codeOf = (e: unknown) => Number((e as { code?: unknown })?.code);
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 키 패턴을 보여 줄 모양으로 — 숫자는 숫자, 나머지('text'·'2dsphere'·'hashed')는 글자. 텍스트 인덱스는 _fts 대신 필드 이름
export const keyPattern = (key: BsonDocument | undefined, weights?: BsonDocument): Record<string, number | string> => {
  const out: Record<string, number | string> = {};
  for (const [field, value] of Object.entries(key ?? {})) {
    if (field === '_fts' || field === '_ftsx') {
      if (field === '_fts') for (const name of Object.keys(weights ?? { $text: 1 })) out[name] = 'text';
      continue;
    }
    const n = num(value);
    out[field] = typeof value === 'string' || n === null ? String(value) : n;
  }
  return out;
};

// 세 결과를 한 표로. usage·sizes가 null이면 그 칸은 비운다(못 읽음)
export const mergeIndexes = (specs: BsonDocument[], usage: BsonDocument[] | null, sizes: BsonDocument[] | null): IndexUsageRow[] => {
  const used = new Map<string, { ops: number; since: number | null; building: boolean; key: BsonDocument | undefined }>();
  for (const doc of usage ?? []) {
    const name = String(doc.name);
    const accesses = (doc.accesses ?? {}) as { ops?: unknown; since?: unknown };
    const since = accesses.since instanceof Date ? accesses.since.getTime() : null;
    const prev = used.get(name);
    used.set(name, {
      ops: (prev?.ops ?? 0) + (num(accesses.ops) ?? 0),
      since: prev?.since == null ? since : since === null ? prev.since : Math.max(prev.since, since),
      building: (prev?.building ?? false) || doc.building === true,
      key: prev?.key ?? (doc.key as BsonDocument | undefined),
    });
  }
  const bytes = new Map<string, number>();
  for (const doc of sizes ?? []) {
    const indexSizes = ((doc.storageStats ?? {}) as { indexSizes?: BsonDocument }).indexSizes ?? {};
    for (const [name, size] of Object.entries(indexSizes)) bytes.set(name, (bytes.get(name) ?? 0) + (num(size) ?? 0));
  }

  const row = (name: string, spec: BsonDocument | null): IndexUsageRow => {
    const u = used.get(name);
    return {
      name,
      key: keyPattern((spec?.key as BsonDocument | undefined) ?? u?.key, spec?.weights as BsonDocument | undefined),
      ops: usage ? (u?.ops ?? 0) : null,
      since: u?.since ?? null,
      size: sizes ? (bytes.get(name) ?? null) : null,
      unique: spec?.unique === true,
      sparse: spec?.sparse === true,
      partial: spec?.partialFilterExpression ? formatQueryValue(toWire<EjsonValue>(spec.partialFilterExpression)) : null,
      hidden: spec?.hidden === true,
      ttl: spec ? num(spec.expireAfterSeconds) : null,
      building: u?.building ?? false,
    };
  };
  const rows = specs.map((spec) => row(String(spec.name), spec));
  // listIndexes는 다 만든 것만 보여 준다 — 만드는 중인 건 $indexStats에만 있다
  const listed = new Set(rows.map((r) => r.name));
  for (const [name, u] of used) if (!listed.has(name) && u.building) rows.push(row(name, null));
  return rows;
};

export const listIndexUsage = async (getClient: () => Promise<MongoClient>, database: string, collection: string): Promise<IndexesReport> => {
  const at = Date.now();
  let coll: Collection;
  let specs: BsonDocument[];
  try {
    coll = (await getClient()).db(database).collection(collection);
    specs = await withTimeout(coll.listIndexes().toArray());
  } catch (e) {
    const code = codeOf(e);
    const error =
      code === NAMESPACE_NOT_FOUND ? 'This collection does not exist (yet) — no indexes.'
      : code === VIEW_NOT_SUPPORTED ? 'This is a view — views have no indexes of their own.'
      : isUnauthorized(e) ? 'Not allowed to list indexes — the user needs the listIndexes action (e.g. the read role).'
      : errorMessage(e);
    return { at, error, usageError: null, rows: [] };
  }
  const [usage, sizes] = await Promise.all([
    withTimeout(coll.aggregate([{ $indexStats: {} }, { $project: { name: 1, key: 1, accesses: 1, building: 1 } }], { maxTimeMS: 5000 }).toArray()).then(
      (docs) => ({ docs, error: null }),
      (e: unknown) => ({
        docs: null,
        error: isUnauthorized(e) ? 'Usage counts need the indexStats action (e.g. the clusterMonitor role).' : `Could not read usage counts: ${errorMessage(e)}`,
      }),
    ),
    withTimeout(coll.aggregate([{ $collStats: { storageStats: {} } }, { $project: { _id: 0, 'storageStats.indexSizes': 1 } }], { maxTimeMS: 5000 }).toArray()).catch(() => null),
  ]);
  return { at, error: null, usageError: usage.error, rows: mergeIndexes(specs, usage.docs, sizes) };
};
