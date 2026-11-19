// 목록 요약 동등성 — Mongo $project로 받은 재료(summaryFromRow)와 문서 전체(summarizeDocument)가 같은 요약을 내나.
// 실제 MongoDB가 필요하다: MONGOLIVE_TEST_MONGO_URI가 있을 때만 돈다(없으면 건너뜀)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCUMENT_LIST_FULL_MAX, oidTimestampMs, summarizeDocument, type Document } from '@mongolive/shared';
import { BSON, MongoClient, type Collection } from 'mongodb';
import { listDocumentPage, summaryFromRow, summaryProjection } from './documentList';
import { READ_OPTIONS, toWire } from './wire';

const uri = process.env.MONGOLIVE_TEST_MONGO_URI;
const long = 'é'.repeat(150) + '😀'.repeat(100); // 코드 포인트 250개(UTF-16은 더 길다)

// 값 종류마다 앞 두 필드·제목 후보에 들어가게
const docs: Record<string, unknown>[] = [
  { _id: new BSON.ObjectId(), name: 'plain', n: new BSON.Int32(5) },
  { _id: 'str-id', a: long, b: 'short' },
  { _id: new BSON.Int32(7), arr: Array.from({ length: 1000 }, (_, i) => i), obj: { deep: { x: 1 } } },
  { _id: new BSON.Long(9), ref: new BSON.DBRef('users', new BSON.ObjectId()), when: new Date(0) },
  { _id: new BSON.ObjectId(), d: new BSON.Double(5), dec: BSON.Decimal128.fromString('1.50') },
  { _id: new BSON.ObjectId(), bin: new BSON.Binary(Buffer.from('hello')), re: new BSON.BSONRegExp('a+', 'i') },
  { _id: new BSON.ObjectId(), nul: null, t: true },
  { _id: new BSON.ObjectId(), title: '   ', name: '  ' }, // 빈칸 제목 → id로
  { _id: new BSON.ObjectId(), title: long, x: 1 }, // 긴 제목 → 200자
  { _id: new BSON.ObjectId(), name: { en: 'not a string' }, title: 'fallback' },
  { _id: new BSON.ObjectId(), ['__proto__']: 'proto-title' },
  { _id: { a: 1, b: 2 }, sku: 'PK-1', label: 'compound id' }, // _id가 객체 → PK
  { _id: new BSON.ObjectId() }, // 필드 하나뿐
  { _id: new BSON.ObjectId(), mk: new BSON.MinKey(), ts: new BSON.Timestamp({ t: 1, i: 2 }) },
];

const metas = [{}, { titleKey: 'label', primaryKey: 'sku' }, { titleKey: 'a' }, { titleKey: '_id' }];

describe.skipIf(!uri)('documentList (real MongoDB)', () => {
  let client: MongoClient;
  let col: Collection;
  let big: Collection;

  beforeAll(async () => {
    client = await MongoClient.connect(uri!);
    const db = client.db('ml_list_test');
    await db.dropDatabase();
    col = db.collection('kinds');
    await col.insertMany(docs as never[]);
    big = db.collection('big');
    const n = DOCUMENT_LIST_FULL_MAX + 25;
    await big.insertMany(Array.from({ length: n }, (_, i) => ({ _id: new BSON.ObjectId(), name: `doc ${i}`, i })));
  }, 60_000);

  afterAll(async () => {
    await client?.db('ml_list_test').dropDatabase();
    await client?.close();
  });

  it.each(metas.map((m) => [JSON.stringify(m), m] as const))('같은 요약 — meta %s', async (_, meta) => {
    const full = (await col.find({}, READ_OPTIONS).toArray()).map((bson) => {
      const document = toWire<Document>(bson);
      return summarizeDocument(document, oidTimestampMs(document._id) ?? 0, meta.titleKey, meta.primaryKey);
    });
    const rows = await col.aggregate([summaryProjection(meta)], READ_OPTIONS).toArray();
    const projected = rows.map((row) => summaryFromRow(toWire(row), meta));
    expect(projected).toEqual(full);
    // 잘림·배열 길이가 실제로 일어났나
    expect(full.some((s) => s.preview.includes('arr: [1000]'))).toBe(true);
    expect(full.some((s) => s.preview.includes('ref: DBRef(users:'))).toBe(true);
  });

  it('작은 컬렉션은 전체 요약 경로 — limited 없음, 글자 검색 됨', async () => {
    const page = await listDocumentPage(col, { filter: 'fallback' }, { meta: {}, maxTimeMS: 5000 });
    expect(page.limited).toBeUndefined();
    expect(page.items.map((s) => s.title)).toEqual(['fallback']);
  });

  it('큰 컬렉션은 페이지만 — limited, _id 순서, aroundId/markId', async () => {
    const meta = {};
    const first = await listDocumentPage(big, { filter: 'ignored', sort: 'title-desc' }, { meta, maxTimeMS: 5000 });
    expect(first.limited).toEqual({ reason: 'large', threshold: DOCUMENT_LIST_FULL_MAX });
    expect(first.total).toBe(DOCUMENT_LIST_FULL_MAX + 25);
    expect(first.items.map((s) => s.title).slice(0, 2)).toEqual(['doc 0', 'doc 1']);

    const target = await big.findOne({ i: 4321 });
    const id = target!._id.toHexString();
    const around = await listDocumentPage(big, { aroundId: id, markId: id }, { meta, maxTimeMS: 5000 });
    expect(around.page).toBe(Math.floor(4321 / 10));
    expect(around.markedPage).toBe(around.page);
    expect(around.items.some((s) => s.id === id)).toBe(true);

    const desc = await listDocumentPage(big, { sort: 'updated-desc' }, { meta, maxTimeMS: 5000 });
    expect(desc.items[0].title).toBe(`doc ${DOCUMENT_LIST_FULL_MAX + 24}`);

    const last = await listDocumentPage(big, { page: 99_999 }, { meta, maxTimeMS: 5000 });
    expect(last.page).toBe(Math.ceil((DOCUMENT_LIST_FULL_MAX + 25) / 10) - 1);
    expect(last.items).toHaveLength(5);
  });

  it('쿼리 결과가 한도 안이면 큰 컬렉션이어도 전체 경로', async () => {
    const filtered = await listDocumentPage(big, { filter: 'doc 12' }, { meta: {}, mongoFilter: { i: { $lt: 200 } }, maxTimeMS: 5000 });
    expect(filtered.limited).toBeUndefined();
    expect(filtered.total).toBe(11); // doc 12, doc 120 … doc 129
    expect(filtered.totalUnfiltered).toBe(DOCUMENT_LIST_FULL_MAX + 25);
  });
});
