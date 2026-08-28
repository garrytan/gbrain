/**
 * hybridSearch lexical-arm rethrow (db-availability loop) — per-arm fail-open
 * is for DEGRADED arms, never for a DEAD DATABASE:
 *
 *   - BOTH searchKeyword and searchTitles failing with a DB-ACCESS-class
 *     error (isDbAccessFailure) rethrows the keyword arm's error so the
 *     classified database_error envelope reaches the caller instead of a
 *     silent [].
 *   - One arm SUCCEEDING (even with zero rows) proves the DB is alive → no
 *     rethrow, the search completes fail-open.
 *   - Both arms failing with NON-access errors (schema gaps etc.) keeps the
 *     historical fail-open contract — no rethrow.
 *
 * Driven with a minimal fake engine: the two lexical arms are the variables;
 * every other engine surface hybridSearch's fail-open stages may touch
 * resolves benign-empty. The unit lane is hermetic-keyless (provider-keys
 * preload), so the vector leg short-circuits to the keyword-only path and
 * no gateway/network is ever hit.
 */

import { describe, test, expect } from 'bun:test';

import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';

function accessError(msg = 'connect ECONNREFUSED 127.0.0.1:5432'): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'ECONNREFUSED';
  return e;
}

function fakeEngine(arms: {
  searchKeyword: () => Promise<SearchResult[]>;
  searchTitles: () => Promise<SearchResult[]>;
}): BrainEngine {
  return {
    kind: 'pglite',
    getConfig: async () => null,
    executeRaw: async () => [],
    resolveAliases: async () => new Map(),
    getPage: async () => null,
    getContentFlagsByPageIds: async () => new Map(),
    getUnverifiedExtractionPageIds: async () => new Map(),
    relationalFanout: async () => [],
    searchVector: async () => [],
    searchKeyword: arms.searchKeyword,
    searchTitles: arms.searchTitles,
  } as unknown as BrainEngine;
}

// A plain phrase: never parses as a relational query, never slug/image-shaped.
const QUERY = 'orchard telemetry notes';

describe('hybridSearch both-lexical-arms-FAILED rethrow', () => {
  test('BOTH arms reject with a DB-access-class error → rethrows the keyword error (identity)', async () => {
    const kwErr = accessError();
    const titleErr = accessError('connection refused during titles scan');
    const engine = fakeEngine({
      searchKeyword: () => Promise.reject(kwErr),
      searchTitles: () => Promise.reject(titleErr),
    });
    let caught: unknown;
    try {
      await hybridSearch(engine, QUERY, { limit: 5 });
    } catch (e) {
      caught = e;
    }
    // The KEYWORD arm's error is the one rethrown (`throw keywordAccessError`)
    // — by identity, so dispatch's classifier sees the REAL error shape.
    expect(caught).toBe(kwErr);
  });

  test('keyword arm access-fails but titles SUCCEEDS with zero rows → NO rethrow (DB proven alive)', async () => {
    const engine = fakeEngine({
      searchKeyword: () => Promise.reject(accessError()),
      searchTitles: async () => [],
    });
    const results = await hybridSearch(engine, QUERY, { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results).toEqual([]);
  });

  test('titles arm access-fails but keyword SUCCEEDS with zero rows → NO rethrow (symmetric)', async () => {
    const engine = fakeEngine({
      searchKeyword: async () => [],
      searchTitles: () => Promise.reject(accessError('ECONNREFUSED titles')),
    });
    const results = await hybridSearch(engine, QUERY, { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });

  test('BOTH arms reject with NON-access errors → fail-open preserved, no rethrow', async () => {
    const engine = fakeEngine({
      searchKeyword: () => Promise.reject(new Error('schema thing exploded')),
      searchTitles: () => Promise.reject(new Error('another schema thing')),
    });
    const results = await hybridSearch(engine, QUERY, { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results).toEqual([]);
  });
});
