import { homedir } from 'node:os';
import { join } from 'node:path';

// 환경변수 → 설정 객체. 서버 전체에서 process.env를 직접 읽지 말고 이 모듈만 쓴다.
// 값은 apps/server/.env(커밋 안 됨)에서 Node의 --env-file로 들어온다. 예시는 .env.example.

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`환경변수 ${name}가 없습니다. apps/server/.env.example을 복사해 .env를 만드세요.`);
  }
  return value;
};

const port = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`환경변수 ${name}=${raw}는 올바른 포트가 아닙니다.`);
  return n;
};

const AUTH_MODES = ['none', 'google', 'proxy'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

const authMode = (): AuthMode => {
  const raw = process.env.AUTH_MODE || 'none';
  if (!(AUTH_MODES as readonly string[]).includes(raw)) {
    throw new Error(`AUTH_MODE=${raw}는 없는 모드입니다. ${AUTH_MODES.join(' / ')} 중 하나를 쓰세요.`);
  }
  if (raw !== 'none') throw new Error(`AUTH_MODE=${raw}는 아직 준비 중입니다(7단계 진행 중).`);
  return raw as AuthMode;
};

// 이 기기 안에서만 닿는 주소
const LOOPBACK_BIND = new Set(['127.0.0.1', '::1', 'localhost']);

const host = process.env.HOST || '127.0.0.1';
const mode = authMode();
// 인증 없이 바깥에 문을 열면 주소를 아는 누구나 DB를 고칠 수 있다 — 아예 켜지 않는다
if (mode === 'none' && !LOOPBACK_BIND.has(host)) {
  throw new Error(`AUTH_MODE=none인데 HOST=${host}입니다. 인증 없이 외부에 열 수 없습니다 — HOST=127.0.0.1로 두거나 AUTH_MODE를 정하세요.`);
}

export const config = {
  mongoUri: required('MONGODB_URI'),
  // 기본은 이 기기에서만 접속 가능
  host,
  authMode: mode,
  port: port('PORT', 31501),
  // 앱 메타데이터(PK/FK 선언 등) 파일 — MongoDB가 아니라 이 컴퓨터에 저장한다
  metaFile: process.env.META_FILE || join(homedir(), '.mongolive', 'meta.json'),
} as const;
