import { describe, expect, it } from 'vitest';
import { normalizeMetaFile } from './meta';

describe('normalizeMetaFile', () => {
  it('moves a v1 file to the .env connection', () => {
    const { data, migrated } = normalizeMetaFile({
      version: 1,
      collections: { 'shop.users': { titleKey: 'name' } },
      ownedOids: ['a'.repeat(24), 3],
    });
    expect(migrated).toBe(true);
    expect(data).toEqual({ version: 2, connections: { env: { collections: { 'shop.users': { titleKey: 'name' } }, ownedOids: ['a'.repeat(24)] } } });
  });

  it('keeps an empty v1 file empty', () => {
    expect(normalizeMetaFile({ version: 1, collections: {}, ownedOids: [] })).toEqual({ data: { version: 2, connections: {} }, migrated: false });
  });

  it('reads v2 as is and drops broken entries', () => {
    const { data, migrated } = normalizeMetaFile({
      version: 2,
      connections: { env: { collections: { 'a.b': { primaryKey: 'code' } }, ownedOids: [] }, broken: 'x', other: { ownedOids: 'nope' } },
    });
    expect(migrated).toBe(false);
    expect(data.connections).toEqual({
      env: { collections: { 'a.b': { primaryKey: 'code' } }, ownedOids: [] },
      other: { collections: {}, ownedOids: [] },
    });
  });
});
