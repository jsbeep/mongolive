// Monitor 카드의 마지막 응답을 기억한다.
// 탭을 바꾸면 카드가 새로 만들어진다 — 빈칸(그리고 한 박자 늦게 뜨는 줄) 대신 지난 응답을 바로 그리고 뒤에서 새로 받는다.
//   refreshing = 지난 응답을 보여 주는 중(새 응답이 아직 안 옴) — 카드 제목 옆 작은 스피너
// 메모리에만, 연결·카드·조회 조건마다. 요청 수는 그대로다.
import { useCallback, useState } from 'react';
import { getActiveConnection } from '../services/activeConnection';

const memory = new Map<string, unknown>();

export function useCachedReport<T>(card: string, key: string) {
  const full = `${getActiveConnection() ?? ''}\u0000${card}\u0000${key}`;
  const recall = (): { full: string; report: T | null; fresh: boolean } => ({ full, report: (memory.get(full) as T | null | undefined) ?? null, fresh: false });
  const [state, setState] = useState(recall);
  // 조회 조건이 바뀌면 그 조건의 기억으로(렌더 중에 맞춘다 — 빈 화면 한 번 없이)
  let current = state;
  if (state.full !== full) {
    current = recall();
    setState(current);
  }
  const setReport = useCallback(
    (report: T | null) => {
      memory.set(full, report);
      setState({ full, report, fresh: true });
    },
    [full],
  );
  // loaded = 한 번이라도 받았거나 기억이 있다(Mock처럼 null만 오는 곳에서 스켈레톤이 남지 않게)
  return { report: current.report, loaded: current.fresh || current.report !== null, refreshing: current.report !== null && !current.fresh, setReport };
}
