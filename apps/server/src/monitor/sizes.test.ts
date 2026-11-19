import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecorder, readDayFiles, readJsonl } from './history';
import { sizeChanges, summarizeSizes, type SizesLine, type SizeTuple } from './sizes';

const HOUR = 3_600_000;
const T0 = new Date(2026, 10, 16, 10, 0, 0).getTime();
const all = { database: null, collection: null };

describe('sizeChanges', () => {
  it('바뀐 것·새것·없어진 것만', () => {
    const before = new Map<string, SizeTuple>([['a.x', [1, 10, 4096, 4096]], ['a.y', [2, 20, 4096, 4096]], ['b.z', [3, 30, 4096, 4096]]]);
    const after = new Map<string, SizeTuple>([['a.x', [1, 10, 4096, 4096]], ['a.y', [5, 50, 8192, 4096]], ['b.w', [1, 1, 4096, 4096]]]);
    expect(sizeChanges(before, after)).toEqual({ 'a.y': [5, 50, 8192, 4096], 'b.w': [1, 1, 4096, 4096], 'b.z': null });
  });
});

describe('summarizeSizes', () => {
  const lines: SizesLine[] = [
    { t: T0, full: true, c: { 'a.x': [10, 1000, 4096, 4096], 'a.y': [1, 100, 4096, 4096], 'b.z': [5, 500, 4096, 4096] } },
    { t: T0 + HOUR, c: { 'a.x': [20, 2000, 8192, 4096] } },
    { t: T0 + 2 * HOUR, c: { 'a.y': null, 'a.new': [1, 10, 4096, 4096] } },
  ];

  it('기간 첫 측정이 기준, 추이는 범위 합계', () => {
    const r = summarizeSizes(lines, { from: T0 + 30 * 60_000, scope: { database: 'a', collection: null }, latest: null, history: true });
    expect(r.at).toBe(T0 + 2 * HOUR);
    expect(r.baseAt).toBe(T0 + HOUR);
    expect(r.trend.map((p) => p.size)).toEqual([2100, 2010]);
    const x = r.rows.find((row) => row.collection === 'x');
    expect(x).toMatchObject({ database: 'a', size: 2000, base: { size: 2000 } });
    // 기준 때 없던 컬렉션
    expect(r.rows.find((row) => row.collection === 'new')?.base).toBeNull();
    expect(r.rows.some((row) => row.collection === 'y')).toBe(false);
    expect(r.total.size).toBe(2010);
    expect(r.baseTotal?.size).toBe(2100);
  });

  it('메모리의 마지막 측정이 있으면 그것이 지금 값', () => {
    const latest = { at: T0 + 3 * HOUR, map: new Map<string, SizeTuple>([['b.z', [9, 900, 4096, 4096]]]) };
    const r = summarizeSizes(lines, { from: null, scope: { database: 'b', collection: 'z' }, latest, history: true });
    expect(r.at).toBe(T0 + 3 * HOUR);
    expect(r.rows).toEqual([{ database: 'b', collection: 'z', count: 9, size: 900, storage: 4096, index: 4096, base: { count: 5, size: 500, storage: 4096, index: 4096 } }]);
  });

  it('날짜로 찾기 — to 시점의 값, to 뒤의 줄·메모리 측정은 안 쓴다', () => {
    const latest = { at: T0 + 3 * HOUR, map: new Map<string, SizeTuple>([['a.x', [99, 9900, 4096, 4096]]]) };
    const r = summarizeSizes(lines, { from: T0 - HOUR, to: T0 + HOUR + 60_000, scope: { database: 'a', collection: null }, latest, history: true });
    expect(r.at).toBe(T0 + HOUR);
    expect(r.trend.map((p) => p.size)).toEqual([1100, 2100]);
    expect(r.rows.map((row) => [row.collection, row.size, row.base?.size])).toEqual([['x', 2000, 1000], ['y', 100, 100]]);
  });

  it('기록 없이(실시간 기간) — 기준·추이 없음', () => {
    const r = summarizeSizes([], { from: null, scope: all, latest: { at: T0, map: new Map([['a.x', [1, 1, 1, 1]]]) }, history: false });
    expect(r).toMatchObject({ baseAt: null, baseTotal: null, trend: [] });
    expect(r.rows[0].base).toBeNull();
  });
});

describe('recorder.appendSizes', () => {
  let root: string;
  let now = T0;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ml-sizes-'));
    process.env.METRICS_DIR = root;
    now = T0;
  });
  afterEach(async () => {
    delete process.env.METRICS_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it('새 파일이면 전부, 아니면 바뀐 것만 — 날짜가 바뀌면 다시 전부', async () => {
    const r = createRecorder({
      connectionId: 'conn1',
      fingerprint: async () => 'fp',
      minuteWrites: () => undefined,
      retention: () => '90d',
      alive: () => true,
      intervalSec: 10,
      clock: () => now,
    });
    const full = { 'a.x': [1, 10, 4096, 4096] as SizeTuple };
    await r.appendSizes(T0, full, {});
    await r.appendSizes(T0 + HOUR, { 'a.x': [2, 20, 4096, 4096] }, { 'a.x': [2, 20, 4096, 4096] });
    const nextDay = new Date(2026, 10, 17, 0, 30).getTime();
    await r.appendSizes(nextDay, { 'a.x': [3, 30, 4096, 4096] }, { 'a.x': [3, 30, 4096, 4096] });
    const dir = join(root, 'conn1', 'fp');
    const day1 = await readJsonl<SizesLine>(join(dir, 'sizes-2026-11-16.jsonl'));
    expect(day1).toEqual([{ t: T0, full: true, c: full }, { t: T0 + HOUR, c: { 'a.x': [2, 20, 4096, 4096] } }]);
    const both = await readDayFiles<SizesLine>(dir, 'sizes', T0);
    expect(both).toHaveLength(3);
    expect(both[2]).toMatchObject({ full: true });
  });
});
