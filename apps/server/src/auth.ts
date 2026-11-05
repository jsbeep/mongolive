// 문지기 — 모든 요청(/api와 /socket.io)이 여기를 지나간다.
//
// AUTH_MODE
//   password  (기본) 내장 비밀번호 로그인. 이 기기(localhost)에서 접속해도 로그인해야 한다.
//   proxy     앞단(Tailscale, Cloudflare Access 등)이 로그인을 맡는다 (준비 중)
//
// 검사 순서
//   1. Origin   브라우저가 붙여 보내는 '요청을 보낸 페이지의 주소'. 우리 주소(Host)와 달라야 할 이유가 없다.
//               WebSocket은 CORS를 안 따라서 이걸 안 보면 다른 사이트 페이지가 실시간 변경을 엿볼 수 있다.
//   2. 출입증   로그인 때 받은 쿠키. 공개 경로(로그인/로그아웃/상태)만 없이 통과.
//
// 출입증 쿠키: mongolive_session = <만료시각(ms)>.<서명>
//   서명 = HMAC-SHA256(서버 비밀키, 만료시각). 만료시각을 고치면 서명이 안 맞아 거절된다.
//   서버는 따로 저장하지 않는다(MongoDB에도, 파일에도) — 서명만 검증하면 된다.
//   HttpOnly(페이지 JS가 못 읽음), SameSite=Strict(다른 사이트에서 시작된 요청엔 안 붙음).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { Router, type RequestHandler } from 'express';
import { loadAuthData, MAX_PASSWORD_LENGTH, verifyPassword, type AuthData } from './authFile';
import { config } from './config';
import { clientIp, isHttps, requestHost } from './proxy';

const COOKIE_NAME = 'mongolive_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30일

// 출입증 없이 들어올 수 있는 곳
const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me']);

const authData = (): AuthData => {
  const data = loadAuthData(config.authFile);
  // 서버를 켤 때 확인하지만, 켜진 뒤 파일이 지워졌을 수도 있다
  if (!data) throw new Error('비밀번호가 정해져 있지 않습니다 (set-password)');
  return data;
};

// ── 출입증 ───────────────────────────────────────────────────────────────────

const sign = (expires: number, secret: string): string =>
  createHmac('sha256', Buffer.from(secret, 'base64')).update(`v1.${expires}`).digest('base64url');

const readCookie = (req: IncomingMessage, name: string): string | null => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
};

export const hasValidSession = (req: IncomingMessage): boolean => {
  const value = readCookie(req, COOKIE_NAME);
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot === -1) return false;
  const expires = Number(value.slice(0, dot));
  if (!Number.isSafeInteger(expires) || expires <= Date.now()) return false;
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(expires, authData().sessionSecret));
  return given.length === expected.length && timingSafeEqual(given, expected);
};

// HTTPS로 들어온 요청이면(직접이든 프록시를 거쳐서든) Secure(HTTPS에서만 보냄)도 붙인다

const cookieAttributes = (req: IncomingMessage, maxAgeSeconds: number): string =>
  ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`, ...(isHttps(req) ? ['Secure'] : [])].join('; ');

const issueSession = (req: IncomingMessage, res: ServerResponse): void => {
  const expires = Date.now() + SESSION_MS;
  const value = `${expires}.${sign(expires, authData().sessionSecret)}`;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; ${cookieAttributes(req, SESSION_MS / 1000)}`);
};

