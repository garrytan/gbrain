/**
 * Regression test for hybridSearch dropping filter options on inner search calls.
 *
 * Before fix: `const searchOpts: SearchOpts = { limit: innerLimit, detail };`
 *   silently dropped caller-provided `type`, `exclude_slugs` (and any future
 *   filter field) from the SearchOpts forwarded to engine.searchKeyword and
 *   engine.searchVector.
 *
 * After fix: `const searchOpts: SearchOpts = { ...opts, limit: innerLimit, offset: 0, detail };`
 *   propagates every caller-provided filter to inner searches.
 */

import { describe, test, expect } from 'bun:test';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchOpts, SearchResult } from '../src/core/types.ts';

function makeMockEngine(): {
  engine: BrainEngine;
  capturedKeywordOpts: SearchOpts[];
  capturedVectorOpts: SearchOpts[];
} {
  const capturedKeywordOpts: SearchOpts[] = [];
  const capturedVectorOpts: SearchOpts[] = [];

  const engine = {
    async searchKeyword(_query: string, opts?: SearchOpts): Promise<SearchResult[]> {
      capturedKeywordOpts.push(opts ?? {});
      return [];
    },
    async searchVector(_embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
      capturedVectorOpts.push(opts ?? {});
      return [];
    },
    async getBacklinkCounts(_slugs: string[]): Promise<Map<string, number>> {
      return new Map();
    },
  } as unknown as BrainEngine;

  return { engine, capturedKeywordOpts, capturedVectorOpts };
}

describe('hybridSearch options propagation', () => {
  test('forwards caller-provided `type` filter to searchKeyword', async () => {
    const { engine, capturedKeywordOpts } = makeMockEngine();
    // Ensure vector search path is skipped (no OPENAI_API_KEY).
    const priorKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await hybridSearch(engine, 'anything', { type: 'person' });
    } finally {
      if (priorKey !== undefined) process.env.OPENAI_API_KEY = priorKey;
    }

    expect(capturedKeywordOpts.length).toBeGreaterThan(0);
    expect(capturedKeywordOpts[0].type).toBe('person');
  });

  test('forwards caller-provided `exclude_slugs` filter to searchKeyword', async () => {
    const { engine, capturedKeywordOpts } = makeMockEngine();
    const priorKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await hybridSearch(engine, 'anything', { exclude_slugs: ['foo', 'bar'] });
    } finally {
      if (priorKey !== undefined) process.env.OPENAI_API_KEY = priorKey;
    }

    expect(capturedKeywordOpts[0].exclude_slugs).toEqual(['foo', 'bar']);
  });

  test('overrides caller-provided `limit` and `offset` for inner searches', async () => {
    // limit must be innerLimit (limit*2 capped at MAX_SEARCH_LIMIT), not the caller's
    // limit — inner searches need more candidates for RRF fusion. offset must be 0
    // because outer slicing applies offset to the final result set.
    const { engine, capturedKeywordOpts } = makeMockEngine();
    const priorKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await hybridSearch(engine, 'anything', { limit: 10, offset: 5 });
    } finally {
      if (priorKey !== undefined) process.env.OPENAI_API_KEY = priorKey;
    }

    expect(capturedKeywordOpts[0].limit).toBe(20); // 10 * 2
    expect(capturedKeywordOpts[0].offset).toBe(0);
  });

  test('handles undefined opts without throwing', async () => {
    const { engine, capturedKeywordOpts } = makeMockEngine();
    const priorKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await hybridSearch(engine, 'anything');
    } finally {
      if (priorKey !== undefined) process.env.OPENAI_API_KEY = priorKey;
    }

    expect(capturedKeywordOpts.length).toBe(1);
    expect(capturedKeywordOpts[0].limit).toBe(40); // default 20 * 2
  });
});
