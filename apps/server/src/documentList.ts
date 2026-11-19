// 문서 목록 한 페이지 (GET/POST …/documents). 문서 전체 대신 요약 재료만 MongoDB에서 받아온다($project).
//   결과 ≤ DOCUMENT_LIST_FULL_MAX개: 요약 전부 → 공유 queryDocuments — Mock과 같은 결과(글자 검색·모든 정렬)
//   넘으면: _id 순서로 MongoDB에서 그 페이지만(skip/limit). 글자 검색·제목/필드 수 정렬은 안 걸고 limited로 알린다
import {
  DOCUMENT_LIST_FULL_MAX,
  PAGE_SIZE,
  SUMMARY_TEXT_MAX,
  idLookupCandidates,
  isPlainObject,
  oidTimestampMs,
  previewText,
  queryDocuments,
  summarizeDocument,
  type Document,
  type DocumentPage,
  type DocumentQuery,
  type DocumentSummary,
  type EjsonValue,
} from '@mongolive/shared';
import type { Collection, Document as BsonDocument, Filter } from 'mongodb';
import { fromWire, READ_OPTIONS, toWire } from './wire';

interface SummaryMeta {
  titleKey?: string;
  primaryKey?: string;
}

// '$ref' 같은 글자를 필드 경로가 아닌 값으로
const lit = (value: unknown) => ({ $literal: value });

// MongoDB에 저장된 DBRef는 필드 순서가 항상 $ref, $id(, $db)
const isDbRef = (value: string) => ({
  $let: {
    vars: { kv: { $objectToArray: value } },
    in: {
      $and: [
        { $eq: [{ $arrayElemAt: ['$$kv.k', 0] }, lit('$ref')] },
        { $eq: [{ $type: { $arrayElemAt: ['$$kv.v', 0] } }, 'string'] },
        { $eq: [{ $arrayElemAt: ['$$kv.k', 1] }, lit('$id')] },
        { $eq: [{ $type: { $arrayElemAt: ['$$kv.v', 1] } }, 'objectId'] },
      ],
    },
  },
});

const isString = (value: string) => ({ $eq: [{ $type: value }, 'string'] });
const clip = (value: string) => ({ $substrCP: [value, 0, SUMMARY_TEXT_MAX] });

// 미리보기 한 칸에 필요한 만큼만: 문자열 → 앞 200자, 배열 → 빈 배열(길이는 n), DBRef 아닌 객체 → {},
// 나머지(숫자·날짜·ObjectId·Binary …) → 그대로. 결과 글자는 previewText(전체 값)와 같다
const reducedPreviewValue = (value: string) => ({
  $switch: {
    branches: [
      { case: isString(value), then: clip(value) },
      { case: { $isArray: value }, then: lit([]) },
      { case: { $eq: [{ $type: value }, 'object'] }, then: { $cond: [isDbRef(value), value, lit({})] } },
    ],
    default: value,
  },
});

// 행 하나 = { _id, s: { fc: 필드 수, h: 앞 두 필드 [{k, v, n}], t: 제목 후보·PK [{k, v}] } }
// 제목 후보는 문자열일 때만 앞 200자(아니면 null — 어차피 제목이 못 된다), PK는 id로 쓰니 그대로
export const summaryProjection = ({ titleKey, primaryKey }: SummaryMeta): BsonDocument => {
  const titleKeys = (titleKey ? [titleKey] : ['name', 'title']).filter((k) => k !== '_id');
  const pk = primaryKey && primaryKey !== '_id' ? primaryKey : undefined;
  const keys = pk && !titleKeys.includes(pk) ? [...titleKeys, pk] : titleKeys;
  const titleValue = { $cond: [isString('$$f.v'), clip('$$f.v'), null] };
  return {
    $project: {
      _id: 1,
      s: {
        $let: {
          vars: { fs: { $objectToArray: '$$ROOT' } },
          in: {
            fc: { $size: '$$fs' },
            h: {
              $map: {
                input: { $slice: ['$$fs', 2] },
                as: 'f',
                in: { k: '$$f.k', v: reducedPreviewValue('$$f.v'), n: { $cond: [{ $isArray: '$$f.v' }, { $size: '$$f.v' }, null] } },
              },
            },
            t: {
              $map: {
                input: { $filter: { input: '$$fs', as: 'f', cond: { $in: ['$$f.k', lit(keys)] } } },
                as: 'f',
                in: { k: '$$f.k', v: pk ? { $cond: [{ $eq: ['$$f.k', lit(pk)] }, '$$f.v', titleValue] } : titleValue },
              },
            },
          },
        },
      },
    },
  };
};

interface WireRow {
  _id?: EjsonValue;
  s: {
    fc: EjsonValue;
    h: Array<{ k: string; v: EjsonValue; n: EjsonValue }>;
    t: Array<{ k: string; v: EjsonValue }>;
  };
}

// $size는 Int32 — promoteValues: false라 { $numberInt }로 온다
const intOf = (value: EjsonValue): number | undefined =>
  isPlainObject(value) && typeof value.$numberInt === 'string' ? Number(value.$numberInt) : typeof value === 'number' ? value : undefined;

