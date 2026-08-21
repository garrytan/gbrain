/**
 * Query-cache scope key (federation + scope-isolation hardening).
 *
 * A federated search reads a different graph than a single-source one, so
 * the semantic cache must key them apart. `cacheScopeKey` produces an
 * order-independent key for federated scopes and keeps scalar-scoped
 * lookups on the source id itself.
 *
 * #3871: an UNSCOPED search (neither sourceId nor sourceIds) reads ALL
 * sources, so its cache rows can contain rows from every source. Pre-fix it
 * keyed to 'default' — the same key a scalar `sourceId: 'default'` read
 * uses — so a scoped read could be served an all-sources row (cross-source
 * leak). Unscoped now keys to the sentinel '__unscoped__'.
 */

import { describe, test, expect } from 'bun:test';
import { cacheScopeKey, filterResultsByCallerScope } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';

describe('cacheScopeKey', () => {
  test('unscoped → __unscoped__ sentinel (#3871)', () => {
    expect(cacheScopeKey(undefined)).toBe('__unscoped__');
    expect(cacheScopeKey({})).toBe('__unscoped__');
  });

  test('unscoped key is distinct from the scalar default-source key (#3871)', () => {
    // An unscoped write (all-sources result set) must never share a row
    // with a `sourceId: 'default'` read (default-source-only result set).
    expect(cacheScopeKey({})).not.toBe(cacheScopeKey({ sourceId: 'default' }));
  });

  test('scalar sourceId → itself (single-source unchanged)', () => {
    expect(cacheScopeKey({ sourceId: 'host' })).toBe('host');
  });

  test('federated sourceIds → order-independent set key', () => {
    const k1 = cacheScopeKey({ sourceIds: ['team-b', 'team-a', 'host'] });
    const k2 = cacheScopeKey({ sourceIds: ['host', 'team-a', 'team-b'] });
    expect(k1).toBe(k2); // order does not matter
    expect(k1).toBe('__set__:host,team-a,team-b');
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
});

describe('filterResultsByCallerScope (#3871 hit-path defense-in-depth)', () => {
  const row = (slug: string, source_id?: string): SearchResult => ({
    slug,
    page_id: 1,
    title: slug,
    type: 'note',
    chunk_text: `chunk ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 1,
    stale: false,
    ...(source_id !== undefined ? { source_id } : {}),
  });

  const mixed = [
    row('a', 'default'),
    row('b', 'team-a'),
    row('c', 'team-b'),
    row('d'), // legacy row without source_id → treated as 'default'
  ];

  test('scalar sourceId keeps only that source (missing source_id → default)', () => {
    const kept = filterResultsByCallerScope(mixed, { sourceId: 'default' });
    expect(kept.map((r) => r.slug)).toEqual(['a', 'd']);

    const teamA = filterResultsByCallerScope(mixed, { sourceId: 'team-a' });
    expect(teamA.map((r) => r.slug)).toEqual(['b']);
  });

  test('federated sourceIds keep only set members', () => {
    const kept = filterResultsByCallerScope(mixed, { sourceIds: ['team-a', 'team-b'] });
    expect(kept.map((r) => r.slug)).toEqual(['b', 'c']);

    // 'default' in the set admits legacy rows without source_id too.
    const withDefault = filterResultsByCallerScope(mixed, { sourceIds: ['default'] });
    expect(withDefault.map((r) => r.slug)).toEqual(['a', 'd']);
  });

  test('unscoped caller gets the stored rows unfiltered', () => {
    expect(filterResultsByCallerScope(mixed, undefined)).toEqual(mixed);
    expect(filterResultsByCallerScope(mixed, {})).toEqual(mixed);
  });
});
