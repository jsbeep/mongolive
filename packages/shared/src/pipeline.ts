// 사용자가 쓴 aggregation 파이프라인이 허용 범위 안인지 — 서버가 실행 전에 꼭 거치고, 브라우저도 보내기 전에 같은 검사.
//   - 파이프라인 = 스테이지 객체의 배열, 스테이지마다 키 하나($이름)
//   - 맨 위 스테이지는 허용 목록으로(읽기만 하는 것들). $out·$merge(쓰기)는 언제나 막는다 — 사용자 MongoDB를 그대로 둔다
//   - $match는 find 쿼리와 같은 검사(validateQueryFilter)
//   - 그 밖의 스테이지는 안을 끝까지 훑어 JS 실행($where·$function·$accumulator)과 쓰기($out·$merge)를 막는다
//     ($facet·$lookup·$unionWith 안의 하위 파이프라인에 숨겨도 걸린다). 표현식 이름이 맞는지는 MongoDB가 판정한다.
import { isPlainObject, valueKind, type EjsonObject, type EjsonValue } from './ejson';
import { CONDITION_OP_LABEL, describeFilter, formatQueryValue } from './queryConditions';
import { validateQueryFilter, type QueryFilterError } from './queryFilter';

export const PIPELINE_STAGES = [
  '$match', '$project', '$addFields', '$set', '$unset', '$group', '$sort', '$limit', '$skip', '$unwind', '$count',
  '$lookup', '$graphLookup', '$unionWith', '$facet', '$bucket', '$bucketAuto', '$sortByCount',
  '$replaceRoot', '$replaceWith', '$sample', '$redact', '$setWindowFields', '$densify', '$fill',
] as const;

const STAGES = new Set<string>(PIPELINE_STAGES);
const BLOCKED_STAGES: Record<string, string> = {
  $out: 'writes to your database — MongoLive only reads',
  $merge: 'writes to your database — MongoLive only reads',
  $currentOp: 'is not supported (server internals)',
  $listSessions: 'is not supported (server internals)',
  $listLocalSessions: 'is not supported (server internals)',
  $planCacheStats: 'is not supported (server internals)',
  $indexStats: 'is not supported (server internals)',
  $collStats: 'is not supported (server internals)',
  $documents: 'is not supported',
  $geoNear: 'is not supported (geo queries)',
  $search: 'is not supported (Atlas Search)',
  $vectorSearch: 'is not supported (Atlas Search)',
};
// 어디에 있든 막는 것
const FORBIDDEN_ANYWHERE: Record<string, string> = {
  $where: 'runs JavaScript on the server',
  $function: 'runs JavaScript on the server',
  $accumulator: 'runs JavaScript on the server',
  $out: 'writes to your database — MongoLive only reads',
  $merge: 'writes to your database — MongoLive only reads',
};

// 한 번에 이보다 긴 파이프라인은 거절 — 사람이 쓰는 파이프라인은 이만큼 길어질 일이 없다
export const PIPELINE_MAX_STAGES = 50;
const MAX_DEPTH = 64;

class Invalid extends Error {
  constructor(message: string, public path: string) {
    super(message);
  }
}

const join = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));

const scan = (value: unknown, path: string, depth: number): void => {
  if (depth > MAX_DEPTH) throw new Invalid('Pipeline is nested too deeply', path);
  if (Array.isArray(value)) {
    value.forEach((item, i) => scan(item, join(path, i), depth + 1));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const at = join(path, key);
    if (key in FORBIDDEN_ANYWHERE) throw new Invalid(`${key} ${FORBIDDEN_ANYWHERE[key]}`, at);
    scan(item, at, depth + 1);
  }
};

// 스테이지 하나({ $match: … }) — 문제 있으면 path는 그 스테이지 안의 위치("$match.age.$foo")
export const validatePipelineStage = (stage: unknown): QueryFilterError | null => {
  try {
    if (!isPlainObject(stage)) throw new Invalid('A stage is an object like { $match: { … } }', '');
    const keys = Object.keys(stage);
    if (keys.length !== 1) throw new Invalid(keys.length ? 'A stage has exactly one $operator' : 'Stage is empty', '');
    const [name] = keys;
    if (name in BLOCKED_STAGES) throw new Invalid(`${name} ${BLOCKED_STAGES[name]}`, name);
    if (!STAGES.has(name)) throw new Invalid(name.startsWith('$') ? `Unknown stage ${name}` : `A stage name starts with $ (found "${name}")`, name);
    const body = stage[name];
    if (name === '$match') {
      const invalid = validateQueryFilter(body);
      if (invalid) throw new Invalid(invalid.message, join(name, invalid.path));
      return null;
    }
    scan(body, name, 1);
    return null;
  } catch (e) {
    if (e instanceof Invalid) return { message: e.message, path: e.path };
    throw e;
  }
};

// 파이프라인 전체 — path는 "2.$group._id" 처럼 스테이지 번호(0부터)부터
export const validatePipeline = (pipeline: unknown): QueryFilterError | null => {
  if (!Array.isArray(pipeline)) return { message: 'A pipeline is an array of stages like [{ $match: … }]', path: '' };
  if (pipeline.length > PIPELINE_MAX_STAGES) return { message: `At most ${PIPELINE_MAX_STAGES} stages`, path: '' };
  for (let i = 0; i < pipeline.length; i++) {
    const invalid = validatePipelineStage(pipeline[i]);
    if (invalid) return { message: invalid.message, path: invalid.path ? join(String(i), invalid.path) : String(i) };
  }
  return null;
};

// ── 서버 응답 ────────────────────────────────────────────────────────────────

