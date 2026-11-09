import { describe, expect, it } from 'vitest';
import { summarizeStage, validatePipeline, validatePipelineStage } from './pipeline';
import { parseStageText } from './queryParser';
import { formatStageText } from './queryConditions';

const int = (n: number) => ({ $numberInt: String(n) });
const ok = (pipeline: unknown) => expect(validatePipeline(pipeline)).toBeNull();
const bad = (pipeline: unknown, path: string, message?: RegExp) => {
  const error = validatePipeline(pipeline);
  expect(error).not.toBeNull();
  expect(error!.path).toBe(path);
  if (message) expect(error!.message).toMatch(message);
};

describe('validatePipeline — 허용', () => {
  it('흔한 파이프라인', () => {
    ok([]);
    ok([
      { $match: { status: 'open', age: { $gt: int(18) } } },
      { $group: { _id: '$author', n: { $sum: int(1) }, avg: { $avg: '$score' } } },
      { $sort: { n: int(-1) } },
      { $limit: int(10) },
    ]);
    ok([{ $lookup: { from: 'people', localField: 'author', foreignField: '_id', as: 'who' } }, { $unwind: '$who' }]);
    ok([{ $facet: { a: [{ $count: 'n' }], b: [{ $sample: { size: int(3) } }] } }]);
    ok([{ $project: { title: int(1), len: { $strLenCP: '$title' } } }, { $set: { x: '$$NOW' } }]);
  });
});

describe('validatePipeline — 거절', () => {
  it('쓰기 스테이지', () => {
    bad([{ $match: {} }, { $out: 'copy' }], '1.$out', /writes/);
    bad([{ $merge: { into: 'x' } }], '0.$merge', /writes/);
    // 하위 파이프라인에 숨겨도
    bad([{ $facet: { a: [{ $merge: { into: 'x' } }] } }], '0.$facet.a.0.$merge', /writes/);
    bad([{ $lookup: { from: 'p', pipeline: [{ $out: 'x' }], as: 'y' } }], '0.$lookup.pipeline.0.$out', /writes/);
  });

  it('JavaScript', () => {
    bad([{ $match: { $where: '1' } }], '0.$match.$where', /JavaScript/);
    bad([{ $group: { _id: null, v: { $accumulator: {} } } }], '0.$group.v.$accumulator', /JavaScript/);
    bad([{ $project: { v: { $function: { body: 'f', args: [], lang: 'js' } } } }], '0.$project.v.$function', /JavaScript/);
    bad([{ $unionWith: { coll: 'x', pipeline: [{ $match: { $where: '1' } }] } }], '0.$unionWith.pipeline.0.$match.$where', /JavaScript/);
  });

  it('모양', () => {
    bad({ $match: {} }, '', /array/);
    bad([{}], '0', /empty/);
    bad([{ $match: {}, $limit: int(1) }], '0', /exactly one/);
    bad([{ match: {} }], '0.match', /starts with \$/);
    bad([{ $foo: {} }], '0.$foo', /Unknown stage/);
    bad([{ $currentOp: {} }], '0.$currentOp', /not supported/);
    bad([{ $match: { age: { $foo: int(1) } } }], '0.$match.age.$foo', /Unknown operator/);
    bad(Array.from({ length: 51 }, () => ({ $limit: int(1) })), '', /At most/);
  });

  it('스테이지 하나만', () => {
    expect(validatePipelineStage({ $sort: { a: int(1) } })).toBeNull();
    expect(validatePipelineStage({ $out: 'x' })?.path).toBe('$out');
  });
});

describe('summarizeStage — 카드 한 줄', () => {
  const s = (stage: Record<string, unknown>) => summarizeStage(stage as never);
  it('$match는 조건 칩처럼', () => {
    expect(s({ $match: { score: { $gt: int(100) } } })).toBe('score > 100');
    expect(s({ $match: { status: 'open', $or: [] } })).toBe('status = "open", $or');
    expect(s({ $match: {} })).toBe('all documents');
  });
  it('$group은 묶는 키 → 만드는 필드', () => {
    expect(s({ $group: { _id: '$story' } })).toBe('by story');
    expect(s({ $group: { _id: null, n: { $sum: int(1) } } })).toBe('all into one → n');
    expect(s({ $group: { _id: { a: '$author', y: '$year' }, total: { $sum: '$x' } } })).toBe('by author, year → total');
  });
  it('정렬·개수·필드 고르기', () => {
    expect(s({ $sort: { score: int(-1), name: int(1) } })).toBe('score ↓, name ↑');
    expect(s({ $limit: int(10) })).toBe('first 10');
    expect(s({ $skip: int(5) })).toBe('skip 5');
    expect(s({ $project: { title: int(1), _id: int(0) } })).toBe('title, −_id');
    expect(s({ $unwind: '$tags' })).toBe('tags');
    expect(s({ $unwind: { path: '$tags', preserveNullAndEmptyArrays: true } })).toBe('tags');
    expect(s({ $lookup: { from: 'people', localField: 'a', foreignField: '_id', as: 'who' } })).toBe('people as who');
    expect(s({ $count: 'n' })).toBe('→ n');
    expect(s({ $addFields: { a: int(1), b: '$x' } })).toBe('+ a, b');
  });
  it('모르는 모양은 본문을 줄여서', () => {
    expect(s({ $redact: '$$KEEP' })).toBe('"$$KEEP"');
    expect(s({ $replaceWith: '$doc' })).toBe('doc');
    expect(s({ $match: { text: 'x'.repeat(200) } }).length).toBeLessThanOrEqual(80);
  });
});

describe('스테이지 글자 ⇄ 값', () => {
  it('parseStageText — 객체 하나', () => {
    expect(parseStageText('{ $limit: 5 }')).toEqual({ ok: true, stage: { $limit: int(5) } });
    const two = parseStageText('{ $limit: 5 }, { $skip: 1 }');
    expect(two.ok).toBe(false);
    const notObject = parseStageText('[{ $limit: 5 }]');
    expect(notObject.ok).toBe(false);
  });
  it('formatStageText — 짧으면 한 줄, 길면 펼쳐서. 다시 읽으면 같다', () => {
    const short = { $limit: int(5) };
    expect(formatStageText(short)).toBe('{ $limit: 5 }');
    const long = { $group: { _id: '$author', total: { $sum: '$amount' }, titles: { $push: '$title' }, n: { $sum: int(1) } } };
    const text = formatStageText(long as never);
    expect(text.split('\n').length).toBeGreaterThan(1);
    expect(text.startsWith('{\n  $group: {\n    _id: "$author",')).toBe(true);
    expect(parseStageText(text)).toEqual({ ok: true, stage: long });
  });
});
