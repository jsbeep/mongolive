// MongoDB 연결 — 연결 id마다 클라이언트 하나(멀티톤). 같은 연결을 쓰는 탭·요청은 그 클라이언트를 같이 쓴다
// (드라이버가 클라이언트 안에서 커넥션 풀을 관리).
//
//   요청 ──X-Mongolive-Connection: <id>──▶ requireConnection ──▶ clientFor(id) ──▶ 그 연결의 MongoClient
//
// 처음 쓸 때 만들고(지연 초기화), 한동안 아무도 안 쓰면 닫는다(유휴 해제). 실시간 스트림처럼 계속 쓰는 쪽은
// retainClient로 붙잡아 두면 닫히지 않는다. 연결이 지워지거나 주소가 바뀌면 바로 닫는다.
import { MongoClient, type TopologyDescription } from 'mongodb';
import type { RequestHandler, Response } from 'express';
import type { ConnectionTestResult, MongoTopology } from '@mongolive/shared';
import { connectionUri, onConnectionsChange } from './connections';
import { HttpError } from './names';

export const CONNECTION_HEADER = 'X-Mongolive-Connection';

// 아무도 안 쓴 지 이만큼 지나면 닫는다
const IDLE_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

interface Entry {
  uri: string;
  // 연결된 클라이언트. 첫 연결이 실패하면 null로 돌려 다음 호출 때 새로 만든다
  promise: Promise<MongoClient> | null;
  lastUsed: number;
}

const entries = new Map<string, Entry>();
// 연결 id → retainClient로 붙잡은 수. 0보다 크면 유휴 해제하지 않는다.
// 클라이언트(entries)와 따로 센다 — 주소가 바뀌어 클라이언트를 새로 만들어도 붙잡은 수는 이어진다
const holders = new Map<string, number>();

const closeEntry = (entry: Entry) => {
  const pending = entry.promise;
  entry.promise = null;
  if (pending) void pending.then((c) => c.close()).catch(() => undefined);
};

const drop = (id: string) => {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  health.delete(id);
  closeEntry(entry);
};

// ── 연결 상태(하트비트) ──────────────────────────────────────────────────────
// 드라이버는 연결된 서버마다 주기적으로(기본 10초, 끊기면 즉시) hello를 보내 살아 있는지 확인하고,
// 그 결과로 '토폴로지(서버들의 모양)'가 바뀌면 topologyDescriptionChanged를 알린다(SDAM).
// changeStream 유무와 상관없이 오므로 단독(standalone) DB에서도 "닿는지"를 알 수 있다.

export interface ConnectionHealth {
  // 닿는 서버가 하나라도 있는지. null = 아직 모름(접속 전)
  reachable: boolean | null;
  // 마지막으로 알아낸 종류(닿지 않는 동안에도 기억)
  topology: MongoTopology;
}

const UNKNOWN_HEALTH: ConnectionHealth = { reachable: null, topology: 'unknown' };
const health = new Map<string, ConnectionHealth>();
const healthListeners = new Set<(id: string, health: ConnectionHealth) => void>();

const describeTopology = (description: TopologyDescription): ConnectionHealth => {
  const servers = [...description.servers.values()];
  // 닿음 = 종류를 알아낸 서버가 있다. 못 닿음 = 확인했는데 에러가 났다.
  // 막 만든 클라이언트의 첫 알림은 아직 확인 전이라 전부 Unknown(에러 없음) — 이걸 '못 닿음'으로 읽으면 연결할 때마다 Error가 잠깐 뜬다
  const reachable = servers.some((s) => s.type !== 'Unknown') ? true : servers.some((s) => s.error) ? false : null;
  let topology: MongoTopology = 'unknown';
  if (description.type === 'ReplicaSetWithPrimary' || description.type === 'ReplicaSetNoPrimary') topology = 'replicaSet';
  else if (description.type === 'Sharded') topology = 'sharded';
  else if (description.type === 'Single') {
    // 서버 하나에 바로 붙은 경우(directConnection 등) — 그 서버의 종류로
    const type = servers[0]?.type;
    if (type === 'Standalone') topology = 'standalone';
    else if (type === 'Mongos') topology = 'sharded';
    else if (type?.startsWith('RS')) topology = 'replicaSet';
  }
  return { reachable, topology };
};

