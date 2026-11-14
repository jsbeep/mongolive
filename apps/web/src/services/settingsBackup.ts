// 설정 내보내기/가져오기(설정 › Data) — 다른 브라우저·기기로 옮기거나 되돌려 놓을 때.
//   local  : 이 브라우저의 설정(localStorage) 중 옮길 만한 것만 — 아래 목록에 있는 키만 쓰고 읽는다
//            ('어디까지 읽었나' 같은 이 브라우저만의 상태는 넣지 않는다)
//            연결마다 따로 두는 것(북마크·필터 기억)은 모든 연결의 것을 넣는다 — "mongolive.bookmarks@<연결 id>".
//            연결을 나누기 전에 만든 백업 파일의 값은 기본 연결(.env / 데모)의 것으로 가져온다.
//   server : 서버 Safety 설정(read-only·보호 대상) — 모든 브라우저에 영향을 주므로 가져올 때 따로 골라야 적용된다
// 보안 설정(.env)·비밀번호는 넣지 않는다(화면에서 바꿀 수 없는 것이므로).
import { normalizeServerSettings, type ServerSettings } from '../types/explorer';
import { saveServerSettings } from './serverSettings';
import { connectionIdOfKey, LEGACY_CONNECTION_ID, scopedKey } from './connectionStorage';

const LOCAL_KEYS: readonly string[] = [
  'mongolive.preferences', // 표시·삭제 확인·Undo 단계·반영 간격·애니메이션·글꼴
  'mongolive.activity.hiddenOps', // 변경 기록 배지로 끈 종류
  'mongolive.sidebar.mode',
  'mongolive.sidebar.restore',
  'mongolive.sidebar.width',
];

// 연결마다 따로 두는 것
const SCOPED_KEYS: readonly string[] = [
  'mongolive.collectionQuery', // 컬렉션별 필터·정렬·쿼리
  'mongolive.bookmarks', // 경로 북마크
];

// 백업에 넣을 키인가 — 그대로 쓸 키를 돌려준다(옛 백업의 연결 구분 없는 키는 기본 연결의 키로). 아니면 null
const backupKey = (key: string): string | null => {
  if (LOCAL_KEYS.includes(key)) return key;
  if (SCOPED_KEYS.includes(key)) return scopedKey(key, LEGACY_CONNECTION_ID);
  return SCOPED_KEYS.some((base) => connectionIdOfKey(base, key) !== null) ? key : null;
};

export interface SettingsBackup {
  app: 'mongolive';
  version: 1;
  exportedAt: string;
  // 키 → localStorage 값 그대로
  local: Record<string, string>;
  server?: ServerSettings;
}

export const buildBackup = (server: ServerSettings | null): SettingsBackup => {
  const local: SettingsBackup['local'] = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || backupKey(key) !== key) continue;
      const value = localStorage.getItem(key);
      if (value !== null) local[key] = value;
    }
  } catch {
    // 못 읽으면 빼고 간다
  }
  return { app: 'mongolive', version: 1, exportedAt: new Date().toISOString(), local, ...(server ? { server } : {}) };
};

export const downloadBackup = (backup: SettingsBackup) => {
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mongolive-settings-${backup.exportedAt.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

// 파일 내용 → 백업. 모양이 틀리면 이유를 담아 던진다. 목록에 없는 키·문자열이 아닌 값은 버린다
export const parseBackup = (text: string): SettingsBackup => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This file isn't JSON.");
  }
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (obj.app !== 'mongolive' || obj.version !== 1) throw new Error("This isn't a MongoLive settings file.");
  const local: SettingsBackup['local'] = {};
  const src = obj.local && typeof obj.local === 'object' ? (obj.local as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(src)) {
    const target = backupKey(key);
    if (target && typeof value === 'string') local[target] = value;
  }
  return {
    app: 'mongolive',
    version: 1,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
    local,
    ...(obj.server !== undefined ? { server: normalizeServerSettings(obj.server) } : {}),
  };
};

// 적용 후 새로고침 — 사이드바 배치 등은 켜질 때 한 번 읽으므로, 다시 불러오는 게 가장 확실하다
export const applyBackup = async (backup: SettingsBackup, withServer: boolean): Promise<void> => {
  if (withServer && backup.server) await saveServerSettings(backup.server);
  for (const [key, value] of Object.entries(backup.local)) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 저장이 막혀 있으면 그 항목만 빠진다
    }
  }
  window.location.reload();
};
