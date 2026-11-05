// 문지기 — 모든 요청(/api와 /socket.io)이 여기를 지나간다.
//
// AUTH_MODE
//   none    인증 없음. 이 기기에서만 쓸 때. HOST가 loopback이 아니면 서버를 켜지 않는다(config.ts).
//   google  내장 Google 로그인 (7-2 예정)
//   proxy   앞단(Cloudflare Access 등)이 로그인을 맡고 이메일을 넘겨준다 (7-3 예정)
//
// none 모드에서 막는 두 가지 공격
//   DNS rebinding  악성 사이트가 자기 도메인이 127.0.0.1을 가리키게 바꿔 '같은 사이트'인 척 → Host 검사로 막는다
//                  (덤: 터널을 붙여 놓고 인증을 깜빡해도 Host가 진짜 도메인이라 거절된다)
//   교차 사이트 WebSocket  WebSocket은 CORS를 안 따른다. 다른 사이트 페이지가 붙어 실시간 변경을 엿볼 수 있다
//                  → 브라우저가 붙여 보내는 Origin이 우리 주소(Host)와 같은지 본다
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import { config } from './config';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// "localhost:5173" → "localhost". 이상한 값이면 null
const hostnameOf = (host: string): string | null => {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
};

export const isLoopbackHost = (host: string): boolean => LOOPBACK_NAMES.has(hostnameOf(host) ?? '');

// 거절 사유를 돌려준다. 통과면 null
export const checkRequest = (req: IncomingMessage): string | null => {
  const host = req.headers.host ?? '';

  // Origin은 브라우저가 붙이는 '요청을 보낸 페이지의 주소'. 페이지 JS가 바꿀 수 없다.
  // 없으면 브라우저 밖(curl, 스크립트) 요청이라 교차 사이트 공격이 아니다.
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // Origin: null(파일에서 연 페이지 등) — 우리 페이지가 아니다
    }
    if (originHost !== host) return 'cross-origin request';
  }

  if (config.authMode === 'none' && !isLoopbackHost(host)) return 'AUTH_MODE=none accepts only localhost';
  return null;
};

export const guard: RequestHandler = (req, res, next) => {
  const reason = checkRequest(req);
  if (reason) {
    res.status(403).json({ error: reason });
    return;
  }
  next();
};

// socket.io의 allowRequest 모양
export const allowSocket = (req: IncomingMessage, callback: (err: string | null | undefined, ok: boolean) => void): void => {
  const reason = checkRequest(req);
  callback(reason, reason === null);
};