const updateHealth = (id: string, next: ConnectionHealth) => {
  const prev = health.get(id) ?? UNKNOWN_HEALTH;
  const merged: ConnectionHealth = { reachable: next.reachable, topology: next.topology === 'unknown' ? prev.topology : next.topology };
  if (merged.reachable === prev.reachable && merged.topology === prev.topology) return;
  health.set(id, merged);
  healthListeners.forEach((listener) => listener(id, merged));
};

export const healthOf = (id: string): ConnectionHealth => health.get(id) ?? UNKNOWN_HEALTH;

export const onHealthChange = (listener: (id: string, health: ConnectionHealth) => void) => {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
};

// 연결된 클라이언트를 돌려준다. 첫 연결이 실패한 클라이언트는 드라이버가 닫아 버려 재사용할 수 없으므로
// ('Topology is closed'), 실패하면 기억을 지우고 다음 호출 때 새 클라이언트로 다시 시도한다.
// (한 번 연결된 뒤 잠깐 끊기는 건 드라이버가 알아서 재연결한다)
export const clientFor = (id: string): Promise<MongoClient> => {
  const uri = connectionUri(id);
  // 410: 지워진 연결. 404는 화면이 '문서가 지워졌다'로 읽으므로 쓰지 않는다
  if (!uri) return Promise.reject(new HttpError(410, 'This connection no longer exists — it may have been deleted.'));
  let entry = entries.get(id);
  // 주소가 바뀐 연결이면 옛 클라이언트를 닫고 새로
  if (entry && entry.uri !== uri) {
    drop(id);
    entry = undefined;
  }
  if (!entry) {
    entry = { uri, promise: null, lastUsed: Date.now() };
    entries.set(id, entry);
  }
  entry.lastUsed = Date.now();
  if (entry.promise) return entry.promise;
  const client = new MongoClient(uri, {
    // 접속이 안 될 때 기본 30초를 기다리지 않고 빨리 실패하게
    serverSelectionTimeoutMS: 5000,
    appName: 'mongolive',
  });
  const current = entry;
  // connect() 도중에도 이벤트가 올 수 있으므로 먼저 선언해 둔다
  let promise: Promise<MongoClient> | undefined;
  // 이 클라이언트가 아직 그 연결의 현재 클라이언트일 때만 상태를 반영한다(주소가 바뀌어 닫힌 옛 것은 무시)
  client.on('topologyDescriptionChanged', (event) => {
    if (entries.get(id) === current && (promise === undefined || current.promise === promise)) {
      updateHealth(id, describeTopology(event.newDescription));
    }
  });
  const connecting: Promise<MongoClient> = client.connect().catch((e: unknown) => {
    if (current.promise === connecting) current.promise = null;
    throw e;
  });
  promise = connecting;
  current.promise = connecting;
  return connecting;
};

// 계속 쓰는 쪽(실시간 스트림)이 붙잡는다. 돌려받은 함수를 부르면 놓는다
export const retainClient = (id: string): (() => void) => {
  holders.set(id, (holders.get(id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holders.get(id) ?? 1) - 1;
    if (left > 0) holders.set(id, left);
    else holders.delete(id);
    // 놓은 때부터 유휴 시간을 센다
    const entry = entries.get(id);
    if (entry) entry.lastUsed = Date.now();
  };
};

// 연결이 지워졌거나 주소가 바뀌었으면 바로 닫는다 — 옛 주소로 계속 읽고 쓰지 않게
onConnectionsChange(() => {
  for (const [id, entry] of entries) {
    if (connectionUri(id) !== entry.uri) drop(id);
  }
});

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (!holders.has(id) && now - entry.lastUsed > IDLE_MS) drop(id);
  }
}, SWEEP_MS);
// 이 타이머 때문에 프로세스가 안 끝나는 일이 없게
sweep.unref();

