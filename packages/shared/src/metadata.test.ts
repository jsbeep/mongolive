import { describe, expect, it } from 'vitest';
import { normalizeCollectionMetadata, splitCollectionKey } from './metadata';

describe('splitCollectionKey', () => {
  it('첫 점에서 자른다 — 컬렉션 이름의 점은 그대로', () => {
    expect(splitCollectionKey('shop.users')).toEqual(['shop', 'users']);
    expect(splitCollectionKey('shop.system.profile')).toEqual(['shop', 'system.profile']);
  });
  it('DB나 컬렉션 이름이 비면 null', () => {
    expect(splitCollectionKey('users')).toBeNull();
    expect(splitCollectionKey('.users')).toBeNull();
    expect(splitCollectionKey('shop.')).toBeNull();
  });
});

describe('normalizeCollectionMetadata', () => {
  it('올바른 항목만 남기고 빈 값은 지운다', () => {
    const out = normalizeCollectionMetadata({
      'shop.users': { titleKey: ' name ', primaryKey: 'id', extra: 1 },
      'shop.orders': { referenceFields: { buyer: { targetCollection: 'users', targetKey: 'id' }, bad: { targetCollection: 'users' } } },
      'shop.empty': { titleKey: '', referenceFields: {} },
      noDot: { titleKey: 'x' },
      'shop.notObject': 'x',
    });
    expect(out).toEqual({
      'shop.users': { titleKey: 'name', primaryKey: 'id' },
      'shop.orders': { referenceFields: { buyer: { targetCollection: 'users', targetKey: 'id' } } },
    });
  });
  it('객체가 아니면 빈 결과', () => {
    expect(normalizeCollectionMetadata(null)).toEqual({});
    expect(normalizeCollectionMetadata([1, 2])).toEqual({});
  });
});
