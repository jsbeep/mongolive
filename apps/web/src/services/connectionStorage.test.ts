import { describe, expect, it } from 'vitest';
import { connectionIdOfKey, migrateLegacyKey, scopedKey, type KeyValueStorage } from './connectionStorage';

const memoryStorage = (initial: Record<string, string>): KeyValueStorage & { data: Map<string, string> } => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

describe('migrateLegacyKey', () => {
  it('moves the old unscoped value to the default connection', () => {
    const s = memoryStorage({ 'mongolive.bookmarks': '[1]' });
    migrateLegacyKey(s, 'mongolive.bookmarks', 'env');
    expect(Object.fromEntries(s.data)).toEqual({ 'mongolive.bookmarks@env': '[1]' });
  });

  it('keeps an existing scoped value and drops the old one', () => {
    const s = memoryStorage({ 'mongolive.bookmarks': '[old]', 'mongolive.bookmarks@env': '[new]' });
    migrateLegacyKey(s, 'mongolive.bookmarks', 'env');
    expect(Object.fromEntries(s.data)).toEqual({ 'mongolive.bookmarks@env': '[new]' });
  });

  it('does nothing without an old value', () => {
    const s = memoryStorage({ 'mongolive.bookmarks@abc': '[]' });
    migrateLegacyKey(s, 'mongolive.bookmarks', 'env');
    expect(Object.fromEntries(s.data)).toEqual({ 'mongolive.bookmarks@abc': '[]' });
  });
});

describe('connectionIdOfKey', () => {
  it('reads the connection id from a scoped key', () => {
    const id = '0b6f1c2e-6a53-4d4e-9d7c-2f1e0a9b8c7d';
    expect(connectionIdOfKey('mongolive.bookmarks', scopedKey('mongolive.bookmarks', id))).toBe(id);
    expect(connectionIdOfKey('mongolive.bookmarks', 'mongolive.bookmarks@env')).toBe('env');
  });

  it('rejects other keys', () => {
    expect(connectionIdOfKey('mongolive.bookmarks', 'mongolive.bookmarks')).toBeNull();
    expect(connectionIdOfKey('mongolive.bookmarks', 'mongolive.collectionQuery@env')).toBeNull();
    expect(connectionIdOfKey('mongolive.bookmarks', 'mongolive.bookmarks@a/b')).toBeNull();
  });
});
