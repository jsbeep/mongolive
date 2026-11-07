// 서버 쪽 설정 — ~/.mongolive/settings.json (MongoDB에는 저장하지 않는다: 흔적 없음 원칙)
// 설정 창 › Safety의 read-only, 보호 대상. 모든 브라우저에 똑같이 적용되고 /mutate가 이걸 보고 거절한다.
// 보안 설정(AUTH_MODE, HOST 등)은 여기 두지 않는다 — .env에서만 바꾼다.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_SERVER_SETTINGS, normalizeServerSettings, type ServerSettings } from '@mongolive/shared';
import { config } from './config';

let current: ServerSettings = DEFAULT_SERVER_SETTINGS;
const listeners = new Set<(settings: ServerSettings) => void>();
// 저장 요청을 한 줄로 세운다(동시에 두 번 쓰면 나중 것이 앞의 변경을 덮어쓸 수 있다)
let writeQueue: Promise<void> = Promise.resolve();

// 서버가 켜질 때 한 번. 파일이 없으면 기본값. 깨진 파일은 덮어쓰지 않도록 에러로 멈춘다
export const loadServerSettings = async (): Promise<void> => {
  try {
    current = normalizeServerSettings(JSON.parse(await readFile(config.settingsFile, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`${config.settingsFile}을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    current = DEFAULT_SERVER_SETTINGS;
  }
};

export const getServerSettings = (): ServerSettings => current;

// 임시 파일에 다 쓴 뒤 이름을 바꿔 교체 — 쓰는 도중 꺼져도 원래 파일은 온전하다
export const saveServerSettings = async (raw: unknown): Promise<ServerSettings> => {
  const next = normalizeServerSettings(raw);
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(config.settingsFile), { recursive: true });
    const tmp = `${config.settingsFile}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, config.settingsFile);
  });
  await writeQueue;
  current = next;
  listeners.forEach((listener) => listener(next));
  return next;
};

export const onServerSettingsChange = (listener: (settings: ServerSettings) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
