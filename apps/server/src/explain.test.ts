import { Long } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { EXPLAIN_RAW_MAX, summarizeExplain } from './explain';

const stats = { nReturned: 12, totalKeysExamined: 12, totalDocsExamined: 12, executionTimeMillis: 3 };

describe('summarizeExplain', () => {
  it('옛 엔진 — IXSCAN → FETCH, 숫자·버린 계획', () => {
    const s = summarizeExplain({
      queryPlanner: {
        winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'age_1', keyPattern: { age: 1 } } },
        rejectedPlans: [{ stage: 'COLLSCAN' }],
      },
      executionStats: stats,
      $clusterTime: { clusterTime: 1 },
      ok: 1,
    });
    expect(s.plan).toEqual({
      stage: 'FETCH',
      inputs: [{ stage: 'IXSCAN', index: 'age_1', keyPattern: { age: 1 }, inputs: [] }],
    });
    expect(s).toMatchObject({ returned: 12, keysExamined: 12, docsExamined: 12, timeMs: 3, rejectedPlans: 1, indexes: ['age_1'], collectionScan: false });
    // 버린 계획 안의 COLLSCAN은 상관없다 / 복사용에서 서버 시계는 뺀다
    expect(s.raw).toContain('"age_1"');
    expect(s.raw).not.toContain('$clusterTime');
  });

  it('SBE — queryPlan 안의 나무, Long 숫자', () => {
    const s = summarizeExplain({
      explainVersion: '2',
      queryPlanner: { winningPlan: { queryPlan: { stage: 'COLLSCAN' }, slotBasedPlan: { stages: '...' } }, rejectedPlans: [] },
      executionStats: { nReturned: Long.fromNumber(2), totalKeysExamined: 0, totalDocsExamined: Long.fromNumber(5000), executionTimeMillis: 9 },
    });
    expect(s.plan).toEqual({ stage: 'COLLSCAN', inputs: [] });
    expect(s).toMatchObject({ returned: 2, docsExamined: 5000, collectionScan: true, indexes: [] });
  });

  it('갈래 — OR 아래 IXSCAN 둘', () => {
    const s = summarizeExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'SUBPLAN',
          inputStage: {
            stage: 'FETCH',
            inputStage: {
              stage: 'OR',
              inputStages: [
                { stage: 'IXSCAN', indexName: 'a_1', keyPattern: { a: 1 } },
                { stage: 'IXSCAN', indexName: 'b_-1', keyPattern: { b: -1 } },
                { stage: 'IXSCAN', indexName: 'a_1', keyPattern: { a: 1 } },
              ],
            },
          },
        },
      },
      executionStats: stats,
    });
    expect(s.plan.inputs[0].inputs[0].inputs.map((n) => n.index)).toEqual(['a_1', 'b_-1', 'a_1']);
    expect(s.indexes).toEqual(['a_1', 'b_-1']);
  });

  it('샤드 — 샤드마다 계획, 버린 계획은 합친다', () => {
    const s = summarizeExplain({
      queryPlanner: {
        winningPlan: {
          stage: 'SHARD_MERGE',
          shards: [
            { shardName: 's0', winningPlan: { queryPlan: { stage: 'SHARDING_FILTER', inputStage: { stage: 'COLLSCAN' } } }, rejectedPlans: [] },
            { shardName: 's1', winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'x_1', keyPattern: { x: 'hashed' } } }, rejectedPlans: [{}, {}] },
          ],
        },
      },
      executionStats: stats,
    });
    expect(s.plan.stage).toBe('SHARD_MERGE');
    expect(s.plan.inputs.map((n) => [n.shard, n.stage])).toEqual([
      ['s0', 'SHARDING_FILTER'],
      ['s1', 'FETCH'],
    ]);
    expect(s.plan.inputs[1].inputs[0].keyPattern).toEqual({ x: 'hashed' });
    expect(s).toMatchObject({ rejectedPlans: 2, collectionScan: true, indexes: ['x_1'] });
  });

  it('모양이 이상하거나 숫자가 없으면 비운다, 너무 크면 날것은 뺀다', () => {
    expect(summarizeExplain(null)).toMatchObject({ plan: { stage: '?', inputs: [] }, returned: null, timeMs: null, rejectedPlans: 0 });
    const big = summarizeExplain({ queryPlanner: { winningPlan: { stage: 'EOF' } }, pad: 'x'.repeat(EXPLAIN_RAW_MAX) });
    expect(big.plan.stage).toBe('EOF');
    expect(big.raw).toBeNull();
  });
});
