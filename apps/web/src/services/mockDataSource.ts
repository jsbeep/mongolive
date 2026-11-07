// localStorage 기반 인메모리 Mock 구현. 실제 서버 구현(4단계)과 같은 DataSource 계약을 지킨다.
import type { DataSource } from './dataSource';
import { normalizeServerSettings, writeBlockedReason, type MockSnapshot, type MutationRequest, type ServerSettings } from '../types/explorer';
import * as mock from './mockAPI';
import { getUniqueOids, setUniqueOids } from './mockStorage';

// 안전장치 설정 — Mock엔 서버가 없으니 이 브라우저에 둔다
const SETTINGS_KEY = 'mongolive.mock.serverSettings';
const loadSettings = (): ServerSettings => {
  try {
    return normalizeServerSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
  } catch {
    return normalizeServerSettings({});
  }
};

export const createMockDataSource = (): DataSource => {
  // 한 단계 undo — mutate 직전 스냅샷. 예전엔 훅(useExplorerState)이 저장소를 직접 읽어
  // 들고 있었는데, 그건 Mock에서만 가능한 방식이라 데이터 소스 안으로 옮겼다.
  // 되돌리기는 mutate를 거치지 않으므로, 안전장치 판정을 위해 그 쓰기(op)도 같이 기억한다.
  let undoPoint: { snapshot: MockSnapshot; op: MutationRequest } | null = null;
  let settings = loadSettings();
  const settingsListeners = new Set<(s: ServerSettings) => void>();
  // 서버의 403과 같은 규칙(packages/shared/safety)
  const guard = (op: MutationRequest) => {
    const reason = writeBlockedReason(settings, op);
    if (reason) throw Object.assign(new Error(reason), { status: 403 });
  };

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
      guard(op);
      const before = mock.captureSnapshot();
      const result = await mock.mutateData(op);
      undoPoint = { snapshot: before, op };
      return result;
    },

    async undoLast() {
      if (!undoPoint) return false;
      guard(undoPoint.op);
      mock.restoreSnapshot(undoPoint.snapshot);
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
    getDiagnostics: async () => null,

    getServerSettings: async () => settings,
    async saveServerSettings(next) {
      settings = normalizeServerSettings(next);
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        // 저장이 막혀 있어도 이번 탭에선 적용된다
      }
      settingsListeners.forEach((listener) => listener(settings));
      return settings;
    },
    onServerSettings(listener) {
      settingsListeners.add(listener);
      return () => {
        settingsListeners.delete(listener);
      };
    },

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
