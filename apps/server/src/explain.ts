// 쿼리 바의 Explain (9-9) — find(쿼리).explain('executionStats') 결과를 화면용으로 줄인다.
// 계획(단계 나무)의 모양은 MongoDB마다 다르다:
//   옛 엔진 — queryPlanner.winningPlan이 바로 나무(stage + inputStage / inputStages)
//   SBE(7.x 이상의 일부 쿼리) — winningPlan.queryPlan 안에 같은 나무. 옆의 slotBasedPlan은 엔진 내부라 안 본다
//   샤드(mongos) — winningPlan.shards[]마다 그 샤드의 winningPlan
// 숫자(nReturned 등)는 셋 다 executionStats 맨 위에 있다.
import { BSON } from 'mongodb';
import type { ExplainPlanNode, ExplainSummary } from '@mongolive/shared';

// 복사용 날것의 상한 — 넘으면 보내지 않는다(요약은 그대로)
export const EXPLAIN_RAW_MAX = 256 * 1024;
const MAX_DEPTH = 64;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// number / bigint / Long·Int32·Double
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (isObj(v) && typeof v.toNumber === 'function') return (v.toNumber as () => number).call(v);
  if (isObj(v) && typeof v.valueOf === 'function') {
    const n = (v.valueOf as () => unknown).call(v);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  }
  return null;
};

const keyPatternOf = (kp: Obj): Record<string, number | string> => {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(kp)) out[k] = typeof v === 'string' ? v : num(v) ?? String(v);
  return out;
};

const planOf = (node: unknown, depth = 0): ExplainPlanNode => {
  if (!isObj(node) || depth > MAX_DEPTH) return { stage: '?', inputs: [] };
  if (isObj(node.queryPlan)) return planOf(node.queryPlan, depth + 1);
  const inputs: ExplainPlanNode[] = [];
  if (isObj(node.inputStage)) inputs.push(planOf(node.inputStage, depth + 1));
  if (Array.isArray(node.inputStages)) for (const s of node.inputStages) inputs.push(planOf(s, depth + 1));
  if (Array.isArray(node.shards)) {
    for (const s of node.shards) {
      if (!isObj(s)) continue;
      const p = planOf(s.winningPlan, depth + 1);
      if (typeof s.shardName === 'string') p.shard = s.shardName;
      inputs.push(p);
    }
  }
  const out: ExplainPlanNode = { stage: typeof node.stage === 'string' ? node.stage : '?', inputs };
  if (typeof node.indexName === 'string') out.index = node.indexName;
  if (isObj(node.keyPattern)) out.keyPattern = keyPatternOf(node.keyPattern);
  return out;
};

const walk = (node: ExplainPlanNode, visit: (n: ExplainPlanNode) => void) => {
  visit(node);
  for (const i of node.inputs) walk(i, visit);
};

const rawOf = (explain: Obj): string | null => {
  // 서버 시계·서명은 쿼리와 상관없는 잡음
  const { $clusterTime: _clock, operationTime: _op, ...rest } = explain;
  try {
    const text = BSON.EJSON.stringify(rest, undefined, 2, { relaxed: true });
    return text.length > EXPLAIN_RAW_MAX ? null : text;
  } catch {
    return null;
  }
};

export const summarizeExplain = (explain: unknown): ExplainSummary => {
  const root: Obj = isObj(explain) ? explain : {};
  const planner: Obj = isObj(root.queryPlanner) ? root.queryPlanner : {};
  const stats: Obj = isObj(root.executionStats) ? root.executionStats : {};
  const plan = planOf(planner.winningPlan);

  let rejectedPlans = Array.isArray(planner.rejectedPlans) ? planner.rejectedPlans.length : 0;
  const winning = isObj(planner.winningPlan) ? planner.winningPlan : {};
  if (Array.isArray(winning.shards)) {
    for (const s of winning.shards) if (isObj(s) && Array.isArray(s.rejectedPlans)) rejectedPlans += s.rejectedPlans.length;
  }

  const indexes: string[] = [];
  let collectionScan = false;
  walk(plan, (n) => {
    if (n.stage === 'COLLSCAN') collectionScan = true;
    if (n.index && !indexes.includes(n.index)) indexes.push(n.index);
  });

  return {
    plan,
    returned: num(stats.nReturned),
    keysExamined: num(stats.totalKeysExamined),
    docsExamined: num(stats.totalDocsExamined),
    timeMs: num(stats.executionTimeMillis),
    rejectedPlans,
    indexes,
    collectionScan,
    raw: rawOf(root),
  };
};
