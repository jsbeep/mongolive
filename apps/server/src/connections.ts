// 연결 목록 저장소 — ~/.mongolive/connections.json (권한 600: 접속 주소에 비밀번호가 들어 있다)
// MongoDB에는 저장하지 않는다(흔적 없음 원칙). 브라우저에는 비밀 값을 가린 주소만 보낸다(connectionUri.ts).
//
// .env의 MONGODB_URI는 이 파일에 복사하지 않고 id 'env'인 읽기 전용 연결로 보여 준다
// — 비밀번호가 두 곳에 생기지 않게. 이름·색·즐겨찾기만 이 파일의 env 칸에 둔다.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CONNECTION_COLORS,
  ENV_CONNECTION_ID,
  type ConnectionColor,
  type ConnectionInfo,
  type ConnectionInput,
} from '@mongolive/shared';
import { config } from './config';
import { checkUri, describeUri, maskUri, restoreUri } from './connectionUri';
import { HttpError } from './names';

interface Appearance {
  name: string | null;
  color: ConnectionColor | null;
  favorite: boolean;
}

interface StoredConnection extends Appearance {
  id: string;
  uri: string;
  createdAt: number;
  updatedAt: number;
}

interface ConnectionsFile {
  version: 1;
  connections: StoredConnection[];
  // .env 연결의 겉모양
  env: Appearance;
}

const MAX_CONNECTIONS = 100;
const MAX_NAME_LENGTH = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const emptyAppearance = (): Appearance => ({ name: null, color: null, favorite: false });

let current: ConnectionsFile = { version: 1, connections: [], env: emptyAppearance() };
const listeners = new Set<(list: ConnectionInfo[]) => void>();
// 저장 요청을 한 줄로 세운다(동시에 두 번 쓰면 나중 것이 앞의 변경을 덮어쓸 수 있다)
let writeQueue: Promise<void> = Promise.resolve();

// ── 값 검사 ──────────────────────────────────────────────────────────────────

const isColor = (v: unknown): v is ConnectionColor => (CONNECTION_COLORS as readonly unknown[]).includes(v);

const parseName = (v: unknown): string | null => {
  if (v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, '이름은 문자열이어야 합니다.');
  const name = v.trim();
  if (name.length > MAX_NAME_LENGTH) throw new HttpError(400, `이름이 너무 깁니다(최대 ${MAX_NAME_LENGTH}자).`);
  return name || null;
};

const parseColor = (v: unknown): ConnectionColor | null => {
  if (v === null) return null;
  if (!isColor(v)) throw new HttpError(400, `색은 ${CONNECTION_COLORS.join(', ')} 중 하나여야 합니다.`);
  return v;
};

const parseFavorite = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new HttpError(400, 'favorite는 true/false여야 합니다.');
  return v;
};

// 보낸 항목만 바꾼다(모르는 항목은 무시)
const applyAppearance = (base: Appearance, body: ConnectionInput): Appearance => ({
  name: 'name' in body ? parseName(body.name) : base.name,
  color: 'color' in body ? parseColor(body.color) : base.color,
  favorite: 'favorite' in body ? parseFavorite(body.favorite) : base.favorite,
});

const asInput = (body: unknown): ConnectionInput => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '요청 본문이 올바르지 않습니다.');
  return body as ConnectionInput;
};

// ── 파일 ─────────────────────────────────────────────────────────────────────

const isStored = (v: unknown): v is StoredConnection => {
  const c = v as StoredConnection;
  return (
    !!c &&
    typeof c.id === 'string' &&
    UUID.test(c.id) &&
    typeof c.uri === 'string' &&
    (c.name === null || typeof c.name === 'string') &&
    (c.color === null || isColor(c.color)) &&
    typeof c.favorite === 'boolean' &&
    typeof c.createdAt === 'number' &&
    typeof c.updatedAt === 'number'
  );
};

