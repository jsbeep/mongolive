// 활동 패널의 PerformanceMetrics
//   GET /api/metrics → ServerMetrics (실시간 통계 + MongoDB serverStatus 요약)
// 레거시는 임의로 늘어나는 가짜 숫자였다. 여기선 실제 값만 보낸다 — serverStatus 권한(clusterMonitor)이
// 없으면 mongo.error로 알리고 나머지(실시간 통계)는 그대로 보낸다.
import { Router } from 'express';
import type { ServerMetrics } from '@mongolive/shared';
import { clientOf } from '../db';
import type { MongoClient } from 'mongodb';
import { realtimeMetrics } from '../realtime';

export const metricsRouter = Router();

const OPS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const;

const num = (value: unknown): number | undefined => {
  if (typeof value === 'number') return value;
  // 드라이버가 큰 정수를 Long 객체로 줄 수 있다
  if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') return (value as { toNumber: () => number }).toNumber();
  return undefined;
};

const mongoStatus = async (client: Promise<MongoClient>): Promise<ServerMetrics['mongo']> => {
  try {
    const admin = (await client).db('admin');
    // 필요 없는 큰 섹션은 빼고 받는다
    const s = await admin.command({
      serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0, tcmalloc: 0, storageEngine: 0, transactions: 0, logicalSessionRecordCache: 0,
    });
    const opcounters: Record<string, number> = {};
    for (const op of OPS) {
      const v = num(s.opcounters?.[op]);
      if (v !== undefined) opcounters[op] = v;
    }
    const current = num(s.connections?.current);
    const available = num(s.connections?.available);
    const bytesIn = num(s.network?.bytesIn);
    const bytesOut = num(s.network?.bytesOut);
    return {
      version: typeof s.version === 'string' ? s.version : undefined,
      uptimeSec: num(s.uptime),
      connections: current !== undefined && available !== undefined ? { current, available } : undefined,
      memResidentMb: num(s.mem?.resident),
      opcounters,
      network: bytesIn !== undefined && bytesOut !== undefined ? { bytesIn, bytesOut } : undefined,
    };
  } catch (e) {
    const code = (e as { codeName?: string }).codeName;
    return { error: code === 'Unauthorized' ? 'No permission for serverStatus (needs clusterMonitor role)' : 'Could not read server status' };
  }
};

metricsRouter.get('/metrics', async (_req, res) => {
  const result: ServerMetrics = { at: Date.now(), realtime: realtimeMetrics(), mongo: await mongoStatus(clientOf(res)) };
  res.json(result);
});
