// 비밀번호 저장소 — ~/.mongolive/auth.json (권한 600: 이 컴퓨터의 내 계정만 읽기/쓰기)
//
//   password       비밀번호 그 자체가 아니라 scrypt 해시. 파일이 새어 나가도 비밀번호는 알 수 없다.
//                  salt(무작위 값)를 섞어서, 같은 비밀번호라도 저장 값이 매번 다르다.
//   sessionSecret  로그인 쿠키에 도장(HMAC 서명)을 찍는 키. 비밀번호를 바꿀 때 새로 만든다
//                  → 예전 키로 찍힌 쿠키가 모두 무효 = 모든 기기에서 로그아웃.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// OWASP 권장 최소값. 라즈베리파이 5에서 한 번에 약 0.35초, 메모리 128MB.
// 일부러 느리고 무겁게 — 공격자가 1초에 수억 개를 대입해 보지 못하게 한다.
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;

export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 1024;

interface ScryptHash {
  algorithm: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string; // base64
  hash: string; // base64
}

export interface AuthData {
  version: 1;
  password: ScryptHash;
  sessionSecret: string; // base64, 32바이트
  updatedAt: string;
}

const runScrypt = (password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // maxmem: Node 기본(32MB)으로는 N=2^17을 못 돌린다. 필요한 양(128·N·r)의 두 배까지 허용
    scrypt(password, salt, KEY_LENGTH, { ...params, maxmem: 256 * params.N * params.r }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });

const hashPassword = async (password: string): Promise<ScryptHash> => {
  const salt = randomBytes(16);
  const hash = await runScrypt(password, salt, SCRYPT_PARAMS);
  return { algorithm: 'scrypt', ...SCRYPT_PARAMS, salt: salt.toString('base64'), hash: hash.toString('base64') };
};

// 저장된 값과 같은 방법(같은 salt, 같은 파라미터)으로 해시해 비교.
// timingSafeEqual: 몇 번째 글자에서 달라졌는지가 걸린 시간으로 새지 않게 끝까지 비교한다.
export const verifyPassword = async (password: string, stored: ScryptHash): Promise<boolean> => {
  const expected = Buffer.from(stored.hash, 'base64');
  const actual = await runScrypt(password, Buffer.from(stored.salt, 'base64'), stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const createAuthData = async (password: string): Promise<AuthData> => ({
  version: 1,
  password: await hashPassword(password),
  sessionSecret: randomBytes(32).toString('base64'),
  updatedAt: new Date().toISOString(),
});

// 임시 파일(처음부터 600)에 다 쓴 뒤 이름을 바꿔 교체 — 쓰는 도중 꺼져도 원래 파일은 온전하다
export const writeAuthFile = async (path: string, data: AuthData): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600); // 같은 이름의 임시 파일이 남아 있었으면 mode가 적용되지 않으므로 한 번 더
  await rename(tmp, path);
};

const isAuthData = (value: unknown): value is AuthData => {
  const v = value as AuthData;
  return (
    !!v &&
    v.version === 1 &&
    typeof v.sessionSecret === 'string' &&
    !!v.password &&
    v.password.algorithm === 'scrypt' &&
    [v.password.N, v.password.r, v.password.p].every((n) => Number.isInteger(n) && n > 0) &&
    typeof v.password.salt === 'string' &&
    typeof v.password.hash === 'string'
  );
};

// 서버가 요청마다 부른다. 파일이 바뀌었을 때만(수정 시각 비교) 다시 읽는다
// → 서버가 켜진 채로 set-password를 해도 바로 반영된다(재시작 불필요).
let cached: { mtimeMs: number; data: AuthData } | null = null;

export const loadAuthData = (path: string): AuthData | null => {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      cached = null;
      return null;
    }
    throw e;
  }
  if (cached?.mtimeMs === mtimeMs) return cached.data;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isAuthData(parsed)) throw new Error(`${path}의 형식이 올바르지 않습니다. set-password로 다시 만드세요.`);
  cached = { mtimeMs, data: parsed };
  return parsed;
};
