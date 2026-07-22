/**
 * Query-cache scope key (federation hardening).
 *
 * A federated search reads a different graph than a single-source one, so
 * the semantic cache must key them apart. `cacheScopeKey` produces an
 * order-independent key for federated scopes and keeps unscoped all-source
 * reads distinct from every scalar source key.
 */

import { describe, test, expect } from 'bun:test';
import { cacheScopeKey, isSemanticCacheRequestSafe } from '../src/core/search/hybrid.ts';
import type { HybridSearchOpts } from '../src/core/search/hybrid.ts';

describe('cacheScopeKey', () => {
  test('unscoped uses a typed key and never collides with scalar default', () => {
    expect(cacheScopeKey(undefined)).toBe('["all"]');
    expect(cacheScopeKey({})).toBe('["all"]');
    expect(cacheScopeKey({})).not.toBe(cacheScopeKey({ sourceId: 'default' }));
  });

  test('scalar sourceId uses a typed key', () => {
    expect(cacheScopeKey({ sourceId: 'host' })).toBe('["scalar","host"]');
  });

  test('federated sourceIds → order-independent set key', () => {
    const k1 = cacheScopeKey({ sourceIds: ['team-b', 'team-a', 'host'] });
    const k2 = cacheScopeKey({ sourceIds: ['host', 'team-a', 'team-b'] });
    expect(k1).toBe(k2); // order does not matter
    expect(k1).toBe('["set","host","team-a","team-b"]');
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

  test('rejects forged scalar/set encodings and invalid federated ids', () => {
    expect(() => cacheScopeKey({ sourceId: '__set__:a,b' })).toThrow('Invalid source_id');
    expect(() => cacheScopeKey({ sourceIds: ['a', '__all__'] })).toThrow('Invalid source_id');
  });
});

describe('isSemanticCacheRequestSafe', () => {
  test('accepts the standard cache-safe request shape', () => {
    expect(isSemanticCacheRequestSafe({ limit: 20, sourceId: 'default' })).toBe(true);
  });

  test('accepts the production query-op shape (expandFn is folded into the knobs hash, not unsafe)', () => {
    // operations.ts always passes expandFn on the default `query` op path;
    // listing it unsafe would permanently disable the semantic cache for the
    // flagship op. Its effect is keyed via the expansion bit instead
    // (hybridSearchCached folds `expandFn ? expansion : false` into the hash).
    expect(isSemanticCacheRequestSafe({
      limit: 20,
      offset: 0,
      expansion: true,
      expandFn: async (q: string) => [q],
      sourceId: 'default',
    })).toBe(true);
  });

  const unsafeRequests: HybridSearchOpts[] = [
    { offset: 10 }, { detail: 'high' }, { language: 'typescript' },
    { symbolKind: 'function' }, { types: ['note'] }, { since: '7d' },
    { until: '2026-07-18' }, { salience: 'on' }, { recency: 'strong' },
    { crossModal: 'both' }, { exclude_slugs: ['private/page'] },
  ];

  test.each(unsafeRequests)('rejects unsupported result-shaping request %#', (opts) => {
    expect(isSemanticCacheRequestSafe(opts)).toBe(false);
  });
});
