// 안전장치 설정(설정 창 › Safety) — 화면 쪽 사본. 원본은 데이터 소스(remote: 서버 settings.json, mock: localStorage).
// 앱이 켜질 때 한 번 받고(startServerSettingsSync), 다른 탭·기기에서 바꾸면 소켓으로 따라 바뀐다.
// 화면은 이걸로 편집 버튼을 숨기고 쓰기 전에 미리 알린다 — 실제로 막는 건 서버(/mutate 403)다.
import { useSyncExternalStore } from 'react';
import { DEFAULT_SERVER_SETTINGS, isProtected, type ServerSettings } from '../types/explorer';
import { api } from './api';

let current: ServerSettings = DEFAULT_SERVER_SETTINGS;
const listeners = new Set<() => void>();

const set = (next: ServerSettings) => {
  current = next;
  listeners.forEach((listener) => listener());
};

export const getServerSettingsSnapshot = (): ServerSettings => current;

// 앱 시작 때 한 번(page.tsx). 끊겼다 다시 붙으면 그 사이 바뀐 걸 놓쳤을 수 있으니 다시 받는다
export const startServerSettingsSync = (): (() => void) => {
  const refetch = () => {
    api.getServerSettings().then(set).catch(() => undefined);
  };
  refetch();
  const offSettings = api.onServerSettings(set);
  const offStatus = api.onLiveStatus((status) => {
    if (status.resync) refetch();
  });
  return () => {
    offSettings();
    offStatus();
  };
};

export const saveServerSettings = async (next: ServerSettings): Promise<void> => {
  set(await api.saveServerSettings(next));
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useServerSettings = (): ServerSettings => useSyncExternalStore(subscribe, getServerSettingsSnapshot);

// 여기(DB, 컬렉션)를 편집할 수 있나 — read-only가 아니고 보호 대상도 아니면. database가 없으면(아직 모름) 읽기 전용만 본다
export const canEditIn = (settings: ServerSettings, database: string | null | undefined, collection?: string | null): boolean => {
  if (settings.readOnly) return false;
  if (!database) return true;
  if (isProtected(settings, database)) return false;
  return !collection || !isProtected(settings, database, collection);
};

export const useCanEdit = (database: string | null | undefined, collection?: string | null): boolean =>
  canEditIn(useServerSettings(), database, collection);
