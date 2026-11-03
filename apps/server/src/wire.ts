// BSON(드라이버 객체) ↔ Canonical EJSON(통신/웹이 쓰는 형식) 변환.
// 서버에서 나가는 문서는 반드시 toWire를, 들어오는 값은 fromWire를 거친다.
import { BSON, type Document as BsonDocument } from 'mongodb';
import type { EjsonValue } from '@mongolive/shared';

// 드라이버 조회 옵션: 숫자를 JS number로 '승격'하지 않고 Int32/Double/Long 객체로 받는다.
// 기본값(promoteValues: true)이면 Double 5.0과 Int32 5가 둘 다 JS 숫자 5가 되어 타입이 사라진다.
export const READ_OPTIONS = { promoteValues: false } as const;

export const toWire = <T = EjsonValue>(value: BsonDocument | unknown): T =>
  BSON.EJSON.serialize(value, { relaxed: false }) as T;

// Canonical EJSON → BSON 객체. relaxed: false라서 {$numberInt}는 Int32, {$numberDouble}은 Double로 남는다.
export const fromWire = (value: EjsonValue): unknown =>
  BSON.EJSON.deserialize({ v: value } as BsonDocument, { relaxed: false }).v;
