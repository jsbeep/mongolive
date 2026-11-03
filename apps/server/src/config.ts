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

export const config = {
  mongoUri: required('MONGODB_URI'),
  // 기본은 이 기기에서만 접속 가능. 외부 접속은 7단계(인증)를 붙인 뒤에 연다.
  host: process.env.HOST || '127.0.0.1',
  port: port('PORT', 4000),
  // 앱 메타데이터(PK/FK 선언 등) 파일 — MongoDB가 아니라 이 컴퓨터에 저장한다
  metaFile: process.env.META_FILE || join(homedir(), '.mongolive', 'meta.json'),
} as const;
