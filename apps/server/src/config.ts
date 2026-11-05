import { fileURLToPath } from 'node:url';
import { authFilePath, metaFilePath } from './paths';

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

const AUTH_MODES = ['password', 'proxy'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

const authMode = (): AuthMode => {
  const raw = process.env.AUTH_MODE || 'password';
  if (raw === 'none') throw new Error('AUTH_MODE=none은 없어졌습니다 — 이 기기에서 접속해도 비밀번호 로그인을 합니다. AUTH_MODE를 지우세요.');
  if (!(AUTH_MODES as readonly string[]).includes(raw)) {
    throw new Error(`AUTH_MODE=${raw}는 없는 모드입니다. ${AUTH_MODES.join(' / ')} 중 하나를 쓰세요.`);
  }
  if (raw === 'proxy') throw new Error('AUTH_MODE=proxy는 아직 준비 중입니다(7단계 진행 중).');
  return raw as AuthMode;
};

// HTTPS 인증서 — 둘 다 주거나 둘 다 비운다
const tls = (): { cert: string; key: string } | null => {
  const cert = process.env.TLS_CERT;
  const key = process.env.TLS_KEY;
  if (!cert && !key) return null;
  if (!cert || !key) throw new Error('TLS_CERT와 TLS_KEY는 함께 정해야 합니다(인증서 파일과 그 비밀키 파일).');
  return { cert, key };
};

const flag = (name: string): boolean => {
  const raw = process.env[name];
  if (!raw) return false;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`환경변수 ${name}=${raw}는 true 또는 false여야 합니다.`);
};

// 이 기기 안에서만 닿는 주소
const LOOPBACK_BIND = new Set(['127.0.0.1', '::1', 'localhost']);
const host = process.env.HOST || '127.0.0.1';
const loopbackOnly = LOOPBACK_BIND.has(host);
const tlsFiles = tls();
const allowInsecureHttp = flag('ALLOW_INSECURE_HTTP');

// 바깥에 HTTP로 열면 비밀번호와 출입증 쿠키가 암호화되지 않은 채 오간다 — 켜지 않는다.
// 같은 공유기 안에서 잠깐 시험할 때만 ALLOW_INSECURE_HTTP=true로 일부러 허용한다.
if (!loopbackOnly && !tlsFiles && !allowInsecureHttp) {
  throw new Error(
    `HOST=${host}(외부에 열림)인데 HTTPS가 없습니다. 비밀번호가 평문으로 오가게 되므로 켜지 않습니다.\n` +
      '  - HTTPS로: TLS_CERT, TLS_KEY에 인증서 파일 경로를 넣으세요\n' +
      '  - 앞단 프록시(Caddy, nginx, Tailscale 등)가 HTTPS를 맡으면: HOST=127.0.0.1로 두고 프록시만 붙게 하세요\n' +
      '  - 그래도 HTTP로 열려면(시험용): ALLOW_INSECURE_HTTP=true',
  );
}

export const config = {
  mongoUri: required('MONGODB_URI'),
  // 기본은 이 기기에서만 접속 가능
  host,
  loopbackOnly,
  port: port('PORT', 4000),
  // 있으면 HTTPS로 연다. 파일이 바뀌면(인증서 갱신) 서버를 다시 켜지 않아도 새 인증서를 쓴다
  tls: tlsFiles,
  allowInsecureHttp,
  // 앞단 프록시가 붙여 주는 X-Forwarded-* 헤더를 믿을지(이 기기 안에서 온 연결일 때만). proxy.ts
  trustProxy: flag('TRUST_PROXY'),
  authMode: authMode(),
  // 비밀번호 해시 + 쿠키 서명 키 (set-password가 만든다)
  authFile: authFilePath(),
  // 앱 메타데이터(PK/FK 선언 등) 파일 — MongoDB가 아니라 이 컴퓨터에 저장한다
  metaFile: metaFilePath(),
  // 빌드된 웹 화면(corepack pnpm build). 있으면 서버가 화면까지 내준다 — 포트 하나로 배포할 때
  webDist: process.env.WEB_DIST || fileURLToPath(new URL('../../web/dist', import.meta.url)),
} as const;
