// 쿼리 바의 Explain 결과를 글로 (9-9) — 단계 흐름 한 줄, 단계마다 쉬운 설명, 판정 한 줄
//   흐름은 먼저 도는 단계부터: 'IXSCAN { age: 1 } → FETCH'. 갈래는 '(A + B) → OR'
//   판정: 인덱스 없이 전체(작으면 info, 크면 warn) / 인덱스는 썼지만 낭비 큼(warn) / 바로 찾음·인덱스 잘 씀(good)
import type { ExplainPlanNode, ExplainSummary } from '../../types/explorer';

// 개수는 줄이지 않고 그대로(50,000) — 몇 개를 읽었는지가 요점이라
export const fmtCount = (n: number) => n.toLocaleString('en-US');

// 인덱스 없이 이만큼 이하를 읽으면 '이 크기면 괜찮다'
export const SMALL_SCAN = 1000;
// 인덱스를 썼어도 읽은 것이 돌려준 것의 이 배수를 넘고, 이만큼 이상이면 낭비
const WASTE_RATIO = 10;
const WASTE_MIN = 100;

export const fmtKeyPattern = (kp: Record<string, number | string>) =>
  `{ ${Object.entries(kp)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
    .join(', ')} }`;

const labelOf = (node: ExplainPlanNode) => (node.keyPattern ? `${node.stage} ${fmtKeyPattern(node.keyPattern)}` : node.stage);

export const flowText = (node: ExplainPlanNode): string => {
  const prefix = node.shard ? `${node.shard}: ` : '';
  const label = labelOf(node);
  if (node.inputs.length === 0) return prefix + label;
  if (node.inputs.length === 1) return `${prefix}${flowText(node.inputs[0])} → ${label}`;
  return `${prefix}(${node.inputs.map(flowText).join(' + ')}) → ${label}`;
};

// 나오는 단계 이름 — 먼저 도는 것부터, 한 번씩
export const stagesOf = (node: ExplainPlanNode, out: string[] = []): string[] => {
  for (const i of node.inputs) stagesOf(i, out);
  if (!out.includes(node.stage)) out.push(node.stage);
  return out;
};

const STAGE_NOTES: Record<string, string> = {
  COLLSCAN: 'read every document in the collection, one by one',
  IXSCAN: 'walked an index — a sorted list of field values pointing at documents — instead of every document',
  FETCH: 'loaded the documents the step before pointed at',
  IDHACK: 'looked the document up directly by _id',
  EXPRESS_IXSCAN: 'looked the document up directly through an index — the fastest path',
  EXPRESS_CLUSTERED_IXSCAN: 'looked the document up directly by _id — the fastest path',
  CLUSTERED_IXSCAN: 'read only a range of the collection, which is stored in _id order',
  EOF: 'nothing to read — the collection does not exist or nothing can match',
  OR: 'combined the results of several index scans',
  AND_SORTED: 'kept only documents found by every index scan',
  AND_HASH: 'kept only documents found by every index scan',
  SORT_MERGE: 'merged several index scans in order',
  SUBPLAN: 'planned each branch of the $or on its own',
  SHARDING_FILTER: 'dropped documents that belong to another shard',
  SHARD_MERGE: 'merged the results from several shards',
  SINGLE_SHARD: 'asked only one shard',
  TEXT_OR: 'searched the text index for the words',
  TEXT_MATCH: 'checked the documents against the text search',
  GEO_NEAR_2D: 'searched by distance with a geo index',
  GEO_NEAR_2DSPHERE: 'searched by distance with a geo index',
};

export const stageNote = (stage: string): string | undefined => STAGE_NOTES[stage];

const indexWords = (names: string[]) =>
  names.length === 1 ? `the ${names[0]} index` : `the ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} indexes`;

const DIRECT = new Set(['IDHACK', 'EXPRESS_IXSCAN', 'EXPRESS_CLUSTERED_IXSCAN']);

export interface ExplainVerdict {
  tone: 'good' | 'warn' | 'info';
  text: string;
}

export const explainVerdict = (s: ExplainSummary): ExplainVerdict => {
  const stages = stagesOf(s.plan);
  const returned = s.returned ?? 0;
  if (stages.length === 1 && stages[0] === 'EOF') return { tone: 'info', text: 'Nothing to read — the collection does not exist or the query cannot match anything.' };
  if (s.collectionScan) {
    const docs = s.docsExamined;
    if (docs !== null && docs <= SMALL_SCAN) {
      return { tone: 'info', text: `No index used — read all ${fmtCount(docs)} documents. Fine at this size; an index helps as the collection grows.` };
    }
    const read = docs === null ? 'every document' : `every document (${fmtCount(docs)})`;
    return { tone: 'warn', text: `No index used — read ${read} to return ${fmtCount(returned)}.` };
  }
  if (stages.some((st) => DIRECT.has(st))) return { tone: 'good', text: 'Looked up directly — the fastest kind of query.' };
  if (s.indexes.length) {
    const read = Math.max(s.keysExamined ?? 0, s.docsExamined ?? 0);
    if (read >= WASTE_MIN && read > WASTE_RATIO * Math.max(returned, 1)) {
      return {
        tone: 'warn',
        text: `Uses ${indexWords(s.indexes)}, but read ${fmtCount(read)} entries to return ${fmtCount(returned)} — the index narrows this query poorly.`,
      };
    }
    return { tone: 'good', text: `Uses ${indexWords(s.indexes)} — read about as much as it returned.` };
  }
  return { tone: 'info', text: `Plan: ${flowText(s.plan)}` };
};
