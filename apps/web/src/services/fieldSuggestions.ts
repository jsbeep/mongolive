// 입력칸 자동완성용 필드 후보 — 컬렉션 문서 몇 개를 받아 합친다(문서마다 필드가 다를 수 있어서 하나로는 모자라다).
// 쓰는 곳: 쿼리 빌더의 필드(경로: author.name), 참조 설정의 Field key(키 이름: authorId), 참조 대상 키(맨 위 키).
// 읽기만 한다 — 목록 첫 페이지에서 SAMPLE개(+ 지금 연 문서)를 받는다.
import { api } from './api';
import { collectionKey, fieldPaths, referenceKeyCandidates, type Document } from '../types/explorer';

const SAMPLE = 5;

export const sampleDocuments = async (database: string, collection: string, preferId?: string | null): Promise<Document[]> => {
  const page = await api.getDocuments(collectionKey(database, collection), { page: 0, pageSize: SAMPLE });
  const ids = [...new Set([...(preferId ? [preferId] : []), ...page.items.map((d) => d.id)])].slice(0, SAMPLE);
  const docs = await Promise.all(ids.map((id) => api.getFullDocumentByIdInCollection(database, collection, id).catch(() => null)));
  return docs.filter((d): d is Document => d !== null);
};

const union = (lists: string[][]): string[] => [...new Set(lists.flat())];

// 쿼리 빌더 — 경로
export const loadQueryFieldPaths = async (database: string, collection: string, preferId?: string | null) =>
  union((await sampleDocuments(database, collection, preferId)).map((d) => fieldPaths(d)));

// 참조 설정 Field key — 글자·숫자 값을 가진 키 이름
export const loadReferenceKeys = async (database: string, collection: string) =>
  union((await sampleDocuments(database, collection)).map((d) => referenceKeyCandidates(d)));

// 참조 대상 키 — 대상 문서를 찾을 때 맨 위 필드로 비교한다(_id 포함)
export const loadTopLevelKeys = async (database: string, collection: string) =>
  union((await sampleDocuments(database, collection)).map((d) => Object.keys(d)));
