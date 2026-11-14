// 컬렉션 없이 만든 DB 이름(서버 메모리에만), 연결마다 따로.
// MongoDB엔 '빈 DB'가 없다 — 첫 컬렉션이 생길 때 만들어진다. 흔적을 남기지 않으려고 이름만 여기 기억해 두고
// DB 목록에 끼워 보여 준다. 첫 컬렉션이 생기면 진짜 DB가 되어 여기서 빠지고, 서버를 다시 켜면
// (비어 있었으므로) 사라진다.
const byConnection = new Map<string, Set<string>>();

export const emptyDatabasesOf = (connectionId: string): Set<string> => {
  let names = byConnection.get(connectionId);
  if (!names) {
    names = new Set();
    byConnection.set(connectionId, names);
  }
  return names;
};
