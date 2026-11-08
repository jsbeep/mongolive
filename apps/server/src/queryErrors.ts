// 사용자 쿼리 실행 중 난 오류 → 응답. '쿼리를 고치면 되는 오류'만 400으로 메시지를 보여 주고,
// 나머지(인증·권한·연결·서버 상태)는 그대로 던져 500(internal error)으로 — 사용자 입력 탓이 아닌데
// 쿼리 오류처럼 보이면 안 되고, 내부 메시지가 밖으로 새도 안 된다.
import { BSON, MongoServerError } from 'mongodb';
import { HttpError } from './names';

// MongoDB가 쿼리 파싱·실행에서 내는 '입력이 잘못됨' 코드(실제 서버로 확인: 2·14·168·51091)
const INPUT_ERROR_CODES = new Set([
  2, // BadValue — 모르는 연산자, $type 이름, $size 음수, $mod 0 …
  9, // FailedToParse
  14, // TypeMismatch — $add에 문자열 …
  168, // InvalidPipelineOperator — $expr 안의 모르는 표현식
]);
const MAX_TIME_EXPIRED = 50;

// 오류 코드는 숫자로 맞춰 읽는다 — 조회 옵션 promoteValues: false(wire.ts READ_OPTIONS)가 오류 응답에도 적용돼
// code가 number가 아니라 Int32 객체로 온다(실제 서버로 확인). Number()가 둘 다 숫자로 바꾼다
const codeOf = (e: MongoServerError): number => Number(e.code);

const isInputError = (e: MongoServerError): boolean =>
  INPUT_ERROR_CODES.has(codeOf(e))
  // 이름 없는 단언 코드(Location51091 = 잘못된 정규식 등) — 쿼리 엔진의 검사에서 나온다.
  // 인증(13 Unauthorized, 18 AuthenticationFailed)·연결·primary 변경 같은 건 다 이름이 있어서 여기 안 걸린다
  || (typeof e.codeName === 'string' && e.codeName.startsWith('Location'));

// HttpError로 바꿀 수 있으면 바꾸고, 아니면 받은 오류를 그대로 돌려준다(호출한 쪽이 다시 던진다)
export const toQueryHttpError = (e: unknown, maxTimeMs: number): unknown => {
  if (e instanceof MongoServerError) {
    if (codeOf(e) === MAX_TIME_EXPIRED) {
      return new HttpError(400, `Query took longer than ${maxTimeMs / 1000}s — narrow it down`, { reason: 'timeout' });
    }
    if (isInputError(e)) return new HttpError(400, `Query failed: ${e.message}`);
  }
  return e;
};

// Canonical EJSON → BSON 변환 실패(잘못된 $oid 글자, $date 숫자 …) — 쿼리 안의 값이 틀렸다
export const toValueHttpError = (e: unknown): unknown =>
  BSON.BSONError.isBSONError(e) ? new HttpError(400, `Invalid value in query: ${e.message}`) : e;
