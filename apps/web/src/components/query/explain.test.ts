import { describe, expect, it } from 'vitest';
import type { ExplainPlanNode, ExplainSummary } from '../../types/explorer';
import { explainVerdict, flowText, stageNote, stagesOf } from './explain';

const ix = (name: string, keyPattern: Record<string, number | string>): ExplainPlanNode => ({ stage: 'IXSCAN', index: name, keyPattern, inputs: [] });
const node = (stage: string, ...inputs: ExplainPlanNode[]): ExplainPlanNode => ({ stage, inputs });
const summary = (plan: ExplainPlanNode, extra: Partial<ExplainSummary> = {}): ExplainSummary => ({
  plan,
  returned: 12,
  keysExamined: 12,
  docsExamined: 12,
  timeMs: 1,
  rejectedPlans: 0,
  indexes: [],
  collectionScan: false,
  raw: null,
  ...extra,
});

describe('flowText · stagesOf', () => {
  it('먼저 도는 단계부터, 갈래는 괄호', () => {
    expect(flowText(node('FETCH', ix('age_1', { age: 1 })))).toBe('IXSCAN { age: 1 } → FETCH');
    const or = node('FETCH', node('OR', ix('a_1', { a: 1 }), ix('loc_2dsphere', { loc: '2dsphere' })));
    expect(flowText(or)).toBe('(IXSCAN { a: 1 } + IXSCAN { loc: "2dsphere" }) → OR → FETCH');
    expect(stagesOf(or)).toEqual(['IXSCAN', 'OR', 'FETCH']);
  });

  it('샤드는 이름을 앞에', () => {
    const plan = node('SHARD_MERGE', { ...node('COLLSCAN'), shard: 's0' }, { ...node('FETCH', ix('x_1', { x: 1 })), shard: 's1' });
    expect(flowText(plan)).toBe('(s0: COLLSCAN + s1: IXSCAN { x: 1 } → FETCH) → SHARD_MERGE');
  });

  it('모르는 단계는 설명 없음', () => {
    expect(stageNote('COLLSCAN')).toMatch(/every document/);
    expect(stageNote('NEW_STAGE_2030')).toBeUndefined();
  });
});

describe('explainVerdict', () => {
  it('인덱스 없이 전체 — 작으면 info, 크면 warn', () => {
    expect(explainVerdict(summary(node('COLLSCAN'), { collectionScan: true, docsExamined: 800, returned: 3 })).tone).toBe('info');
    const big = explainVerdict(summary(node('COLLSCAN'), { collectionScan: true, docsExamined: 50_000, returned: 3 }));
    expect(big).toEqual({ tone: 'warn', text: 'No index used — read every document (50,000) to return 3.' });
  });

  it('인덱스를 썼지만 낭비가 크면 warn, 아니면 good', () => {
    const plan = node('FETCH', ix('age_1', { age: 1 }));
    expect(explainVerdict(summary(plan, { indexes: ['age_1'] }))).toEqual({ tone: 'good', text: 'Uses the age_1 index — read about as much as it returned.' });
    expect(explainVerdict(summary(plan, { indexes: ['age_1'], keysExamined: 5000, docsExamined: 5000, returned: 4 })).tone).toBe('warn');
    // 작은 숫자는 배수가 커도 괜찮다
    expect(explainVerdict(summary(plan, { indexes: ['age_1'], docsExamined: 40, returned: 1 })).tone).toBe('good');
    expect(explainVerdict(summary(plan, { indexes: ['a_1', 'b_1', 'c_1'] })).text).toMatch('the a_1, b_1 and c_1 indexes');
  });

  it('_id로 바로 · 컬렉션 없음', () => {
    expect(explainVerdict(summary(node('EXPRESS_IXSCAN'), { indexes: ['_id_'] })).text).toMatch(/directly/);
    expect(explainVerdict(summary(node('IDHACK'))).tone).toBe('good');
    expect(explainVerdict(summary(node('EOF'), { returned: 0 })).tone).toBe('info');
  });
});
