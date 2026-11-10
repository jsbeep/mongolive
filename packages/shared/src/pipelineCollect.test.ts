import { describe, expect, it } from 'vitest';
import { validatePipelineStage } from './pipeline';
import { collectInto, type CollectAction } from './pipelineCollect';
import { formatStageText } from './queryConditions';
import { parseStageText } from './queryParser';

const int = (n: number) => ({ $numberInt: String(n) });
const stage = (text: string) => {
  const parsed = parseStageText(text);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.stage;
};
const match = (field: string, op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte', value: unknown): CollectAction =>
  ({ kind: 'match', conditions: [{ field, op, value: value as never }] });

describe('collectInto — $match', () => {
  it('마지막이 $match가 아니면(없거나 다른 스테이지) 새 $match', () => {
    expect(collectInto(null, match('score', 'gt', int(100)))).toEqual({ mode: 'new', stage: { $match: { score: { $gt: int(100) } } } });
    expect(collectInto(stage('{ $sort: { n: -1 } }'), match('type', 'eq', 'comment'))).toEqual({ mode: 'new', stage: { $match: { type: 'comment' } } });
  });

  it('마지막이 $match면 조건을 더한다 — 다른 필드', () => {
    const result = collectInto(stage('{ $match: { score: { $gt: 100 } } }'), match('type', 'eq', 'comment'));
    expect(result).toEqual({ mode: 'merge', stage: { $match: { score: { $gt: int(100) }, type: 'comment' } }, replaced: [], unchanged: false });
  });

  it('같은 필드의 다른 비교는 범위로 합친다', () => {
    const result = collectInto(stage('{ $match: { score: { $gt: 100 } } }'), match('score', 'lt', int(500)));
    expect(result).toMatchObject({ mode: 'merge', stage: { $match: { score: { $gt: int(100), $lt: int(500) } } }, replaced: [] });
  });

  it('같은 비교는 바꾸고 replaced로 알린다', () => {
    const result = collectInto(stage('{ $match: { score: { $gt: 100 } } }'), match('score', 'gt', int(200)));
    expect(result).toMatchObject({ mode: 'merge', stage: { $match: { score: { $gt: int(200) } } }, replaced: ['score'] });
    // '='는 범위와 함께 둘 수 없어 대신한다
    expect(collectInto(stage('{ $match: { score: { $gt: 100 } } }'), match('score', 'eq', int(7)))).toMatchObject({ replaced: ['score'] });
    expect(collectInto(stage('{ $match: { type: "post" } }'), match('type', 'ne', 'x'))).toMatchObject({ replaced: ['type'] });
  });

  it('이미 있는 조건이면 unchanged', () => {
    const result = collectInto(stage('{ $match: { type: "comment" } }'), match('type', 'eq', 'comment'));
    expect(result).toMatchObject({ mode: 'merge', replaced: [], unchanged: true });
  });

  it('조건이 여럿(같은 날 = 이상 + 미만)이면 차례로', () => {
    const day: CollectAction = {
      kind: 'match',
      conditions: [
        { field: 'at', op: 'gte', value: { $date: { $numberLong: '0' } } },
        { field: 'at', op: 'lt', value: { $date: { $numberLong: '86400000' } } },
      ],
    };
    expect(collectInto(null, day)).toEqual({ mode: 'new', stage: { $match: { at: { $gte: { $date: { $numberLong: '0' } }, $lt: { $date: { $numberLong: '86400000' } } } } } });
  });
});

describe('collectInto — $sort', () => {
  it('새 필드는 보조 정렬 키로 뒤에', () => {
    const result = collectInto(stage('{ $sort: { n: -1 } }'), { kind: 'sort', field: 'time', direction: 1 });
    expect(result).toMatchObject({ mode: 'merge', stage: { $sort: { n: int(-1), time: int(1) } } });
    expect(Object.keys((result.stage.$sort as object))).toEqual(['n', 'time']);
  });

  it('같은 필드는 그 자리에서 방향만', () => {
    const result = collectInto(stage('{ $sort: { n: -1, time: 1 } }'), { kind: 'sort', field: 'n', direction: 1 });
    expect(result.stage).toEqual({ $sort: { n: int(1), time: int(1) } });
    expect(Object.keys((result.stage.$sort as object))).toEqual(['n', 'time']);
  });

  it('마지막이 $sort가 아니면 새로', () => {
    expect(collectInto(stage('{ $match: {} }'), { kind: 'sort', field: 'n', direction: -1 })).toEqual({ mode: 'new', stage: { $sort: { n: int(-1) } } });
  });
});

describe('collectInto — $project', () => {
  it('포함 방식에 포함을 더한다', () => {
    expect(collectInto(stage('{ $project: { title: 1 } }'), { kind: 'project', field: 'score', include: true }))
      .toMatchObject({ mode: 'merge', stage: { $project: { title: int(1), score: int(1) } } });
  });

  it('제외 방식에 제외를 더한다', () => {
    expect(collectInto(stage('{ $project: { body: 0 } }'), { kind: 'project', field: 'tags', include: false }))
      .toMatchObject({ mode: 'merge', stage: { $project: { body: int(0), tags: int(0) } } });
  });

  it('섞이면 새 스테이지(MongoDB가 거절하는 조합)', () => {
    expect(collectInto(stage('{ $project: { title: 1 } }'), { kind: 'project', field: 'body', include: false }))
      .toEqual({ mode: 'new', stage: { $project: { body: int(0) } } });
    expect(collectInto(stage('{ $project: { body: 0 } }'), { kind: 'project', field: 'title', include: true }))
      .toEqual({ mode: 'new', stage: { $project: { title: int(1) } } });
  });

  it('_id 빼기는 포함 방식에도 된다, _id뿐이면 어느 쪽이든', () => {
    expect(collectInto(stage('{ $project: { title: 1 } }'), { kind: 'project', field: '_id', include: false }))
      .toMatchObject({ mode: 'merge', stage: { $project: { title: int(1), _id: int(0) } } });
    expect(collectInto(stage('{ $project: { _id: 0 } }'), { kind: 'project', field: 'title', include: true })).toMatchObject({ mode: 'merge' });
    expect(collectInto(stage('{ $project: { _id: 0 } }'), { kind: 'project', field: 'body', include: false })).toMatchObject({ mode: 'merge' });
  });
});

describe('collectInto — 늘 새 스테이지', () => {
  it('$group · $sortByCount · $lookup', () => {
    const last = stage('{ $group: { _id: "$a" } }');
    expect(collectInto(last, { kind: 'group', field: 'author' })).toEqual({ mode: 'new', stage: { $group: { _id: '$author', count: { $sum: int(1) } } } });
    expect(collectInto(last, { kind: 'count', field: 'tags' })).toEqual({ mode: 'new', stage: { $sortByCount: '$tags' } });
    expect(collectInto(last, { kind: 'lookup', from: 'people', localField: 'author', foreignField: '_id', as: 'author_people' }))
      .toEqual({ mode: 'new', stage: { $lookup: { from: 'people', localField: 'author', foreignField: '_id', as: 'author_people' } } });
  });

  it('만든 스테이지는 글자로 바꿔도 다시 읽힌다', () => {
    const result = collectInto(stage('{ $match: { score: { $gt: 100 } } }'), match('type', 'eq', 'comment'));
    expect(stage(formatStageText(result.stage))).toEqual(result.stage);
  });
});

describe('collectInto — 타입별(늘 새 스테이지)', () => {
  const last = stage('{ $match: { a: 1 } }');
  it('배열 → $unwind · 크기', () => {
    expect(collectInto(last, { kind: 'unwind', field: 'tags' })).toEqual({ mode: 'new', stage: { $unwind: '$tags' } });
    expect(collectInto(last, { kind: 'arraySize', field: 'tags', as: 'tags_size' }))
      .toEqual({ mode: 'new', stage: { $addFields: { tags_size: { $size: { $ifNull: ['$tags', []] } } } } });
  });
  it('날짜 → 일·월·년으로 묶기', () => {
    expect(collectInto(last, { kind: 'groupByDate', field: 'at', unit: 'month', timezone: 'Asia/Seoul' })).toEqual({
      mode: 'new',
      stage: { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$at', timezone: 'Asia/Seoul' } }, count: { $sum: int(1) } } },
    });
  });
  it('ObjectId → 만든 시각', () => {
    expect(collectInto(last, { kind: 'oidTime', field: '_id', as: '_id_time' })).toEqual({ mode: 'new', stage: { $addFields: { _id_time: { $toDate: '$_id' } } } });
  });
  it('만든 스테이지는 허용 검사를 통과하고 글자로 바꿔도 다시 읽힌다', () => {
    for (const action of [
      { kind: 'unwind', field: 'tags' },
      { kind: 'arraySize', field: 'tags', as: 'n' },
      { kind: 'groupByDate', field: 'at', unit: 'day', timezone: 'UTC' },
      { kind: 'oidTime', field: '_id', as: 't' },
    ] as CollectAction[]) {
      const made = collectInto(null, action).stage;
      expect(validatePipelineStage(made)).toBeNull();
      expect(stage(formatStageText(made))).toEqual(made);
    }
  });
});
