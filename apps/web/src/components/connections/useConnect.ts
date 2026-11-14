// 연결 고르기 — 먼저 접속해 보고(test) 되면 이 탭의 연결로 정한다. 안 되면 그 자리에 이유를 보여 준다
// (바로 넘어가면 닿지 않는 DB의 빈 화면만 보게 된다). 웰컴 화면과 사이드바의 Connections 패널이 같이 쓴다.
import { useCallback, useState } from 'react';
import { api } from '../../services/api';
import { setActiveConnection } from '../../services/activeConnection';

export interface ConnectAction {
  // 접속해 보는 중인 연결
  pendingId: string | null;
  failure: { id: string; message: string } | null;
  connect: (id: string) => Promise<void>;
  clearFailure: () => void;
}

export function useConnect(): ConnectAction {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ConnectAction['failure']>(null);

  const connect = useCallback(async (id: string) => {
    setPendingId(id);
    setFailure(null);
    try {
      const result = await api.testConnection({ id });
      if (result.ok) {
        setActiveConnection(id);
        return;
      }
      setFailure({ id, message: result.error ?? "Couldn't connect" });
    } catch (e) {
      setFailure({ id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPendingId(null);
    }
  }, []);

  return { pendingId, failure, connect, clearFailure: useCallback(() => setFailure(null), []) };
}
