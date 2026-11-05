// 요청이 원래 어땠는지 — 앞단 프록시(Caddy, nginx, Tailscale serve 등) 뒤에 있을 때를 위해.
//
// 프록시가 HTTPS를 맡으면 우리 서버엔 모든 요청이 "127.0.0.1에서 온 HTTP"로 보인다. 원래 정보는 프록시가 헤더로 붙여 준다:
//   X-Forwarded-Proto  원래 https였는지   → 쿠키에 Secure를 붙일지
//   X-Forwarded-For    원래 접속한 IP      → 로그인 잠금을 누구에게 걸지
//   X-Forwarded-Host   원래 주소창의 주소  → Origin 검사
// 이 헤더들은 누구나 지어낼 수 있으므로 TRUST_PROXY=true이고, 연결이 이 기기 안(프록시)에서 왔을 때만 믿는다.
import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { config } from './config';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const fromTrustedProxy = (req: IncomingMessage): boolean =>
  config.trustProxy && LOOPBACK_PEERS.has(req.socket.remoteAddress ?? '');

// "a, b, c" — 프록시를 지날 때마다 뒤에 붙는다. 우리 프록시가 붙인 건 맨 뒤 값이고,
// 그 앞의 값들은 접속한 쪽이 지어냈을 수도 있으므로 맨 뒤만 쓴다.
const lastValue = (header: string | string[] | undefined): string | null => {
  const raw = Array.isArray(header) ? header.join(',') : header;
  const last = raw?.split(',').pop()?.trim();
  return last ? last : null;
};

export const isHttps = (req: IncomingMessage): boolean => {
  if ((req.socket as TLSSocket).encrypted === true) return true;
  return fromTrustedProxy(req) && lastValue(req.headers['x-forwarded-proto']) === 'https';
};

export const clientIp = (req: IncomingMessage): string => {
  if (fromTrustedProxy(req)) return lastValue(req.headers['x-forwarded-for']) ?? req.socket.remoteAddress ?? 'unknown';
  return req.socket.remoteAddress ?? 'unknown';
};

// 브라우저 주소창의 주소(host:port). nginx는 기본 설정에서 Host를 바꿔 넘기므로 X-Forwarded-Host를 먼저 본다
export const requestHost = (req: IncomingMessage): string | undefined => {
  if (fromTrustedProxy(req)) return lastValue(req.headers['x-forwarded-host']) ?? req.headers.host;
  return req.headers.host;
};
