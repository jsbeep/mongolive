// 탐색하며 모으기(Collect) — 결과 문서의 필드·값에서 고른 동작을 파이프라인 스테이지로 바꾸고, 규칙이 맞으면 기존 스테이지에 쌓는다.
// '마지막 스테이지' = 모으는 자리의 스테이지(편집 중인 스테이지 > 고른 스테이지, 그 뒤에 이어진 아직 안 돌린 스테이지가 있으면 그 끝).
//   $match         마지막이 $match면 조건을 더한다 — 같은 필드의 다른 비교는 범위로 합치고(> 와 <), 같은 비교는 바꾼다(replaced로 알린다)
//   $sort          마지막이 $sort면 더한다 — 같은 필드는 방향만 바꾸고, 새 필드는 보조 정렬 키(뒤에)
//   $project       마지막이 $project이고 포함/제외 방식이 같을 때만 더한다 — 섞이면(MongoDB가 거절) 새 스테이지
//   $group · $sortByCount · $lookup   늘 새 스테이지
import { isPlainObject, isWrapperObject, makeInt32, numericValue, type EjsonObject, type EjsonValue } from './ejson';
import { addCondition, CONDITION_OP_LABEL, formatQueryValue, type Condition } from './queryConditions';

export type CollectAction =
  | { kind: 'match'; conditions: Condition[] }
  | { kind: 'sort'; field: string; direction: 1 | -1 }
  | { kind: 'project'; field: string; include: boolean }
  | { kind: 'group'; field: string }
  | { kind: 'count'; field: string }
  | { kind: 'lookup'; from: string; localField: string; foreignField: string; as: string };

export type CollectResult =
  // 마지막 스테이지에 쌓았다 — replaced: 조건이 바뀐 필드(같은 비교를 새 값으로), unchanged: 이미 그대로 있었다
  | { mode: 'merge'; stage: EjsonObject; replaced: string[]; unchanged: boolean }
  // 마지막 스테이지 바로 뒤에 새로
  | { mode: 'new'; stage: EjsonObject };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// { $gt: 1 } 같은 연산자 객체인가(EJSON 래퍼 { $numberInt } 등은 값)
const isOperatorObject = (value: unknown): value is Record<string, EjsonValue> =>
  isPlainObject(value) && !isWrapperObject(value) && Object.keys(value).length > 0 && Object.keys(value)[0].startsWith('$');

const MONGO_OP: Record<string, string> = {
  ne: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte', in: '$in', nin: '$nin', exists: '$exists', type: '$type', size: '$size',
};

// 이 조건을 더하면 그 필드에 있던 조건이 바뀌나(같은 비교의 다른 값, 또는 '='·정규식과 섞을 수 없어 대신하는 경우)
const replacesExisting = (filter: EjsonObject, condition: Condition): boolean => {
  if (!(condition.field in filter)) return false;
  const current = filter[condition.field];
  if (condition.op === 'eq' || condition.op === 'regex') return !sameJson(current, condition.value);
  if (!isOperatorObject(current)) return true;
  const key = MONGO_OP[condition.op];
  if (key in current) return !sameJson(current[key], condition.value);
  return '$eq' in current || '$regex' in current;
};

// 스테이지 하나가 { $이름: 객체 }인가 — 그 객체(아니면 null)
const body = (stage: EjsonObject | null, name: string): EjsonObject | null => {
  if (!stage || Object.keys(stage).length !== 1 || !(name in stage)) return null;
  const value = stage[name];
  return isPlainObject(value) && !isWrapperObject(value) ? (value as EjsonObject) : null;
};

// $project의 방식 — _id 말고 모두 0/false면 제외, 모두 그 밖이면 포함, _id뿐이면 아무 쪽이나, 섞였으면 mixed
type ProjectMode = 'include' | 'exclude' | 'any' | 'mixed';
const isOff = (value: EjsonValue) => value === false || numericValue(value) === 0;
const projectMode = (fields: EjsonObject): ProjectMode => {
  const keys = Object.keys(fields).filter((k) => k !== '_id');
  if (!keys.length) return 'any';
  const off = keys.filter((k) => isOff(fields[k])).length;
  return off === keys.length ? 'exclude' : off === 0 ? 'include' : 'mixed';
};
const projectFits = (mode: ProjectMode, field: string, include: boolean): boolean => {
  if (mode === 'mixed') return false;
  // _id 빼기는 포함 방식에서도 된다
  if (field === '_id' && !include) return true;
  return mode === 'any' || mode === (include ? 'include' : 'exclude');
};

// last = 모으는 자리의 마지막 스테이지(없거나 꺼졌거나 못 읽으면 null — 그러면 늘 새 스테이지)
export const collectInto = (last: EjsonObject | null, action: CollectAction): CollectResult => {
  switch (action.kind) {
    case 'match': {
      const current = body(last, '$match');
      if (!current) {
        const filter = action.conditions.reduce<EjsonObject>((f, c) => addCondition(f, c), {});
        return { mode: 'new', stage: { $match: filter } };
      }
      const replaced: string[] = [];
      let filter = current;
      for (const condition of action.conditions) {
        if (replacesExisting(filter, condition) && !replaced.includes(condition.field)) replaced.push(condition.field);
        filter = addCondition(filter, condition);
      }
      return { mode: 'merge', stage: { $match: filter }, replaced, unchanged: sameJson(filter, current) };
    }
    case 'sort': {
      const direction = makeInt32(action.direction);
      const current = body(last, '$sort');
      if (!current) return { mode: 'new', stage: { $sort: { [action.field]: direction } } };
      // 같은 필드면 그 자리에서 방향만, 새 필드면 뒤에(보조 정렬 키) — 객체 키 순서가 곧 정렬 순서
      const fields: EjsonObject = { ...current, [action.field]: direction };
      return { mode: 'merge', stage: { $sort: fields }, replaced: [], unchanged: sameJson(fields, current) };
    }
    case 'project': {
      const value = makeInt32(action.include ? 1 : 0);
      const current = body(last, '$project');
      if (!current || !projectFits(projectMode(current), action.field, action.include)) {
        return { mode: 'new', stage: { $project: { [action.field]: value } } };
      }
      const fields: EjsonObject = { ...current, [action.field]: value };
      return { mode: 'merge', stage: { $project: fields }, replaced: [], unchanged: sameJson(fields, current) };
    }
    case 'group':
      return { mode: 'new', stage: { $group: { _id: `$${action.field}`, count: { $sum: makeInt32(1) } } } };
    case 'count':
      return { mode: 'new', stage: { $sortByCount: `$${action.field}` } };
    case 'lookup':
      return {
        mode: 'new',
        stage: { $lookup: { from: action.from, localField: action.localField, foreignField: action.foreignField, as: action.as } },
      };
  }
};

// 카드·알림에 보일 동작 이름 — "score > 100", "sort time ↓", "group by author"
export const describeCollectAction = (action: CollectAction): string => {
  switch (action.kind) {
    case 'match': return action.conditions.map((c) => `${c.field} ${CONDITION_OP_LABEL[c.op]} ${formatQueryValue(c.value)}`).join(', ');
    case 'sort': return `sort ${action.field} ${action.direction === 1 ? '↑' : '↓'}`;
    case 'project': return `${action.include ? 'include' : 'exclude'} ${action.field}`;
    case 'group': return `group by ${action.field}`;
    case 'count': return `count ${action.field} values`;
    case 'lookup': return `lookup ${action.from}`;
  }
};
