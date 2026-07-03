import { describe, expect, test } from 'bun:test';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import {
  rankSearchResults,
  sourceRankCandidateLimit,
  sourceRankFactor,
  sourceRankedScore,
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

  test('allows configured source rank prefixes to override defaults', () => {
    const rules = [
      { prefix: 'office/personal/', factor: 1.45 },
      { prefix: 'office/', factor: 1.05 },
    ];

    expect(sourceRankFactor('office/personal/context', rules)).toBe(1.45);
    expect(sourceRankFactor('office/general/context', rules)).toBe(1.05);

    const ranked = rankSearchResults([
      result('daily/2026-04-29', 1.0, 'compiled_truth'),
      result('office/personal/context', 0.72, 'compiled_truth'),
    ], undefined, rules);

    expect(ranked.map((entry) => entry.slug)).toEqual([
      'office/personal/context',
      'daily/2026-04-29',
    ]);
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

  test('keeps unknown chunk sources finite and neutral', () => {
    const anchor = result('unknown/path', 1, 'anchor' as SearchResult['chunk_source']);

    expect(sourceRankedScore(anchor)).toBe(1);
    expect(Number.isFinite(sourceRankedScore(anchor))).toBe(true);

    const ranked = rankSearchResults([
      anchor,
      result('unknown/compiled', 1, 'compiled_truth'),
    ]);
    expect(ranked.map(r => r.slug)).toEqual([
      'unknown/compiled',
      'unknown/path',
    ]);
  });

  test('demotes superseded pages and uses recency as a stable tiebreak', () => {
    const superseded = {
      ...result('concepts/old', 1, 'compiled_truth'),
      superseded_by: 'concepts/new',
      updated_at: new Date('2026-01-01T00:00:00Z'),
    };
    const current = {
      ...result('concepts/new', 0.75, 'compiled_truth'),
      updated_at: new Date('2025-01-01T00:00:00Z'),
    };
    const recentTie = {
      ...result('concepts/recent', 0.5, 'compiled_truth'),
      updated_at: new Date('2026-02-01T00:00:00Z'),
    };
    const oldTie = {
      ...result('concepts/older', 0.5, 'compiled_truth'),
      updated_at: new Date('2025-02-01T00:00:00Z'),
    };

    expect(sourceRankedScore(superseded)).toBeLessThan(sourceRankedScore(current));
    expect(rankSearchResults([superseded, current]).map(r => r.slug)).toEqual([
      'concepts/new',
      'concepts/old',
    ]);
    expect(rankSearchResults([oldTie, recentTie]).map(r => r.slug)).toEqual([
      'concepts/recent',
      'concepts/older',
    ]);
  });

  test('search operation ranks a wider candidate set before applying the requested limit', async () => {
    const seenOpts: Array<{ limit?: number; updated_after?: Date; updated_before?: Date }> = [];
    const engine = {
      searchKeyword: async (_query: string, opts?: { limit?: number; updated_after?: Date; updated_before?: Date }) => {
        seenOpts.push(opts ?? {});
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
      updated_after: '2026-01-01T00:00:00Z',
      updated_before: '2026-12-31T23:59:59Z',
    }) as SearchResult[];

    expect(seenOpts[0]?.limit).toBe(50);
    expect(seenOpts[0]?.updated_after?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(seenOpts[0]?.updated_before?.toISOString()).toBe('2026-12-31T23:59:59.000Z');
    expect(results.map(r => r.slug)).toEqual(['originals/context-compounding']);
  });
});
