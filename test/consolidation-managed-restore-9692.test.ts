import { describe, expect, test } from 'bun:test';
import { consolidationAdapter, consolidationOwnerKey, CONSOLIDATION_KIND } from '../src/core/generations/adapters/fact-rows.ts';

describe('consolidation generation restore on a managed brain (#9692)', () => {
  const key = { kind: CONSOLIDATION_KIND, sourceId: 'default', ownerKey: consolidationOwnerKey('people/ada', [3, 1, 2]) };

  test('the adapter takes the managed database-only restore path', () => {
    expect(consolidationAdapter.databaseOnly).toBe(true);
  });

  test('lockKeys names the cluster entity page so the managed restore can journal on it', () => {
    let keys: Array<{ sourceId: string; slug: string }> = [];
    let error: unknown = null;
    try { keys = consolidationAdapter.lockKeys(key, []); } catch (e) { error = e; }
    expect(error).toBeNull();
    expect(keys).toEqual([{ sourceId: 'default', slug: 'people/ada' }]);
  });
});