export const closeAllClients = async (): Promise<void> => {
  clearInterval(sweep);
  const pending = [...entries.values()].map((e) => e.promise);
  entries.clear();
  health.clear();
  await Promise.all(pending.map((p) => p?.then((c) => c.close()).catch(() => undefined)));
};

// ── 요청의 연결 ──────────────────────────────────────────────────────────────

// Mongo를 쓰는 API 앞에 선다. 요청 헤더의 연결 id를 확인해 res.locals에 둔다.
// 연결을 정하지 않은 요청은 받지 않는다 — '기본 연결'로 흘러가면 엉뚱한 클러스터에 쓸 수 있다
export const requireConnection: RequestHandler = (req, res, next) => {
  const id = req.get(CONNECTION_HEADER);
  if (!id) throw new HttpError(400, `No connection selected (missing ${CONNECTION_HEADER} header).`);
  if (!connectionUri(id)) throw new HttpError(410, 'This connection no longer exists — it may have been deleted.');
  res.locals.connectionId = id;
  next();
};

// 이 요청의 연결 id / 클라이언트 (requireConnection 뒤에서만)
export const connectionIdOf = (res: Response): string => {
  const id: unknown = res.locals.connectionId;
  if (typeof id !== 'string') throw new Error('requireConnection 뒤에서만 쓸 수 있습니다');
  return id;
};

export const clientOf = (res: Response): Promise<MongoClient> => clientFor(connectionIdOf(res));

// 쓰기 함수들에 넘기는 연결 묶음 — 클라이언트와 함께 id도(연결마다 따로 기억하는 것: 빈 DB, 앱 메타데이터)
export interface MongoConn {
  id: string;
  client: MongoClient;
}

export const connOf = async (res: Response): Promise<MongoConn> => {
  const id = connectionIdOf(res);
  return { id, client: await clientFor(id) };
};

export interface MongoStatus {
  ok: boolean;
  // changeStream은 replica set(또는 sharded cluster)에서만 동작한다 — 이름이 없으면 5단계가 불가능
  replicaSet: string | null;
  // mongos(sharded cluster)면 setName 없이도 changeStream이 된다
  sharded: boolean;
  version: string | null;
  error?: string;
}

// 연결된 클라이언트로 서버 종류·버전을 확인한다
const inspect = async (client: MongoClient): Promise<Omit<MongoStatus, 'ok' | 'error'>> => {
  const admin = client.db('admin');
  const hello = await admin.command({ hello: 1 });
  const build = await admin.command({ buildInfo: 1 });
  return {
    replicaSet: typeof hello.setName === 'string' ? hello.setName : null,
    sharded: hello.msg === 'isdbgrid',
    version: typeof build.version === 'string' ? build.version : null,
  };
};

export const checkMongo = async (id: string): Promise<MongoStatus> => {
  try {
    return { ok: true, ...(await inspect(await clientFor(id))) };
  } catch (e) {
    return { ok: false, replicaSet: null, sharded: false, version: null, error: e instanceof Error ? e.message : String(e) };
  }
};

export const topologyOf = (status: MongoStatus): MongoTopology =>
  !status.ok ? 'unknown' : status.sharded ? 'sharded' : status.replicaSet ? 'replicaSet' : 'standalone';

// 연결 테스트 — 잠깐 쓸 클라이언트를 만들어 접속해 보고 바로 닫는다(공유 클라이언트와 무관)
export const testMongoUri = async (uri: string): Promise<ConnectionTestResult> => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, appName: 'mongolive' });
  const started = Date.now();
  try {
    await client.connect();
    const info = await inspect(client);
    const status: MongoStatus = { ok: true, ...info };
    return { ok: true, topology: topologyOf(status), version: info.version, replicaSet: info.replicaSet, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, topology: 'unknown', version: null, replicaSet: null, latencyMs: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.close().catch(() => undefined);
  }
};