// 결과 상한 — 넘으면 truncated(화면에 작게 알린다)
export const AGGREGATE_RESULT_LIMIT = 500;
// 스테이지별 개수는 이 수까지만 센다(넘으면 capped — "10,000+")
export const AGGREGATE_COUNT_LIMIT = 10_000;

export interface AggregateResult {
  // Canonical EJSON
  results: unknown[];
  // 상한(AGGREGATE_RESULT_LIMIT)에 걸려 잘렸다
  truncated: boolean;
  elapsedMs: number;
}

export interface StageCount {
  n: number;
  // 상한(AGGREGATE_COUNT_LIMIT)에서 멈췄다 — 실제로는 더 많다
  capped: boolean;
}

// 스테이지 카드의 "31 → 12" — counts[0] = 들어오는 문서(컬렉션), counts[i + 1] = i번 스테이지를 지난 문서
export interface AggregateCounts {
  counts: StageCount[];
  // 세다가 막힌 스테이지(0부터) — 그 뒤는 세지 않았다
  error?: { stage: number; message: string };
  elapsedMs: number;
}

// ── 스테이지 카드의 한 줄 요약 ────────────────────────────────────────────────

export const stageName = (stage: EjsonObject): string => Object.keys(stage)[0] ?? '';

const SUMMARY_MAX = 80;
const clip = (text: string) => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text);
// "$author" → author (필드 경로 표현식이면 이름만)
const fieldRef = (value: EjsonValue): string | null =>
  typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$') ? value.slice(1) : null;
const keysOf = (value: EjsonValue): string[] => (isPlainObject(value) ? Object.keys(value) : []);
const numberOf = (value: EjsonValue): string | null => {
  const kind = valueKind(value);
  return kind === 'int32' || kind === 'long' || kind === 'double' || kind === 'decimal128' ? formatQueryValue(value) : null;
};

const describeMatch = (body: EjsonValue): string => {
  if (!isPlainObject(body)) return formatQueryValue(body);
  const chips = describeFilter(body as EjsonObject);
  if (!chips.length) return 'all documents';
  return chips
    .map((chip) => (chip.kind === 'custom' ? chip.field : `${chip.field} ${CONDITION_OP_LABEL[chip.op]} ${formatQueryValue(chip.value)}`))
    .join(', ');
};

const describeGroupKey = (id: EjsonValue): string => {
  if (id === null) return 'all into one';
  const ref = fieldRef(id);
  if (ref) return `by ${ref}`;
  if (isPlainObject(id) && valueKind(id) === 'object') return `by ${Object.entries(id).map(([k, v]) => fieldRef(v) ?? k).join(', ')}`;
  return `by ${formatQueryValue(id)}`;
};

const describeSort = (body: EjsonValue): string =>
  Object.entries(isPlainObject(body) ? body : {})
    .map(([key, dir]) => {
      const n = Number(numberOf(dir));
      return n === 1 ? `${key} ↑` : n === -1 ? `${key} ↓` : key;
    })
    .join(', ');

const describeProject = (body: EjsonValue): string =>
  Object.entries(isPlainObject(body) ? body : {})
    .map(([key, v]) => (v === false || numberOf(v) === '0' ? `−${key}` : key))
    .join(', ');

// 카드에 보일 한 줄 — 모르는 모양이면 본문을 줄여서
export const summarizeStage = (stage: EjsonObject): string => {
  const name = stageName(stage);
  const body = stage[name];
  const obj = isPlainObject(body) ? (body as EjsonObject) : {};
  switch (name) {
    case '$match':
      return clip(describeMatch(body));
    case '$group': {
      const out = keysOf(body).filter((k) => k !== '_id');
      return clip(`${describeGroupKey(obj._id ?? null)}${out.length ? ` → ${out.join(', ')}` : ''}`);
    }
    case '$sort':
      return clip(describeSort(body));
    case '$limit':
      return `first ${numberOf(body) ?? formatQueryValue(body)}`;
    case '$skip':
      return `skip ${numberOf(body) ?? formatQueryValue(body)}`;
    case '$sample':
      return `${numberOf(obj.size ?? null) ?? '?'} at random`;
    case '$project':
      return clip(describeProject(body));
    case '$addFields':
    case '$set':
      return clip(`+ ${keysOf(body).join(', ')}`);
    case '$unset':
      return clip(`− ${(Array.isArray(body) ? body : [body]).map((v) => (typeof v === 'string' ? v : formatQueryValue(v))).join(', ')}`);
    case '$unwind':
      return clip(fieldRef(typeof body === 'string' ? body : (obj.path ?? null)) ?? formatQueryValue(body));
    case '$lookup':
    case '$graphLookup':
      return clip(`${typeof obj.from === 'string' ? obj.from : '?'} as ${typeof obj.as === 'string' ? obj.as : '?'}`);
    case '$unionWith':
      return clip(`+ ${typeof body === 'string' ? body : typeof obj.coll === 'string' ? obj.coll : '?'}`);
    case '$count':
      return clip(`→ ${typeof body === 'string' ? body : '?'}`);
    case '$sortByCount':
      return clip(fieldRef(body) ? `by ${fieldRef(body)}` : formatQueryValue(body));
    case '$replaceRoot':
      return clip(fieldRef(obj.newRoot ?? null) ?? formatQueryValue(obj.newRoot ?? null));
    case '$replaceWith':
      return clip(fieldRef(body) ?? formatQueryValue(body));
    case '$facet':
      return clip(keysOf(body).join(', '));
    case '$bucket':
    case '$bucketAuto':
      return clip(fieldRef(obj.groupBy ?? null) ? `by ${fieldRef(obj.groupBy ?? null)}` : formatQueryValue(obj.groupBy ?? null));
    default:
      return clip(formatQueryValue(body));
  }
};
