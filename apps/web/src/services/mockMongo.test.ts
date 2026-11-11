import { describe, expect, it } from 'vitest';
import type { EjsonObject } from '@mongolive/shared';
import { aggregateDocuments, countPipelineStages, matchingIndexes } from './mockMongo';

const oid = (n: number) => ({ $oid: n.toString(16).padStart(24, '0') });
const int = (n: number) => ({ $numberInt: String(n) });
const long = (n: number) => ({ $numberLong: String(n) });
const date = (ms: number) => ({ $date: { $numberLong: String(ms) } });

const users: EjsonObject[] = [
  { _id: oid(1), name: 'ann', karma: long(9134) },
  { _id: oid(2), name: 'bob', karma: long(12) },
];
const posts: EjsonObject[] = [
  { _id: oid(10), title: 'a', authorId: oid(1), score: int(5), at: date(1000), tags: ['x', 'y'] },
  { _id: oid(11), title: 'b', authorId: oid(2), score: int(50), at: date(3000), tags: ['y'] },
  { _id: oid(12), title: 'c', authorId: oid(1), score: { $numberDouble: '7.5' }, at: date(2000), tags: [] },
];
const source = (name: string) => (name === 'users' ? users : name === 'posts' ? posts : undefined);

describe('matchingIndexes — 쿼리', () => {
  it('ObjectId·숫자 래퍼·날짜를 MongoDB처럼 비교한다', () => {
    expect(matchingIndexes(posts, { authorId: oid(1) })).toEqual([0, 2]);
    expect(matchingIndexes(posts, { score: { $gt: int(6) } })).toEqual([1, 2]);
    expect(matchingIndexes(posts, { at: { $gte: date(2000) } })).toEqual([1, 2]);
    expect(matchingIndexes(posts, { authorId: { $in: [oid(2)] } })).toEqual([1]);
  });

  it('정규식·배열·존재', () => {
    expect(matchingIndexes(posts, { title: { $regex: '^[ab]$' } })).toEqual([0, 1]);
    expect(matchingIndexes(posts, { tags: 'y' })).toEqual([0, 1]);
    expect(matchingIndexes(posts, { tags: { $size: int(0) } })).toEqual([2]);
    expect(matchingIndexes(posts, { missing: { $exists: false } })).toEqual([0, 1, 2]);
  });
});

describe('aggregateDocuments — 집계', () => {
  it('그대로 지나간 값은 원래 타입(Long·Double·Date)을 지킨다', () => {
    const { results } = aggregateDocuments(users, [{ $match: { name: 'ann' } }], source);
    expect(results).toEqual([users[0]]);
    const sorted = aggregateDocuments(posts, [{ $sort: { at: int(-1) } }, { $project: { score: int(1), at: int(1) } }], source).results;
    expect(sorted).toEqual([
      { _id: oid(11), score: int(50), at: date(3000) },
      { _id: oid(12), score: { $numberDouble: '7.5' }, at: date(2000) },
      { _id: oid(10), score: int(5), at: date(1000) },
    ]);
  });

  it('$group — 키는 ObjectId 그대로, 계산한 수는 Int32/Double', () => {
    const { results } = aggregateDocuments(
      posts,
      [{ $group: { _id: '$authorId', n: { $sum: int(1) }, avg: { $avg: '$score' } } }, { $sort: { _id: int(1) } }],
      source,
    );
    // 한계: JS엔 정수/실수 구분이 없어 계산 결과가 정수면 Int32 — MongoDB는 $avg를 늘 Double로 준다(50 → 50.0)
    expect(results).toEqual([
      { _id: oid(1), n: int(2), avg: { $numberDouble: '6.25' } },
      { _id: oid(2), n: int(1), avg: int(50) },
    ]);
  });

  it('$lookup — 같은 DB의 컬렉션을 붙이고, 붙은 문서도 원래 타입 그대로', () => {
    const { results } = aggregateDocuments(
      posts,
      [{ $match: { title: 'b' } }, { $lookup: { from: 'users', localField: 'authorId', foreignField: '_id', as: 'author' } }, { $project: { author: int(1) } }],
      source,
    );
    expect(results).toEqual([{ _id: oid(11), author: [users[1]] }]);
  });

  it('$unwind로 나온 문서도 다른 값은 원래대로', () => {
    const { results } = aggregateDocuments(posts, [{ $match: { title: 'a' } }, { $unwind: '$tags' }], source);
    expect(results).toEqual([
      { ...posts[0], tags: 'x' },
      { ...posts[0], tags: 'y' },
    ]);
  });

  it('결과는 500개까지, 넘으면 truncated', () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ _id: int(i) }));
    const out = aggregateDocuments(many, [], source);
    expect(out.results).toHaveLength(500);
    expect(out.truncated).toBe(true);
  });
});

describe('countPipelineStages — 스테이지별 개수', () => {
  it('들어오는 문서와 스테이지마다 지난 문서 수', () => {
    expect(countPipelineStages(posts, [{ $match: { authorId: oid(1) } }, { $limit: int(1) }], source)).toEqual({
      counts: [{ n: 3, capped: false }, { n: 2, capped: false }, { n: 1, capped: false }],
    });
  });

  it('막힌 스테이지에서 멈추고 그 스테이지를 알린다', () => {
    const out = countPipelineStages(posts, [{ $match: {} }, { $project: { x: { $noSuchOperator: int(1) } } }, { $limit: int(1) }], source);
    expect(out.counts).toHaveLength(2);
    expect(out.error?.stage).toBe(1);
  });
});
