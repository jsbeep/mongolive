// 쿼리 바의 복사 버튼 — 지금 걸린 쿼리를 mongosh에서 그대로 돌릴 수 있는 한 줄(또는 여러 줄)로.
//   db.getSiblingDB("shop").getCollection("users").find({ age: { $gt: 51 } })
// getSiblingDB/getCollection을 쓰는 이유: 이름에 '-'·공백이 있어도 그대로 된다(db.my-col은 안 됨).
// 쿼리 글자는 formatQueryText로 새로 쓴다 — 사용자가 친 글자(따옴표 없는 a.b 키 등)는 mongosh 문법이 아닐 수 있어서.
import { formatPipelineText, formatQueryText, type JsonObject } from '../types/explorer';

export const mongoshFindCommand = (database: string, collection: string, filter: JsonObject): string =>
  `db.getSiblingDB(${JSON.stringify(database)}).getCollection(${JSON.stringify(collection)}).find(${formatQueryText(filter)})`;

// Pipeline 컬럼 ⋯ 메뉴 — 지금 돌리는 파이프라인(켜진·붙인 스테이지)을 mongosh aggregate 한 덩어리로
export const mongoshAggregateCommand = (database: string, collection: string, pipeline: JsonObject[]): string =>
  `db.getSiblingDB(${JSON.stringify(database)}).getCollection(${JSON.stringify(collection)}).aggregate(${formatPipelineText(pipeline)})`;
