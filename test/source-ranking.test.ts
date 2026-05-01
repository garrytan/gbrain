import { describe, expect, test } from 'bun:test';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import {
  rankSearchResults,
  sourceRankCandidateLimit,
  sourceRankFactor,
} from '../src/core/search/source-ranking.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';

function result(slug: string, score: number, chunkSource: SearchResult['chunk_source']): SearchResult {
  return {
    slug,
    page_id: score,
    title: slug,
    type: 'concept',
    chunk_text: `${slug} match`,
    chunk_source: chunkSource,
    score,
    stale: false,
  };
}

describe('source-aware search ranking', () => {
  test('prefers curated memory pages over bulk notes when scores are close', () => {
    const ranked = rankSearchResults([
      result('daily/2026-04-29', 1.0, 'compiled_truth'),
      result('originals/context-compounding', 0.82, 'compiled_truth'),
      result('concepts/context-compounding', 0.88, 'compiled_truth'),
    ]);

    expect(ranked.map(r => r.slug)).toEqual([
      'originals/context-compounding',
      'concepts/context-compounding',
      'daily/2026-04-29',
    ]);
    expect(ranked[0].score).toBe(0.82);
  });

  test('keeps source factors deterministic and path-prefix based', () => {
    expect(sourceRankFactor('originals/thesis')).toBe(1.5);
    expect(sourceRankFactor('brain/originals/thesis')).toBe(1.5);
    expect(sourceRankFactor('concepts/retrieval')).toBe(1.25);
    expect(sourceRankFactor('systems/mbrain')).toBe(1.15);
    expect(sourceRankFactor('daily/2026-04-29')).toBe(0.85);
    expect(sourceRankFactor('brain/daily/calendar/2026-04-29')).toBe(0.85);
    expect(sourceRankFactor('scratch/idea')).toBe(0.8);
    expect(sourceRankFactor('brain/media/podcast/interview')).toBe(0.75);
    expect(sourceRankFactor('unknown/path')).toBe(1);
  });

  test('uses a bounded wider candidate window before source ranking', () => {
    expect(sourceRankCandidateLimit(1)).toBe(50);
    expect(sourceRankCandidateLimit(20)).toBe(100);
    expect(sourceRankCandidateLimit(100)).toBe(200);
    expect(sourceRankCandidateLimit(0)).toBe(0);
  });

  test('uses source factors before preserving original order for full ties', () => {
    const ranked = rankSearchResults([
      result('concepts/b', 1, 'compiled_truth'),
      result('concepts/a', 1, 'compiled_truth'),
      result('systems/a', 1, 'timeline'),
    ]);

    expect(ranked.map(r => r.slug)).toEqual([
      'concepts/b',
      'concepts/a',
      'systems/a',
    ]);
  });

  test('search operation ranks a wider candidate set before applying the requested limit', async () => {
    const seenLimits: number[] = [];
    const engine = {
      searchKeyword: async (_query: string, opts?: { limit?: number }) => {
        seenLimits.push(opts?.limit ?? 0);
        return [
          result('daily/2026-04-29', 1, 'compiled_truth'),
          result('daily/2026-04-30', 0.99, 'compiled_truth'),
          result('originals/context-compounding', 0.7, 'compiled_truth'),
        ].slice(0, opts?.limit);
      },
    } as Pick<BrainEngine, 'searchKeyword'> as BrainEngine;
    const ctx = {
      engine,
      config: {
        engine: 'sqlite',
        offline: true,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      },
      dryRun: false,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as OperationContext;

    const results = await operationsByName.search.handler(ctx, {
      query: 'context compounding',
      limit: 1,
    }) as SearchResult[];

    expect(seenLimits).toEqual([50]);
    expect(results.map(r => r.slug)).toEqual(['originals/context-compounding']);
  });
});
