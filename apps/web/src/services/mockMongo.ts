// Mock(공개 데모)의 MongoDB 쿼리·집계 — mingo로 흉내 낸다. 데모 빌드에서만 불린다(mockAPI가 필요할 때 동적으로 import).
//   Canonical EJSON → mingo가 비교·계산할 수 있는 JS 값으로 바꿔 넘기고(toEngine), 결과는 다시 Canonical EJSON으로(fromEngine).
//   숫자: Int32/Long/Double/Decimal → JS number(아주 큰 Long·Decimal은 정밀도가 깎인다 — 데모라 감수)
//   날짜: Date / ObjectId: 아래 ObjectId(toString = hex — mingo는 toString으로 같은지·순서를 본다, hex 순서 = MongoDB 순서)
//   그 밖의 BSON(Binary, Timestamp, Regex …): Opaque로 감싸 그대로 지나가게(같은지만 본다)
//   결과를 되돌릴 때는 원본 문서(같은 _id)를 힌트로 써서, 값이 그대로면 원래 타입(Long·Double …)을 지킨다.
//   계산으로 새로 생긴 숫자는 정수면 Int32(넘치면 Long), 아니면 Double.
// 서버(routes/aggregate.ts)와 같은 규칙: 결과 AGGREGATE_RESULT_LIMIT개, 스테이지 개수 AGGREGATE_COUNT_LIMIT에서 멈춤,
// 막힌 스테이지에서 개수 세기를 멈추고 그 스테이지를 알린다. 검사(validatePipeline·validateQueryFilter)는 부르는 쪽(mockAPI)이 먼저.
import { Aggregator, Query } from 'mingo';
import {
  AGGREGATE_COUNT_LIMIT,
  AGGREGATE_RESULT_LIMIT,
  dateMs,
  isPlainObject,
  makeDate,
  makeDouble,
  makeInt32,
  makeLong,
  numericValue,
  valueKind,
  type AggregateCounts,
  type EjsonObject,
  type EjsonValue,
  type StageCount,
} from '@mongolive/shared';

// ── 엔진 쪽 값 ──────────────────────────────────────────────────────────────

export class ObjectId {
  constructor(readonly hex: string) {}
  toString() {
    return this.hex;
  }
}
// 빌드가 클래스 이름을 줄여도 mingo가 보는 타입 이름(constructor.name)은 그대로
Object.defineProperty(ObjectId, 'name', { value: 'ObjectId' });

class Opaque {
  constructor(readonly ejson: EjsonValue) {}
  toString() {
    return JSON.stringify(this.ejson);
  }
}
Object.defineProperty(Opaque, 'name', { value: 'Opaque' });

type EngineValue = unknown;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

// Canonical EJSON(또는 plain JSON) → mingo 값
export const toEngine = (value: unknown): EngineValue => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toEngine);
  if (!isPlainObject(value)) return value;
  switch (valueKind(value)) {
    case 'int32':
    case 'double':
    case 'long':
    case 'decimal128':
      return numericValue(value) ?? null;
    case 'oid':
      return new ObjectId(String((value as { $oid: string }).$oid).toLowerCase());
    case 'date':
      return new Date(dateMs(value)!);
    case 'opaque': {
      const regex = (value as { $regularExpression?: { pattern?: unknown; options?: unknown } }).$regularExpression;
      if (regex && typeof regex.pattern === 'string') {
        // JS가 모르는 옵션(x 등)은 뺀다
        const flags = String(regex.options ?? '').split('').filter((f) => 'imsu'.includes(f)).join('');
        try {
          return new RegExp(regex.pattern, flags);
        } catch {
          return new Opaque(value as EjsonValue);
        }
      }
      return new Opaque(value as EjsonValue);
    }
    default: {
      const out: Record<string, EngineValue> = {};
      for (const [key, item] of Object.entries(value)) out[key] = toEngine(item);
      return out;
    }
  }
};

// 같은 문서를 알아보는 열쇠 — _id 값으로
const idKey = (id: EngineValue): string | null => {
  if (id === null || id === undefined) return null;
  if (id instanceof ObjectId) return `oid:${id.hex}`;
  if (id instanceof Date) return `date:${id.getTime()}`;
  if (typeof id === 'number') return `n:${id}`;
  if (typeof id === 'string') return `s:${id}`;
  try {
    return `j:${JSON.stringify(id)}`;
  } catch {
    return null;
  }
};

const inferNumber = (n: number): EjsonValue => {
  if (Number.isInteger(n) && !Object.is(n, -0)) {
    if (n >= INT32_MIN && n <= INT32_MAX) return makeInt32(n);
    if (Number.isSafeInteger(n)) return makeLong(n);
  }
  return makeDouble(n);
};

