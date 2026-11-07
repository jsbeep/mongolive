// MongoDB 연결. 연결된 클라이언트 하나를 서버 전체가 공유한다(드라이버가 내부에서 커넥션 풀을 관리).
import { MongoClient } from 'mongodb';
import { config } from './config';

let clientPromise: Promise<MongoClient> | null = null;

// 연결된 클라이언트를 돌려준다. 첫 연결이 실패한 클라이언트는 드라이버가 닫아 버려 재사용할 수 없으므로
// ('Topology is closed'), 실패하면 기억을 지우고 다음 호출 때 새 클라이언트로 다시 시도한다.
// (한 번 연결된 뒤 잠깐 끊기는 건 드라이버가 알아서 재연결한다)
export const getClient = (): Promise<MongoClient> => {
  if (!clientPromise) {
    const client = new MongoClient(config.mongoUri, {
      // 접속이 안 될 때 기본 30초를 기다리지 않고 빨리 실패하게
      serverSelectionTimeoutMS: 5000,
      appName: 'mongolive',
    });
    clientPromise = client.connect().catch((e: unknown) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
};

export const closeClient = async (): Promise<void> => {
  const pending = clientPromise;
  clientPromise = null;
  if (pending) await pending.then((c) => c.close()).catch(() => undefined);
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

export const checkMongo = async (): Promise<MongoStatus> => {
  try {
    const admin = (await getClient()).db('admin');
    const hello = await admin.command({ hello: 1 });
    const build = await admin.command({ buildInfo: 1 });
    return {
      ok: true,
      replicaSet: typeof hello.setName === 'string' ? hello.setName : null,
      sharded: hello.msg === 'isdbgrid',
      version: typeof build.version === 'string' ? build.version : null,
    };
  } catch (e) {
    return { ok: false, replicaSet: null, sharded: false, version: null, error: e instanceof Error ? e.message : String(e) };
  }
};
