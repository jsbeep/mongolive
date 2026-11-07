// 앱이 이 컴퓨터에 두는 파일들의 경로. MongoDB에는 아무것도 저장하지 않는다(흔적 없음 원칙).
// config.ts와 따로 둔 이유: set-password 명령은 MongoDB 주소 없이도 돌아야 한다.
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR = join(homedir(), '.mongolive');

// PK/FK 선언, titleKey, 내가 만든 oid 목록
export const metaFilePath = (): string => process.env.META_FILE || join(APP_DIR, 'meta.json');

// 비밀번호 해시 + 쿠키 서명 키
export const authFilePath = (): string => process.env.AUTH_FILE || join(APP_DIR, 'auth.json');

// 서버 쪽 설정(설정 창 › Safety: read-only, 보호 대상). 보안 설정(.env)은 여기 두지 않는다
export const settingsFilePath = (): string => process.env.SETTINGS_FILE || join(APP_DIR, 'settings.json');