// $project 한 행(Canonical EJSON) → 요약. 같은 문서를 summarizeDocument(전체)한 것과 같다
export const summaryFromRow = (row: WireRow, { titleKey, primaryKey }: SummaryMeta): DocumentSummary => {
  // fromEntries — '__proto__' 같은 키도 그냥 자기 필드로
  const document = Object.fromEntries([['_id', row._id], ...row.s.t.map(({ k, v }) => [k, v])]) as Document;
  const head = row.s.h.map(({ k, v, n }): [string, string] => [k, previewText(v, intOf(n))]);
  return summarizeDocument(document, oidTimestampMs(row._id) ?? 0, titleKey, primaryKey, undefined, {
    head,
    fieldCount: intOf(row.s.fc) ?? 0,
  });
};

const andFilter = (base: Filter<BsonDocument> | undefined, extra: Filter<BsonDocument>): Filter<BsonDocument> =>
  base ? { $and: [base, extra] } : extra;

export interface ListOptions {
  meta: SummaryMeta;
  // 사용자 쿼리(쿼리 바). 있으면 모든 명령에 maxTimeMS
  mongoFilter?: Filter<BsonDocument>;
  maxTimeMS: number;
}

export const listDocumentPage = async (
  collection: Collection,
  query: DocumentQuery,
  { meta, mongoFilter, maxTimeMS }: ListOptions,
): Promise<DocumentPage> => {
  const filterTime = mongoFilter ? { maxTimeMS } : {};
  const match = mongoFilter ? [{ $match: mongoFilter }] : [];
  const project = summaryProjection(meta);
  // 쿼리가 있으면 정확히 센다(결과 수가 곧 total). 없으면 메타데이터의 추정치로 길만 고른다
  const [counted, estimated] = await Promise.all([
    mongoFilter ? collection.countDocuments(mongoFilter, { maxTimeMS }) : undefined,
    collection.estimatedDocumentCount(mongoFilter ? { maxTimeMS } : {}),
  ]);
  const withCollectionTotal = (page: DocumentPage): DocumentPage =>
    mongoFilter ? { ...page, totalUnfiltered: Math.max(estimated, page.totalUnfiltered) } : page;

  let total = counted ?? estimated;
  if (total <= DOCUMENT_LIST_FULL_MAX) {
    // 한도 +1까지만 읽는다 — 추정치가 틀렸어도(크래시 뒤 등) 메모리는 한도 안에서 끝난다
    const summaries: DocumentSummary[] = [];
    const cursor = collection.aggregate([...match, { $limit: DOCUMENT_LIST_FULL_MAX + 1 }, project], { ...READ_OPTIONS, ...filterTime });
    for await (const row of cursor) summaries.push(summaryFromRow(toWire<WireRow>(row), meta));
    if (summaries.length <= DOCUMENT_LIST_FULL_MAX) return withCollectionTotal(queryDocuments(summaries, query));
    total = Math.max(total, summaries.length);
  }

  // 큰 결과 — _id 순서(updated-desc만 역순: ObjectId면 만든 시각 순과 같다)
  const dir = query.sort === 'updated-desc' ? -1 : 1;
  const pageSize = Math.max(1, Math.min(500, Math.trunc(query.pageSize ?? PAGE_SIZE)));
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  // 그 문서 앞에 몇 개 있나 → 페이지. _id 인덱스 범위 세기라 순위에 비례한다. 시간 넘거나 없으면 모른다
  // (_id 타입이 섞여 있으면 같은 타입끼리만 센다 — 페이지가 어긋날 수 있다)
  const pageOf = async (id: string | undefined): Promise<number | undefined> => {
    if (id === undefined) return undefined;
    try {
      const candidates = idLookupCandidates(id).map(fromWire);
      const hit = await collection.findOne(andFilter(mongoFilter, { _id: { $in: candidates } } as never), { projection: { _id: 1 }, maxTimeMS });
      if (!hit) return undefined;
      const before = await collection.countDocuments(andFilter(mongoFilter, { _id: { [dir === 1 ? '$lt' : '$gt']: hit._id } }), { maxTimeMS });
      return Math.min(lastPage, Math.floor(before / pageSize));
    } catch {
      return undefined;
    }
  };

  const [around, markedPage] = await Promise.all([pageOf(query.aroundId), pageOf(query.markId)]);
  const page = around ?? Math.min(Math.max(0, Math.trunc(query.page ?? 0)), lastPage);
  const rows = await collection
    .aggregate([...match, { $sort: { _id: dir } }, { $skip: page * pageSize }, { $limit: pageSize }, project], { ...READ_OPTIONS, maxTimeMS })
    .toArray();

  return withCollectionTotal({
    items: rows.map((row) => summaryFromRow(toWire<WireRow>(row), meta)),
    page,
    pageSize,
    total,
    totalUnfiltered: total,
    ...(markedPage !== undefined ? { markedPage } : {}),
    limited: { reason: 'large', threshold: DOCUMENT_LIST_FULL_MAX },
  });
};
