// 저장된 연결 목록 — 처음 한 번 받고, 다른 탭·기기에서 추가·수정·삭제하면 소켓 알림('connections')으로 바뀐다.
// 웰컴 화면, 사이드바의 Connections 패널, 상태 바(지금 연결 이름·색)가 같이 쓴다.
import { useCallback, useEffect, useState } from 'react';
import type { ConnectionInfo } from '../types/explorer';
import { api } from '../services/api';
import { pruneRecentConnections } from '../services/activeConnection';

export interface ConnectionsState {
  connections: ConnectionInfo[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

// 즐겨찾기 먼저, 그다음 .env, 그다음 만든 순서
export const sortConnections = (list: ConnectionInfo[]): ConnectionInfo[] =>
  [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || Number(b.source !== 'saved') - Number(a.source !== 'saved') || (a.createdAt ?? 0) - (b.createdAt ?? 0));

export function useConnections(): ConnectionsState {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((list: ConnectionInfo[]) => {
    setConnections(sortConnections(list));
    setError(null);
  }, []);

  const reload = useCallback(async () => {
    try {
      apply(await api.listConnections());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void reload();
    return api.onConnections(apply);
  }, [reload, apply]);

  // 지워진 연결은 최근 목록에서도 뺀다(목록을 받은 뒤에만 — 처음 빈 목록으로 다 지우지 않게)
  useEffect(() => {
    if (!loading && !error) pruneRecentConnections(new Set(connections.map((c) => c.id)));
  }, [connections, loading, error]);

  return { connections, loading, error, reload };
}
