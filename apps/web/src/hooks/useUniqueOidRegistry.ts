// path: src/hooks/useUniqueOidRegistry.ts
import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api';

// 이 앱이 직접 생성한 '고유 oid' 집합 — 다른 문서를 참조하지 않는 단순 식별자 값.
// 여기 없는 단일 {$oid} 필드는 모두 DBRef(참조)로 분류된다.
// 저장은 데이터 소스 메타데이터에 한다(Mock: localStorage, 실제 서버: 서버 컴퓨터의 meta.json — MongoDB엔 안 씀).
export function useUniqueOidRegistry() {
  const [uniqueOids, setUniqueOids] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    api.listOwnedOids()
      .then((oids) => {
        if (cancelled) return;
        // 로드 전에 등록된 항목이 있을 수 있으니 덮어쓰지 않고 합친다
        setUniqueOids((prev) => new Set([...oids, ...prev]));
      })
      .catch(() => { /* 분류 힌트일 뿐이라 실패해도 진행 */ });
    return () => { cancelled = true; };
  }, []);

  const registerUniqueOid = useCallback((oid: string) => {
    setUniqueOids((prev) => {
      if (prev.has(oid)) return prev;
      const next = new Set(prev);
      next.add(oid);
      return next;
    });
    void api.setOwnedOid(oid, true).catch(() => {});
  }, []);

  const unregisterUniqueOid = useCallback((oid: string) => {
    setUniqueOids((prev) => {
      if (!prev.has(oid)) return prev;
      const next = new Set(prev);
      next.delete(oid);
      return next;
    });
    void api.setOwnedOid(oid, false).catch(() => {});
  }, []);

  return { uniqueOids, registerUniqueOid, unregisterUniqueOid };
}
