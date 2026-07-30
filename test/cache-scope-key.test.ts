/**
 * Query-cache scope key (federation hardening).
 *
 * A federated search reads a different graph than a single-source one, so
 * the semantic cache must key them apart. `cacheScopeKey` produces an
 * order-independent key for federated scopes and leaves single-source
 * brains on their existing key (scalar id or 'default'), so single-source
 * cache hit-rate is unchanged.
 */

import { describe, test, expect } from 'bun:test';
import { cacheScopeKey } from '../src/core/search/hybrid.ts';

describe('cacheScopeKey', () => {
  test('unscoped → canonical default scope', () => {
    expect(cacheScopeKey(undefined)).toBe('scope:v1:{"kind":"default"}');
    expect(cacheScopeKey({})).toBe('scope:v1:{"kind":"default"}');
    expect(cacheScopeKey({ sourceIds: [] })).toBe('scope:v1:{"kind":"default"}');
  });

  test('scalar sourceId → typed canonical scalar scope', () => {
    expect(cacheScopeKey({ sourceId: 'host' }))
      .toBe('scope:v1:{"kind":"single","sourceId":"host"}');
  });

  test('federated sourceIds → order-independent set key', () => {
    const k1 = cacheScopeKey({ sourceIds: ['team-b', 'team-a', 'host'] });
    const k2 = cacheScopeKey({ sourceIds: ['host', 'team-a', 'team-b'] });
    expect(k1).toBe(k2); // order does not matter
    expect(k1).toBe(
      'scope:v1:{"kind":"set","sourceIds":["host","team-a","team-b"]}',
    );
  });

  test('different source-sets do NOT share a key', () => {
    const a = cacheScopeKey({ sourceIds: ['host', 'team-a'] });
    const b = cacheScopeKey({ sourceIds: ['host', 'team-b'] });
    expect(a).not.toBe(b);
  });

  test('federated set key is distinct from any single scalar key', () => {
    const set = cacheScopeKey({ sourceIds: ['host'] });
    const scalar = cacheScopeKey({ sourceId: 'host' });
    expect(set).not.toBe(scalar); // a 1-element set still cannot serve a scalar read
  });

  test('delimiter-like and type-like source ids cannot collide', () => {
    expect(cacheScopeKey({ sourceIds: ['a,b'] }))
      .not.toBe(cacheScopeKey({ sourceIds: ['a', 'b'] }));
    expect(cacheScopeKey({ sourceIds: ['a', 'b'] }))
      .not.toBe(cacheScopeKey({ sourceId: '__set__:a,b' }));
  });

  test('duplicate federated ids normalize to set identity', () => {
    expect(cacheScopeKey({ sourceIds: ['team-a', 'host', 'team-a'] }))
      .toBe(cacheScopeKey({ sourceIds: ['host', 'team-a'] }));
  });
});
