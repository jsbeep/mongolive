// localStorage 기반 인메모리 Mock 구현. 실제 서버 구현(4단계)과 같은 DataSource 계약을 지킨다.
import type { DataSource } from './dataSource';
import type { MockSnapshot } from '../types/explorer';
import * as mock from './mockAPI';
import { getUniqueOids, setUniqueOids } from './mockStorage';

export const createMockDataSource = (): DataSource => {
  // 한 단계 undo — mutate 직전 스냅샷. 예전엔 훅(useExplorerState)이 저장소를 직접 읽어
  // 들고 있었는데, 그건 Mock에서만 가능한 방식이라 데이터 소스 안으로 옮겼다.
  let undoPoint: MockSnapshot | null = null;

  return {
    connect: mock.connect,
    listDatabases: mock.listDatabases,
    getCollections: mock.getCollections,
    getDocuments: mock.getDocuments,

    getDocumentById: mock.getDocumentById,
    getFullDocumentById: mock.getFullDocumentById,
    getFullDocumentByIdInCollection: mock.getFullDocumentByIdInCollection,
    exportCollection: mock.exportCollection,

    checkReference: mock.checkReference,
    getReferenceInfo: mock.getReferenceInfo,
    getReferenceCandidatesByField: mock.getReferenceCandidatesByField,
    getFieldValueCandidates: mock.getFieldValueCandidates,

    async mutate(op) {
      const before = mock.captureSnapshot();
      const result = await mock.mutateData(op);
      undoPoint = before;
      return result;
    },

    async undoLast() {
      if (!undoPoint) return false;
      mock.restoreSnapshot(undoPoint);
      undoPoint = null;
      return true;
    },
    canUndo: () => undoPoint !== null,

    // Mock 데이터는 이 앱 안에서만 바뀌고, 바꾼 쪽(훅)이 직접 다시 읽는다 — 바깥 변경 이벤트가 없다
    setLiveView: () => undefined,
    onLiveChange: () => () => undefined,
    onLiveStatus: () => () => undefined,
    onActivityLog: () => () => undefined,
    getMetrics: async () => null,

    async listOwnedOids() {
      return getUniqueOids();
    },

    async setOwnedOid(oid, owned) {
      const current = new Set(getUniqueOids());
      if (owned) current.add(oid);
      else current.delete(oid);
      setUniqueOids([...current]);
    },
  };
};
