// 컬럼 목록 항목이 방금 변경되어 하이라이트되어야 하는지 판별하는 공용 체크.
// path는 호출부가 "databases.<db>.collections.<col>.documents.<oid>[...]"
// 형식의 전체 경로를 구성해서 넘겨야 한다 — 부분 문자열(예: 필드 키 하나,
// 문서 oid 하나)만 넘기면 다른 문서/컬렉션의 동명 항목과 우연히 매칭되는
// 버그가 생긴다(예: 한 문서의 "name"을 수정하면 모든 문서의 "name"이
// 하이라이트됨). 정확히 그 경로이거나(자기 자신) 그 경로 하위(자식 필드
// 변경 시 부모 컨테이너도 하이라이트)인 경우만 true.
export const isPathChanged = (changedPaths: string[], path: string): boolean =>
  changedPaths.some((p) => p === path || p.startsWith(`${path}.`));
