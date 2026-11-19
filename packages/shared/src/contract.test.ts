import { describe, expect, it } from 'vitest';
import { checkWindow, isLiveRange, isWindow } from './contract';

describe('날짜로 찾기(C2) 구간', () => {
  const now = 1_800_000_000_000;
  const MIN = 60_000;
  it('to는 지금까지로 줄이고, 10분 이상이어야 한다', () => {
    expect(checkWindow(now - 60 * MIN, now + 60 * MIN, now)).toEqual({ from: now - 60 * MIN, to: now });
    expect(checkWindow(now - 10 * MIN, now, now)).toEqual({ from: now - 10 * MIN, to: now });
    expect(typeof checkWindow(now - 9 * MIN, now, now)).toBe('string');
    // 미래 구간 — 줄이면 거꾸로
    expect(typeof checkWindow(now + MIN, now + 60 * MIN, now)).toBe('string');
    expect(typeof checkWindow(Number('x'), now, now)).toBe('string');
    expect(typeof checkWindow(now - 60 * MIN, now - 70 * MIN, now)).toBe('string');
  });
  it('구간은 실시간 기간이 아니다', () => {
    expect(isLiveRange({ from: 0, to: 1 })).toBe(false);
    expect(isLiveRange('30m')).toBe(true);
    expect(isWindow({ from: 0, to: 1 })).toBe(true);
    expect(isWindow('7d')).toBe(false);
  });
});
