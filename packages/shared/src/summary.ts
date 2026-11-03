// 문서 → 목록용 요약(DocumentSummary), 문서 식별자 문자열 규칙.
// Mock과 서버가 같은 함수를 써야 제목/미리보기/id가 어느 쪽에서든 똑같이 나온다.
import { PAGE_SIZE, type Document, type DocumentPage, type DocumentQuery, type DocumentSummary } from './contract';
import {
  displayValue,
  idString,
  isOid,
  isPlainObject,
  makeDouble,
  makeInt32,
  makeLong,
  makeOid,
  type EjsonValue,
} from './ejson';

// _id도 PK도 없는 raw plain 문서(Mock 전용)를 배열 위치로 식별할 때 쓰는 접두어
export const INDEX_FALLBACK_PREFIX = '__idx_';

// 문서의 식별자 문자열: _id → 선언된 PK → (Mock 전용) 배열 인덱스 순.
// 실제 MongoDB 문서는 _id가 항상 있으므로 서버에서는 언제나 첫 번째 규칙으로 끝난다.
export const getDocumentId = (document: Document, primaryKey?: string, fallbackIndex?: number): string | undefined => {
  const fromId = idString(document._id);
  if (fromId !== undefined) return fromId;
  if (primaryKey) {
    const fromPk = idString(document[primaryKey]);
    if (fromPk !== undefined) return fromPk;
  }
  if (fallbackIndex !== undefined) return `${INDEX_FALLBACK_PREFIX}${fallbackIndex}`;
  return undefined;
};

// 식별자 문자열 → 그 문자열을 만들 수 있었던 _id 값 후보들(Canonical).
// idString이 타입 정보를 버리기 때문에("5"는 문자열 "5"일 수도, 숫자 5일 수도 있다) 조회할 땐 후보 전부로 찾는다.
// 서버: { _id: { $in: 후보 } } — _id 인덱스를 타므로 빠르다.
export const idLookupCandidates = (id: string): EjsonValue[] => {
  const candidates: EjsonValue[] = [id];
  if (/^[0-9a-fA-F]{24}$/.test(id)) candidates.push(makeOid(id.toLowerCase()));
  if (/^-?\d+$/.test(id)) {
    const n = Number(id);
    if (Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647) candidates.push(makeInt32(n));
    candidates.push(makeLong(id));
    candidates.push(makeDouble(n));
  } else if (/^-?\d*\.\d+(e[+-]?\d+)?$/i.test(id) && Number.isFinite(Number(id))) {
    candidates.push(makeDouble(Number(id)));
  }
  return candidates;
};

// ObjectId 앞 4바이트 = 생성 시각(초). MongoDB는 수정 시각을 따로 기록하지 않으므로 정렬용 시각으로 쓴다.
export const oidTimestampMs = (value: unknown): number | undefined => {
  if (!isOid(value)) return undefined;
  const seconds = parseInt(value.$oid.slice(0, 8), 16);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
};

const summarizePreviewValue = (value: EjsonValue): string => {
  if (isOid(value)) {
    return `ObjectId(${value.$oid.slice(-8)})`;
  }
  if (isPlainObject(value) && typeof value.$ref === 'string' && isOid(value.$id)) {
    return `DBRef(${value.$ref}:${value.$id.$oid.slice(-8)})`;
  }
  return displayValue(value);
};

export const summarizeDocument = (
  document: Document,
  updatedAt: number,
  titleKey?: string,
  primaryKey?: string,
  index?: number,
): DocumentSummary => {
  const id = getDocumentId(document, primaryKey, index);
  // 인덱스 fallback 토큰은 사용자에게 보여줄 의미가 없으니 표시용으로는 없는 셈 취급
  const displayableId = id && !id.startsWith(INDEX_FALLBACK_PREFIX) ? id : undefined;
  let title = displayableId ? (isOid(document._id) ? displayableId.slice(-8) : displayableId) : '[document]';

  if (titleKey) {
    const candidate = document[titleKey];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      title = candidate;
    }
  } else {
    const nameCandidate = document.name;
    const titleCandidate = document.title;
    if (typeof nameCandidate === 'string' && nameCandidate.trim().length > 0) {
      title = nameCandidate;
    } else if (typeof titleCandidate === 'string' && titleCandidate.trim().length > 0) {
      title = titleCandidate;
    }
  }

  const previewParts: string[] = [];
  for (const [key, value] of Object.entries(document).slice(0, 2)) {
    previewParts.push(`${key}: ${summarizePreviewValue(value as EjsonValue)}`);
  }

  return {
    id: id ?? '',
    title,
    preview: previewParts.join(', '),
    fieldCount: Object.keys(document).length,
    updatedAt,
  };
};

// 문서 요약 전체 → 필터·정렬·페이지 자르기. Mock과 서버가 이 함수 하나로 같은 결과를 낸다.
export const queryDocuments = (all: DocumentSummary[], query: DocumentQuery = {}): DocumentPage => {
  const pageSize = Math.max(1, Math.min(500, Math.trunc(query.pageSize ?? PAGE_SIZE)));
  const needle = (query.filter ?? '').trim().toLowerCase();
  let result = !needle
    ? all
    : all.filter((doc) => doc.title.toLowerCase().includes(needle) || doc.preview.toLowerCase().includes(needle));

  const by = <T>(pick: (d: DocumentSummary) => T, compare: (a: T, b: T) => number) =>
    [...result].sort((a, b) => compare(pick(a), pick(b)));
  switch (query.sort) {
    case 'title-asc': result = by((d) => d.title, (a, b) => a.localeCompare(b)); break;
    case 'title-desc': result = by((d) => d.title, (a, b) => b.localeCompare(a)); break;
    case 'fields-asc': result = by((d) => d.fieldCount, (a, b) => a - b); break;
    case 'fields-desc': result = by((d) => d.fieldCount, (a, b) => b - a); break;
    case 'updated-asc': result = by((d) => d.updatedAt, (a, b) => a - b); break;
    case 'updated-desc': result = by((d) => d.updatedAt, (a, b) => b - a); break;
    default: break;
  }

  const pageOf = (id: string | undefined): number | undefined => {
    if (id === undefined) return undefined;
    const index = result.findIndex((d) => d.id === id);
    return index >= 0 ? Math.floor(index / pageSize) : undefined;
  };

  const lastPage = Math.max(0, Math.ceil(result.length / pageSize) - 1);
  let page = Math.min(Math.max(0, Math.trunc(query.page ?? 0)), lastPage);
  page = pageOf(query.aroundId) ?? page;
  const markedPage = pageOf(query.markId);

  return {
    items: result.slice(page * pageSize, (page + 1) * pageSize),
    page,
    pageSize,
    total: result.length,
    totalUnfiltered: all.length,
    ...(markedPage !== undefined ? { markedPage } : {}),
  };
};