const clearSession = (req: IncomingMessage, res: ServerResponse): void => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttributes(req, 0)}`);
};

// ── 문지기 ───────────────────────────────────────────────────────────────────

interface Rejection {
  status: 401 | 403;
  error: string;
}

const pathOf = (req: IncomingMessage): string => new URL(req.url ?? '/', 'http://x').pathname;

export const checkRequest = (req: IncomingMessage): Rejection | null => {
  // 1. Origin — 없으면 브라우저 밖(curl, 스크립트) 요청이라 교차 사이트 공격이 아니다
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // Origin: null(파일에서 연 페이지 등) — 우리 페이지가 아니다
    }
    if (originHost !== requestHost(req)) return { status: 403, error: 'cross-origin request' };
  }

  // 2. 출입증
  if (PUBLIC_PATHS.has(pathOf(req))) return null;
  if (!hasValidSession(req)) return { status: 401, error: 'login required' };
  return null;
};

// /api만 지킨다. 그 밖(빌드된 화면 파일 HTML/JS/CSS)은 어차피 공개된 코드라 로그인 전에도 내준다
// — 로그인 화면 자체도 그 파일들로 그려지므로.
export const guard: RequestHandler = (req, res, next) => {
  if (req.path !== '/api' && !req.path.startsWith('/api/')) {
    next();
    return;
  }
  const rejection = checkRequest(req);
  if (rejection) {
    res.status(rejection.status).json({ error: rejection.error });
    return;
  }
  next();
};

// socket.io의 allowRequest 모양
export const allowSocket = (req: IncomingMessage, callback: (err: string | null | undefined, ok: boolean) => void): void => {
  const rejection = checkRequest(req);
  callback(rejection?.error, rejection === null);
};

// ── 로그인 시도 제한 ─────────────────────────────────────────────────────────
// IP마다 5번까지는 그냥 틀려도 되고, 그다음부터는 틀릴 때마다 잠금 시간이 두 배(1분 → 2분 → … 최대 1시간).
// 기록은 메모리에만 — 서버를 재시작하면 풀린다.
// IP는 연결의 실제 주소. X-Forwarded-For 헤더는 누구나 지어낼 수 있어서 TRUST_PROXY일 때 프록시가 붙인 값만 믿는다(proxy.ts).

const FREE_FAILURES = 5;
const BASE_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 60 * 60 * 1000;
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

interface Failures {
  count: number;
  lockedUntil: number;
  last: number;
}

const failures = new Map<string, Failures>();

const lockRemainingMs = (ip: string): number => {
  const entry = failures.get(ip);
  if (!entry) return 0;
  if (Date.now() - entry.last > FORGET_AFTER_MS) {
    failures.delete(ip);
    return 0;
  }
  return Math.max(0, entry.lockedUntil - Date.now());
};

const recordFailure = (ip: string): void => {
  const now = Date.now();
  // 오래된 기록 정리 — 여러 IP로 두드려도 메모리가 끝없이 늘지 않게
  for (const [key, entry] of failures) if (now - entry.last > FORGET_AFTER_MS) failures.delete(key);
  const entry = failures.get(ip) ?? { count: 0, lockedUntil: 0, last: now };
  entry.count += 1;
  entry.last = now;
  if (entry.count >= FREE_FAILURES) {
    entry.lockedUntil = now + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (entry.count - FREE_FAILURES));
  }
  failures.set(ip, entry);
};

// scrypt는 한 번에 128MB를 쓴다. 동시에 몰려도 하나씩만 돌리고, 줄이 너무 길면 바로 거절한다.
const MAX_WAITING = 8;
let waiting = 0;
let hashQueue: Promise<unknown> = Promise.resolve();

const oneAtATime = <T>(task: () => Promise<T>): Promise<T> | null => {
  if (waiting >= MAX_WAITING) return null;
  waiting += 1;
  const run = hashQueue.then(task).finally(() => {
    waiting -= 1;
  });
  hashQueue = run.catch(() => undefined);
  return run;
};

// ── 로그인 API ───────────────────────────────────────────────────────────────

export const authRouter = Router();
// 로그인은 출입증 없이 받는 요청이라 본문을 작게 제한한다(다른 API는 10MB)
authRouter.use(express.json({ limit: '4kb' }));

authRouter.get('/auth/me', (req, res) => {
  res.json({ mode: config.authMode, authenticated: hasValidSession(req) });
});

authRouter.post('/auth/login', async (req, res) => {
  const ip = clientIp(req);
  const locked = lockRemainingMs(ip);
  if (locked > 0) {
    const seconds = Math.ceil(locked / 1000);
    res.setHeader('Retry-After', String(seconds));
    res.status(429).json({ error: 'too many attempts', retryAfter: seconds });
    return;
  }

  const password: unknown = req.body?.password;
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({ error: 'password required' });
    return;
  }

  const check = oneAtATime(() => verifyPassword(password, authData().password));
  if (!check) {
    res.setHeader('Retry-After', '5');
    res.status(429).json({ error: 'busy, try again', retryAfter: 5 });
    return;
  }
  if (!(await check)) {
    recordFailure(ip);
    res.status(401).json({ error: 'wrong password' });
    return;
  }

  failures.delete(ip);
  issueSession(req, res);
  res.json({ mode: config.authMode, authenticated: true });
});

// 이 브라우저의 출입증만 지운다. 모든 기기에서 로그아웃하려면 set-password로 비밀번호를 바꾼다.
authRouter.post('/auth/logout', (req, res) => {
  clearSession(req, res);
  res.json({ mode: config.authMode, authenticated: false });
});
