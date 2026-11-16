import { describe, expect, it } from 'vitest';
import { Timestamp } from 'mongodb';
import { compareTs, resumePointOf, tokenTs, tsOf } from './backfill';

describe('resume token', () => {
  it('_data 앞부분에서 클러스터 시각(초·증가값)을 읽는다', () => {
    // 0x6731a2b0 = 1731306160초, 증가값 7
    expect(tokenTs({ _data: '826731A2B0000000072B022C0100296E5A1004' })).toEqual({ t: 1731306160, i: 7 });
    expect(tokenTs({ _data: 'zz' })).toBeNull();
    expect(tokenTs(null)).toBeNull();
  });

  it('Timestamp ↔ {t, i}, 비교', () => {
    expect(tsOf(new Timestamp({ t: 1731306160, i: 3 }))).toEqual({ t: 1731306160, i: 3 });
    expect(compareTs({ t: 5, i: 2 }, { t: 5, i: 1 })).toBeGreaterThan(0);
    expect(compareTs({ t: 4, i: 9 }, { t: 5, i: 0 })).toBeLessThan(0);
  });

  it('문자열 _data가 아닌 token은 저장하지 않는다', () => {
    expect(resumePointOf({ _data: '826731A2B000000007' }, null, 1)).toEqual({ token: { _data: '826731A2B000000007' }, ts: { t: 1731306160, i: 7 }, at: 1 });
    expect(resumePointOf({ foo: 1 }, { t: 1, i: 0 }, 1)).toBeNull();
  });
});
