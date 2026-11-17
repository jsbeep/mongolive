import { describe, expect, it } from 'vitest';
import { fmtBytes, fmtBytesDelta, fmtDuration, fmtSpan, timeTicks } from './format';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 이 컴퓨터 시간대의 2026-11-16 12:34
const NOW = new Date(2026, 10, 16, 12, 34).getTime();

describe('fmtBytes', () => {
  it('단위를 올리고 소수는 짧게', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(fmtBytesDelta(-2048)).toBe('-2 KB');
    expect(fmtBytesDelta(4096)).toBe('+4 KB');
  });
});

describe('timeTicks', () => {
  it('1시간 창 = 15분 간격, 시각 글자', () => {
    const ticks = timeTicks(NOW - HOUR, NOW);
    expect(ticks.map((t) => t.label)).toEqual(['11:45', '12:00', '12:15', '12:30']);
  });
  it('24시간 창 = 3시간 간격(0·3·6…시), 자정은 날짜로', () => {
    const ticks = timeTicks(NOW - DAY, NOW);
    expect(ticks[0].label).toBe('15:00');
    expect(ticks.map((t) => new Date(t.t).getHours() % 3)).toEqual(ticks.map(() => 0));
    expect(ticks.some((t) => t.label === '11/16')).toBe(true);
  });
  it('7일 창 = 매일 자정, 날짜 글자', () => {
    const ticks = timeTicks(NOW - 7 * DAY, NOW);
    expect(ticks.map((t) => t.label)).toEqual(['11/10', '11/11', '11/12', '11/13', '11/14', '11/15', '11/16']);
  });
  it("90일 창 = 15일 간격으로 8개 이하", () => {
    const ticks = timeTicks(NOW - 90 * DAY, NOW);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
  });
});

describe('fmtSpan · fmtDuration', () => {
  it('칸 길이·걸린 시간', () => {
    expect([fmtSpan(5 * MIN), fmtSpan(HOUR), fmtSpan(6 * HOUR), fmtSpan(DAY)]).toEqual(['5 min', '1 hour', '6 hours', '1 day']);
    expect([fmtDuration(20 * MIN), fmtDuration(3 * HOUR + 20 * MIN), fmtDuration(50 * HOUR)]).toEqual(['20m', '3h 20m', '2d 2h']);
  });
});
