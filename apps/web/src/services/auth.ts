// 로그인/로그아웃/상태 — 서버의 /api/auth/*. remote 모드에서만 쓴다(Mock은 서버가 없다).
//
// 출입증 쿠키는 HttpOnly라 이 코드에서도 읽을 수 없다. 브라우저가 알아서 저장하고 요청마다 붙여 보낸다.
// 그래서 "로그인했나?"는 쿠키를 들여다보는 대신 서버에 묻는다(/api/auth/me).
export interface AuthStatus {
  mode: 'password' | 'proxy';
  authenticated: boolean;
}

export type LoginFailure =
  | { kind: 'wrong' } // 비밀번호 틀림
  | { kind: 'locked'; retryAfter: number } // 너무 많이 틀려 잠김(초)
  | { kind: 'busy'; retryAfter: number } // 서버가 다른 로그인 확인 중
  | { kind: 'unreachable' } // 서버에 닿지 않음
  | { kind: 'other'; message: string };

export class LoginError extends Error {
  constructor(readonly failure: LoginFailure) {
    super(failure.kind);
  }
}

const post = (path: string, body?: unknown) =>
  fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const fetchAuthStatus = async (): Promise<AuthStatus> => {
  const response = await fetch('/api/auth/me');
  // 서버가 꺼져 있으면 Vite 프록시가 5xx를 돌려준다
  if (!response.ok) throw new Error(`server ${response.status}`);
  return (await response.json()) as AuthStatus;
};

export const login = async (password: string): Promise<void> => {
  let response: Response;
  try {
    response = await post('login', { password });
  } catch {
    throw new LoginError({ kind: 'unreachable' });
  }
  if (response.ok) return;

  const body = (await response.json().catch(() => ({}))) as { error?: string; retryAfter?: number };
  const retryAfter = typeof body.retryAfter === 'number' ? body.retryAfter : 5;
  if (response.status === 401) throw new LoginError({ kind: 'wrong' });
  if (response.status === 429) {
    throw new LoginError(body.error === 'too many attempts' ? { kind: 'locked', retryAfter } : { kind: 'busy', retryAfter });
  }
  if (response.status >= 500) throw new LoginError({ kind: 'unreachable' });
  throw new LoginError({ kind: 'other', message: body.error ?? `${response.status}` });
};

export const logout = async (): Promise<void> => {
  await post('logout');
};

// ── 쓰는 도중 출입증이 무효가 됐을 때 ──
// 30일이 지났거나, 다른 곳에서 비밀번호를 바꿨으면(모든 기기 로그아웃) 요청이 401로 돌아온다.
// remoteDataSource가 401을 보면 여기로 알리고, AuthGate가 로그인 화면을 다시 띄운다.
const expiredListeners = new Set<() => void>();

export const onSessionExpired = (listener: () => void): (() => void) => {
  expiredListeners.add(listener);
  return () => expiredListeners.delete(listener);
};

export const notifySessionExpired = (): void => expiredListeners.forEach((listener) => listener());
