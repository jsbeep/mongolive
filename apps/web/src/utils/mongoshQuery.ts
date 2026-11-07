// 복사 메뉴용 — 지금 보는 문서(와 펼친 필드)를 mongosh에서 그대로 열 수 있는 쿼리 문자열로.
//   db.getSiblingDB("shop").getCollection("users").find({ _id: ObjectId("…") }, { "address.city": 1 })
// getSiblingDB/getCollection을 쓰는 이유: 이름에 '-'·공백이 있어도 그대로 된다(db.my-col은 안 됨).
import { dateMs, valueKind } from '../types/explorer';

// Canonical EJSON 값 → mongosh 리터럴
export const shellLiteral = (value: unknown): string => {
  switch (valueKind(value)) {
    case 'null':
      return 'null';
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'int32':
    case 'double': {
      if (typeof value === 'number') return String(value);
      const inner = Object.values(value as Record<string, string>)[0];
      return Number.isFinite(Number(inner)) ? inner : `EJSON.deserialize(${JSON.stringify(value)})`;
    }
    case 'long':
      return `NumberLong(${JSON.stringify((value as { $numberLong: string }).$numberLong)})`;
    case 'decimal128':
      return `NumberDecimal(${JSON.stringify((value as { $numberDecimal: string }).$numberDecimal)})`;
    case 'oid':
      return `ObjectId(${JSON.stringify((value as { $oid: string }).$oid)})`;
    case 'date':
      return `ISODate(${JSON.stringify(new Date(dateMs(value)!).toISOString())})`;
    case 'array':
      return `[${(value as unknown[]).map(shellLiteral).join(', ')}]`;
    case 'object':
      return `{ ${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${shellLiteral(v)}`).join(', ')} }`;
    default:
      // 그 밖의 BSON(바이너리, 정규식 등) — mongosh의 EJSON으로 그대로 되살린다
      return `EJSON.deserialize(${JSON.stringify(value)})`;
  }
};

// 배열 인덱스("tags.0")는 find projection에서 원소를 고르지 못한다 — 첫 숫자 칸 앞까지만 쓴다
const projectionOf = (path: string[]): string | null => {
  const cut = path.findIndex((seg) => /^\d+$/.test(seg));
  const usable = cut === -1 ? path : path.slice(0, cut);
  return usable.length ? `{ ${JSON.stringify(usable.join('.'))}: 1 }` : null;
};

export const mongoshFindQuery = (database: string, collection: string, id: unknown, fieldPath: string[] = []): string => {
  const projection = projectionOf(fieldPath);
  return `db.getSiblingDB(${JSON.stringify(database)}).getCollection(${JSON.stringify(collection)}).find({ _id: ${shellLiteral(id)} }${projection ? `, ${projection}` : ''})`;
};