// 서버가 켜질 때 한 번. 파일이 없으면 빈 목록. 깨진 파일은 덮어쓰지 않도록 에러로 멈춘다(접속 주소를 잃지 않게)
export const loadConnections = async (): Promise<void> => {
  let raw: string;
  try {
    raw = await readFile(config.connectionsFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`${config.connectionsFile}을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = JSON.parse(raw) as Partial<ConnectionsFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.connections) || !parsed.connections.every(isStored)) {
    throw new Error(`${config.connectionsFile}의 형식이 올바르지 않습니다. 파일을 고치거나 다른 곳으로 옮긴 뒤 다시 켜세요.`);
  }
  const env = parsed.env;
  current = {
    version: 1,
    connections: parsed.connections,
    env: {
      name: typeof env?.name === 'string' ? env.name : null,
      color: isColor(env?.color) ? env.color : null,
      favorite: env?.favorite === true,
    },
  };
};

// 임시 파일(처음부터 600)에 다 쓴 뒤 이름을 바꿔 교체 — 쓰는 도중 꺼져도 원래 파일은 온전하다
const write = async (next: ConnectionsFile): Promise<void> => {
  await mkdir(dirname(config.connectionsFile), { recursive: true, mode: 0o700 });
  const tmp = `${config.connectionsFile}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(tmp, 0o600); // 같은 이름의 임시 파일이 남아 있었으면 mode가 적용되지 않으므로 한 번 더
  await rename(tmp, config.connectionsFile);
};

// 바꾸기는 한 줄로 세워 차례로 한다 — 이전 상태를 읽고 계산하는 것까지 줄 안에서 해야
// 동시에 온 두 요청이 같은 이전 상태를 보고 서로의 변경을 덮어쓰지 않는다
const mutate = async <T>(change: (prev: ConnectionsFile) => { next: ConnectionsFile; result: T }): Promise<T> => {
  const run = writeQueue.then(async () => {
    const { next, result } = change(current);
    await write(next);
    current = next;
    return result;
  });
  // 실패해도(검사 오류·쓰기 오류) 다음 요청은 이어 갈 수 있게 줄은 살려 둔다
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  const result = await run;
  const list = listConnections();
  listeners.forEach((listener) => listener(list));
  return result;
};

// ── 밖에서 쓰는 것 ───────────────────────────────────────────────────────────

const toInfo = (id: string, source: ConnectionInfo['source'], uri: string, look: Appearance, times?: { createdAt: number; updatedAt: number }): ConnectionInfo => ({
  id,
  source,
  ...look,
  uri: maskUri(uri),
  ...describeUri(uri),
  createdAt: times?.createdAt ?? null,
  updatedAt: times?.updatedAt ?? null,
});

// .env 연결이 먼저, 그다음 만든 순서
export const listConnections = (): ConnectionInfo[] => [
  ...(config.mongoUri ? [toInfo(ENV_CONNECTION_ID, 'env', config.mongoUri, current.env)] : []),
  ...current.connections.map((c) => toInfo(c.id, 'saved', c.uri, c, c)),
];

// 실제 접속 주소(비밀 값 포함) — 서버 안에서만 쓴다. 없으면 null
export const connectionUri = (id: string): string | null => {
  if (id === ENV_CONNECTION_ID) return config.mongoUri || null;
  return current.connections.find((c) => c.id === id)?.uri ?? null;
};

const findSaved = (file: ConnectionsFile, id: string): StoredConnection => {
  const found = UUID.test(id) ? file.connections.find((c) => c.id === id) : undefined;
  if (!found) throw new HttpError(404, '연결을 찾을 수 없습니다.');
  return found;
};

const infoOf = (id: string): ConnectionInfo => {
  const info = listConnections().find((c) => c.id === id);
  if (!info) throw new HttpError(404, '연결을 찾을 수 없습니다.');
  return info;
};

const parseUri = (input: ConnectionInput): string | undefined => {
  if (input.uri === undefined) return undefined;
  if (typeof input.uri !== 'string') throw new HttpError(400, '접속 주소는 문자열이어야 합니다.');
  return input.uri;
};

export const createConnection = async (body: unknown): Promise<ConnectionInfo> => {
  const input = asInput(body);
  const submitted = parseUri(input);
  if (submitted === undefined) throw new HttpError(400, '접속 주소를 입력하세요.');
  // 새 연결에는 채울 원래 값이 없으므로 가린 표시가 있으면 거절된다
  const uri = checkUri(restoreUri(submitted, null));
  const look = applyAppearance(emptyAppearance(), input);
  const id = await mutate((prev) => {
    if (prev.connections.length >= MAX_CONNECTIONS) throw new HttpError(400, `연결은 ${MAX_CONNECTIONS}개까지 저장할 수 있습니다.`);
    const now = Date.now();
    // id는 랜덤 — 지운 연결의 id가 다시 쓰여 옛 북마크가 다른 클러스터를 가리키는 일이 없게
    const created: StoredConnection = { id: randomUUID(), uri, ...look, createdAt: now, updatedAt: now };
    return { next: { ...prev, connections: [...prev.connections, created] }, result: created.id };
  });
  return infoOf(id);
};

export const updateConnection = async (id: string, body: unknown): Promise<ConnectionInfo> => {
  const input = asInput(body);
  const submitted = parseUri(input);
  if (id === ENV_CONNECTION_ID) {
    if (!config.mongoUri) throw new HttpError(404, '연결을 찾을 수 없습니다.');
    if (submitted !== undefined) throw new HttpError(400, '.env 연결의 주소는 apps/server/.env의 MONGODB_URI에서만 바꿀 수 있습니다.');
    await mutate((prev) => ({ next: { ...prev, env: applyAppearance(prev.env, input) }, result: undefined }));
    return infoOf(id);
  }
  await mutate((prev) => {
    const old = findSaved(prev, id);
    const uri = submitted === undefined ? old.uri : checkUri(restoreUri(submitted, old.uri));
    const next: StoredConnection = { ...old, ...applyAppearance(old, input), uri, updatedAt: Date.now() };
    return { next: { ...prev, connections: prev.connections.map((c) => (c.id === id ? next : c)) }, result: undefined };
  });
  return infoOf(id);
};

export const deleteConnection = async (id: string): Promise<void> => {
  if (id === ENV_CONNECTION_ID) throw new HttpError(400, '.env 연결은 지울 수 없습니다. apps/server/.env의 MONGODB_URI를 비우세요.');
  await mutate((prev) => {
    findSaved(prev, id);
    return { next: { ...prev, connections: prev.connections.filter((c) => c.id !== id) }, result: undefined };
  });
};

// 테스트할 실제 주소. id가 있으면 그 연결의 저장된 값으로 가린 자리를 채운다(보낼 곳이 같을 때만)
export const resolveTestUri = (body: unknown): string => {
  const { id, uri } = asInput(body) as { id?: unknown; uri?: unknown };
  if (id !== undefined && typeof id !== 'string') throw new HttpError(400, 'id는 문자열이어야 합니다.');
  if (uri !== undefined && typeof uri !== 'string') throw new HttpError(400, '접속 주소는 문자열이어야 합니다.');
  const stored = id === undefined ? null : connectionUri(id);
  if (id !== undefined && stored === null) throw new HttpError(404, '연결을 찾을 수 없습니다.');
  if (uri === undefined) {
    if (stored === null) throw new HttpError(400, '테스트할 접속 주소나 연결 id를 보내세요.');
    return stored;
  }
  return checkUri(restoreUri(uri, stored));
};

export const onConnectionsChange = (listener: (list: ConnectionInfo[]) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