// mingo 값 → Canonical EJSON. hint = 같은 자리의 원본 값(있으면 타입을 지키는 데 쓴다), originals = _id → 원본 문서
const fromEngine = (value: EngineValue, hint: unknown, originals: Map<string, EjsonObject>): EjsonValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    const hinted = numericValue(hint);
    return hinted !== undefined && (hinted === value || (Number.isNaN(hinted) && Number.isNaN(value))) ? (hint as EjsonValue) : inferNumber(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof ObjectId) return { $oid: value.hex };
  if (value instanceof Date) {
    const hinted = dateMs(hint);
    return hinted === value.getTime() ? (hint as EjsonValue) : makeDate(value);
  }
  if (value instanceof RegExp) return { $regularExpression: { pattern: value.source, options: value.flags.split('').sort().join('') } };
  if (value instanceof Opaque) return value.ejson;
  if (Array.isArray(value)) {
    const hints = Array.isArray(hint) ? hint : [];
    return value.map((item, i) => fromEngine(item, hints[i], originals));
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, EngineValue>;
  // 자리 힌트가 다른 문서면(또는 없으면) _id로 원본을 찾는다 — $lookup으로 붙은 문서, $unwind로 나온 문서
  let base = isPlainObject(hint) ? (hint as Record<string, unknown>) : undefined;
  const key = '_id' in record ? idKey(record._id) : null;
  if (key && (!base || idKey(toEngine(base._id)) !== key)) base = originals.get(key) ?? base;
  const out: EjsonObject = {};
  for (const [k, item] of Object.entries(record)) {
    if (item === undefined) continue;
    out[k] = fromEngine(item, base?.[k], originals);
  }
  return out;
};

// ── 쿼리 ────────────────────────────────────────────────────────────────────

// 필터에 맞는 문서의 번호(입력 순서) — 문서는 원본 그대로 쓰도록 번호만 돌려준다
export const matchingIndexes = (documents: readonly EjsonObject[], filter: EjsonObject): number[] => {
  const query = new Query(toEngine(filter) as Record<string, unknown>, { scriptEnabled: false });
  const hits: number[] = [];
  documents.forEach((document, i) => {
    if (query.test(toEngine(document) as Record<string, unknown>)) hits.push(i);
  });
  return hits;
};

// ── 집계 ────────────────────────────────────────────────────────────────────

// 같은 DB의 컬렉션 이름 → 문서들($lookup·$unionWith·$graphLookup의 from). 없으면 빈 컬렉션
export type CollectionSource = (name: string) => readonly EjsonObject[] | undefined;

const makeRunner = (documents: readonly EjsonObject[], source: CollectionSource) => {
  const originals = new Map<string, EjsonObject>();
  const remember = (docs: readonly EjsonObject[]) => {
    for (const doc of docs) {
      const key = idKey(toEngine(doc._id));
      if (key && !originals.has(key)) originals.set(key, doc);
    }
  };
  remember(documents);
  const engineCache = new Map<string, EngineValue[]>();
  const collectionResolver = (name: string) => {
    let cached = engineCache.get(name);
    if (!cached) {
      const docs = source(name) ?? [];
      remember(docs);
      cached = docs.map(toEngine);
      engineCache.set(name, cached);
    }
    return cached as Record<string, unknown>[];
  };
  // mingo는 입력을 고칠 수 있다 — 실행마다 새로 바꿔 넘긴다
  const run = (pipeline: readonly EjsonObject[]) => {
    const aggregator = new Aggregator(toEngine(pipeline) as Record<string, unknown>[], { collectionResolver, scriptEnabled: false });
    return aggregator.run(documents.map(toEngine) as Record<string, unknown>[]) as EngineValue[];
  };
  return { run, originals };
};

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const aggregateDocuments = (documents: readonly EjsonObject[], pipeline: readonly EjsonObject[], source: CollectionSource) => {
  const { run, originals } = makeRunner(documents, source);
  const rows = run(pipeline);
  return {
    results: rows.slice(0, AGGREGATE_RESULT_LIMIT).map((row) => fromEngine(row, undefined, originals)),
    truncated: rows.length > AGGREGATE_RESULT_LIMIT,
  };
};

// 스테이지마다 '여기까지 몇 개' — 0 = 들어오는 문서. 막히면 거기서 멈추고 그 스테이지(0부터)를 알린다
export const countPipelineStages = (documents: readonly EjsonObject[], pipeline: readonly EjsonObject[], source: CollectionSource): Omit<AggregateCounts, 'elapsedMs'> => {
  const { run } = makeRunner(documents, source);
  const counts: StageCount[] = [];
  for (let i = 0; i <= pipeline.length; i++) {
    try {
      const n = i === 0 ? documents.length : run(pipeline.slice(0, i)).length;
      counts.push({ n: Math.min(n, AGGREGATE_COUNT_LIMIT), capped: n > AGGREGATE_COUNT_LIMIT });
    } catch (e) {
      return { counts, error: { stage: i - 1, message: errorMessage(e) } };
    }
  }
  return { counts };
};
