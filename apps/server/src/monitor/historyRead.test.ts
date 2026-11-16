import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHistory } from './historyRead';
import { dateKey, monthKey, yearKey, type Rollup } from './rollup';

const MIN = 60_000;
const HOUR = 60 * MIN;
// 이 컴퓨터 시간대의 2026-11-16 12:00
const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime();

// conns 평균이 value인 기록(10초 칸 n개)
const rec = (t: number, value: number, n = 6, w?: Rollup['w']): Rollup => ({ t, n, s: { conns: value * n }, c: { conns: n }, x: { conns: value }, ...(w ? { w } : {}) });

describe('readHistory', () => {
  let root: string;
  let dir: string;
  const write = async (name: string, records: unknown[]) => {
    await writeFile(join(dir, name), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ml-history-'));
    process.env.METRICS_DIR = root;
    dir = join(root, 'c1', 'rs-x');
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    delete process.env.METRICS_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it('24h = 분 기록을 5분 칸으로(평균은 칸 수로 가중), 24시간 전은 뺀다', async () => {
    await write(`minutes-${dateKey(NOW)}.jsonl`, [rec(NOW - 30 * MIN, 2), rec(NOW - 29 * MIN, 4), rec(NOW - 25 * MIN, 10)]);
    await write(`minutes-${dateKey(NOW - 26 * HOUR)}.jsonl`, [rec(NOW - 26 * HOUR, 99)]);
    const r = await readHistory('c1', 'rs-x', { range: '24h' }, NOW);
    expect(r.bucketMs).toBe(5 * MIN);
    expect(r.points.map((p) => [p.t, p.avg.conns, p.max.conns])).toEqual([
      [NOW - 30 * MIN, 3, 4],
      [NOW - 25 * MIN, 10, 10],
    ]);
  });

  it('7d = 시 기록 + 아직 합치지 않은 지금 시간(분 기록)', async () => {
    await write(`hours-${monthKey(NOW)}.jsonl`, [rec(NOW - 2 * HOUR, 5, 360), rec(NOW - HOUR, 7, 360)]);
    // 11:00대는 이미 시 기록이 있으니 분 기록에서 빼고, 12:00대(지금)만
    await write(`minutes-${dateKey(NOW)}.jsonl`, [rec(NOW - HOUR + MIN, 50), rec(NOW, 9)]);
    const r = await readHistory('c1', 'rs-x', { range: '7d' }, NOW);
    expect(r.points.map((p) => [p.t, p.avg.conns])).toEqual([
      [NOW - 2 * HOUR, 5],
      [NOW - HOUR, 7],
      [NOW, 9],
    ]);
  });

  it('30d = 2시간 칸(자정 기준)', async () => {
    const at = (h: number) => new Date(2026, 10, 15, h).getTime();
    await write(`hours-${monthKey(NOW)}.jsonl`, [rec(at(8), 1, 360), rec(at(9), 3, 360), rec(at(10), 5, 360)]);
    const r = await readHistory('c1', 'rs-x', { range: '30d' }, NOW);
    expect(r.points.map((p) => [p.t, p.avg.conns, p.n])).toEqual([
      [at(8), 2, 720],
      [at(10), 5, 360],
    ]);
  });

  it('all = 일 기록 + 아직 합치지 않은 오늘(시·분)', async () => {
    const day = (d: number) => new Date(2026, 10, d).getTime();
    await write(`days-${yearKey(NOW)}.jsonl`, [rec(day(14), 1, 8640), rec(day(15), 2, 8640)]);
    await write(`hours-${monthKey(NOW)}.jsonl`, [rec(day(15) + HOUR, 77, 360), rec(day(16), 4, 360)]);
    await write(`minutes-${dateKey(NOW)}.jsonl`, [rec(day(16) + 5 * MIN, 99), rec(day(16) + HOUR, 4)]);
    const r = await readHistory('c1', 'rs-x', { range: 'all' }, NOW);
    expect(r.from).toBe(day(14));
    expect(r.points.map((p) => [p.t, p.avg.conns])).toEqual([
      [day(14), 1],
      [day(15), 2],
      [day(16), 4], // 15일 시 기록·16일 00시대 분 기록은 이미 위 단계에 들어 있어 빠진다
    ]);
  });

  it('빈 구간은 기간에 걸친 것만, 컬렉션별 쓰기는 범위로 거르고 칸별 추세', async () => {
    const ops = (n: number) => ({ insert: n, update: 0, replace: 0, delete: 0 });
    await write(`minutes-${dateKey(NOW)}.jsonl`, [
      rec(NOW - 30 * MIN, 1, 6, { 'shop.orders': ops(3), 'blog.posts': ops(1) }),
      rec(NOW - 10 * MIN, 1, 6, { 'shop.orders': ops(2) }),
    ]);
    await write('gaps.jsonl', [{ from: NOW - 3 * 24 * HOUR, to: NOW - 2 * 24 * HOUR, restarted: true }, { from: NOW - 20 * MIN, to: NOW - 15 * MIN, restarted: false }]);
    const r = await readHistory('c1', 'rs-x', { range: '24h', writes: true, database: 'shop' }, NOW);
    expect(r.gaps).toHaveLength(1);
    expect(r.collections).toEqual([{ database: 'shop', collection: 'orders', total: 5, ops: ops(5), trend: [3, 2] }]);
  });
});
