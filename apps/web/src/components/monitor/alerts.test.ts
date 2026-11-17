import { describe, expect, it } from 'vitest';
import type { MonitorAlert } from '../../types/explorer';
import { alertFocus, alertMessage, alertTarget } from './alerts';

const base: MonitorAlert = {
  id: 'x', kind: 'mass-delete', database: 'shop', collections: ['orders'], start: 0, end: 0,
  count: 1000, peak: 1000, usual: null, limit: 1000, ongoing: true, filled: false,
};

describe('alerts 문구·이동처', () => {
  it('종류마다 한 줄, 지워진 곳은 위로 좁힌다', () => {
    expect(alertMessage(base)).toBe('Mass delete on shop.orders — 1,000 documents deleted within a minute');
    expect(alertMessage({ ...base, kind: 'burst', count: 1200, usual: 4.5 })).toBe('Write burst on shop.orders — 1,200 writes within a minute (usually 4.5/min)');
    expect(alertMessage({ ...base, kind: 'drop', count: 3, collections: ['a', 'b', 'c'] })).toBe('3 collections dropped in shop');
    expect(alertMessage({ ...base, kind: 'drop-database', count: 1, collections: ['a'] })).toBe('Database dropped: shop (1 collection)');
    const rename = { ...base, kind: 'rename' as const, collections: ['old'], to: { database: 'shop', collection: 'new' } };
    expect(alertTarget(rename)).toBe('shop.old → new');
    expect(alertFocus(rename)).toEqual({ database: 'shop', collection: 'new' });
    expect(alertFocus({ ...base, kind: 'drop' })).toEqual({ database: 'shop', collection: null });
    expect(alertFocus({ ...base, kind: 'drop-database' })).toEqual({ database: null, collection: null });
  });
});
