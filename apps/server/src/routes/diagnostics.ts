// 설정 창의 진단
//   GET /api/diagnostics → Diagnostics
// 실시간이 안 될 때 가장 흔한 원인 두 가지를 바로 보여 준다:
//   1. standalone MongoDB — changeStream은 replica set(또는 sharded cluster)에서만 된다
//   2. 권한 — changeStream 권한, 지표용 serverStatus(clusterMonitor)
// 보안 설정(.env)은 '보여 주기만' 한다. 화면에서 바꿀 수 있으면 세션 하나만 탈취돼도 인증을 끌 수 있다.
import { readFileSync } from 'node:fs';
import { Router } from 'express';
import type { Diagnostics } from '@mongolive/shared';
import { config } from '../config';
import { checkMongo, getClient, topologyOf } from '../db';
import { realtimeMetrics } from '../realtime';

export const diagnosticsRouter = Router();

const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

// mongodb://user:pass@host/db?opts → mongodb://user:***@host/db (+ options)
// 비밀번호뿐 아니라 옵션도 뺀다 — authMechanismProperties 같은 곳에 비밀 값이 들어갈 수 있다
export const maskMongoUri = (uri: string): string => {
  const [base, query] = uri.split('?');
  const masked = base.replace(/^(mongodb(?:\+srv)?:\/\/[^:/@]+):[^@]*@/, '$1:***@');
  return query ? `${masked} (+ options)` : masked;
};

const serverStatusAccess = async (): Promise<Diagnostics['serverStatus']> => {
  try {
    // 권한만 보면 되므로 큰 섹션은 빼고 받는다
    await (await getClient()).db('admin').command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0, tcmalloc: 0 });
    return 'ok';
  } catch (e) {
    return (e as { codeName?: string }).codeName === 'Unauthorized' ? 'denied' : 'error';
  }
};

diagnosticsRouter.get('/diagnostics', async (_req, res) => {
  const [mongo, serverStatus] = await Promise.all([checkMongo(), serverStatusAccess()]);
  const result: Diagnostics = {
    server: { version: VERSION, node: process.version, uptimeSec: Math.round(process.uptime()) },
    mongo: {
      ok: mongo.ok,
      version: mongo.version,
      topology: topologyOf(mongo),
      replicaSet: mongo.replicaSet,
      error: mongo.error,
    },
    realtime: realtimeMetrics().status,
    serverStatus,
    security: {
      authMode: config.authMode,
      host: config.host,
      port: config.port,
      https: config.tls !== null,
      trustProxy: config.trustProxy,
      allowInsecureHttp: config.allowInsecureHttp,
      mongoUri: maskMongoUri(config.mongoUri),
      authFile: config.authFile,
      metaFile: config.metaFile,
    },
  };
  res.json(result);
});
