import { describe, expect, it } from 'vitest';
import type { BackfillGap, HistoryGap } from '../../types/explorer';
import { backfillProgress, fmtGapLength, gapBand, timeLeft } from './backfill';

const MIN = 60_000;
const T = new Date(2026, 10, 16, 12, 0).getTime();

const gap = (patch: Partial<BackfillGap> = {}): BackfillGap => ({
  id: `${T}-${T + 60 * MIN}`,
  from: T,
  to: T + 60 * MIN,
  status: 'loading',
  loadedTo: null,
  loaded: 0,
  estimate: null,
  ...patch,
});
const est = (total: number | null) => ({ resumable: true, events: total, total, source: 'counters' as const, bytes: null, deadline: null });

describe('backfillProgress', () => {
  it('전체 수를 알면 개수로(넘쳐도 1)', () => {
    expect(backfillProgress(gap({ loaded: 21_000, estimate: est(30_000) }))).toBeCloseTo(0.7);
    expect(backfillProgress(gap({ loaded: 410, estimate: est(400) }))).toBe(1);
  });
  it('모르면 불러온 시각으로, 부분이면 partialFrom부터', () => {
    expect(backfillProgress(gap({ loadedTo: T + 15 * MIN }))).toBeCloseTo(0.25);
    expect(backfillProgress(gap({ loadedTo: T + 40 * MIN, partialFrom: T + 20 * MIN }))).toBeCloseTo(0.5);
    expect(backfillProgress(gap())).toBe(0);
  });
});

describe('fmtGapLength / timeLeft', () => {
  it('1분 안은 초로', () => {
    expect(fmtGapLength(45_000)).toBe('45s');
    expect(fmtGapLength(158 * MIN)).toBe('2h 38m');
  });
  it('기한이 지났으면 null', () => {
    expect(timeLeft(T + 90 * MIN, T)).toBe('1h 30m');
    expect(timeLeft(T - 1, T)).toBeNull();
    expect(timeLeft(null, T)).toBeNull();
  });
});

describe('gapBand', () => {
  const band: HistoryGap = { from: T, to: T + 60 * MIN, restarted: false };
  it('불러온 구간 — 개수를 덧붙이고 옅게', () => {
    const r = gapBand(band, [{ from: T + 5_000, to: T + 60 * MIN - 5_000, events: 30_000 }], []);
    expect(r.filled).toBe(true);
    expect(r.label).toContain('30,000 writes loaded afterwards');
  });
  it('앞부분만 / 못 불러옴 / 아직', () => {
    expect(gapBand(band, [{ from: T, to: T + 60 * MIN, events: 5, partialFrom: T + 30 * MIN }], []).label).toContain('earlier ones were gone');
    const lost = gapBand(band, [{ from: T, to: T + 60 * MIN, events: 0, lost: true }], []);
    expect(lost.filled).toBe(false);
    expect(lost.label).toContain("couldn't be loaded");
    expect(gapBand(band, [], [gap({ status: 'pending' })]).label).toContain('not loaded yet');
    // 0건은 잃은 게 아니라 쓰기가 없었던 것
    expect(gapBand(band, [{ from: T, to: T + 60 * MIN, events: 0 }], [])).toEqual({ label: expect.stringContaining('no writes') as string, filled: true });
  });
  it('겹치지 않는 결과는 무시', () => {
    const r = gapBand(band, [{ from: T + 2 * 60 * MIN, to: T + 3 * 60 * MIN, events: 9 }], []);
    expect(r.filled).toBe(false);
    expect(r.label).not.toContain('loaded');
  });
});
