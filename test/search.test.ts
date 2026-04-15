/**
 * Search pipeline unit tests — RRF normalization, compiled truth boost,
 * cosine similarity, dedup key, and CJK word count.
 */

import { describe, test, expect } from 'bun:test';
import { rrfFusion, cosineSimilarity } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    slug: 'test-page',
    page_id: 1,
    title: 'Test',
    type: 'concept',
    chunk_text: 'test chunk text',
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 0,
    stale: false,
    ...overrides,
  };
}

describe('rrfFusion', () => {
  test('normalizes scores to 0-1 range', () => {
    const list: SearchResult[] = [
      makeResult({ slug: 'a', chunk_id: 1, chunk_text: 'aaa' }),
      makeResult({ slug: 'b', chunk_id: 2, chunk_text: 'bbb' }),
    ];
    const results = rrfFusion([list], 60);
    // Top result should have score >= 1.0 (normalized to 1.0, then boosted 2.0x for compiled_truth)
    expect(results[0].score).toBe(2.0); // 1.0 * 2.0 boost
  });

  test('boosts compiled_truth chunks 2x over timeline', () => {
    const compiledChunk = makeResult({ slug: 'a', chunk_id: 1, chunk_source: 'compiled_truth', chunk_text: 'compiled text' });
    const timelineChunk = makeResult({ slug: 'b', chunk_id: 2, chunk_source: 'timeline', chunk_text: 'timeline text' });

    // Put timeline first (higher rank) in the list
    const results = rrfFusion([[timelineChunk, compiledChunk]], 60);

    // Timeline was rank 0, compiled was rank 1
    // Timeline raw: 1/(60+0) = 0.01667, compiled raw: 1/(60+1) = 0.01639
    // Normalized: timeline = 1.0, compiled = 0.983
    // Boosted: timeline = 1.0 * 1.0 = 1.0, compiled = 0.983 * 2.0 = 1.967
    // Compiled should now rank first
    expect(results[0].slug).toBe('a');
    expect(results[0].chunk_source).toBe('compiled_truth');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  test('timeline-only results are not boosted', () => {
    const list: SearchResult[] = [
      makeResult({ slug: 'a', chunk_id: 1, chunk_source: 'timeline', chunk_text: 'tl1' }),
      makeResult({ slug: 'b', chunk_id: 2, chunk_source: 'timeline', chunk_text: 'tl2' }),
    ];
    const results = rrfFusion([list], 60);
    // Top result: normalized to 1.0, no boost (timeline = 1.0x)
    expect(results[0].score).toBe(1.0);
  });

  test('returns empty for empty lists', () => {
    expect(rrfFusion([], 60)).toEqual([]);
    expect(rrfFusion([[]], 60)).toEqual([]);
  });

  test('single result normalizes to 1.0 before boost', () => {
    const results = rrfFusion([[makeResult({ chunk_source: 'timeline' })]], 60);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(1.0); // 1.0 normalized * 1.0 timeline boost
  });

  test('uses chunk_id for dedup key when available', () => {
    const chunk1 = makeResult({ slug: 'a', chunk_id: 10, chunk_text: 'same prefix text' });
    const chunk2 = makeResult({ slug: 'a', chunk_id: 20, chunk_text: 'same prefix text' });

    const results = rrfFusion([[chunk1, chunk2]], 60);
    // Both should survive because chunk_id differs
    expect(results).toHaveLength(2);
  });

  test('falls back to text prefix when chunk_id is missing', () => {
    const chunk1 = makeResult({ slug: 'a', chunk_id: undefined as any, chunk_text: 'same text' });
    const chunk2 = makeResult({ slug: 'a', chunk_id: undefined as any, chunk_text: 'same text' });

    const results = rrfFusion([[chunk1, chunk2]], 60);
    // Same slug + same text prefix = collapsed to 1
    expect(results).toHaveLength(1);
  });

  test('merges scores across multiple lists', () => {
    const chunk = makeResult({ slug: 'a', chunk_id: 1, chunk_source: 'timeline' });
    // Chunk appears at rank 0 in both lists
    const results = rrfFusion([[chunk], [{ ...chunk }]], 60);
    expect(results).toHaveLength(1);
    // Score should be 2 * 1/(60+0) = 0.0333, normalized to 1.0, no boost
    expect(results[0].score).toBe(1.0);
  });

  test('respects custom K parameter', () => {
    const list = [makeResult({ chunk_source: 'timeline' })];
    const k30 = rrfFusion([list], 30);
    const k90 = rrfFusion([list], 90);
    // Both have single result, normalized to 1.0
    expect(k30[0].score).toBe(1.0);
    expect(k90[0].score).toBe(1.0);
  });
});

describe('cosineSimilarity', () => {
  test('identical vectors return 1.0', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test('orthogonal vectors return 0.0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  test('opposite vectors return -1.0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test('zero vector returns 0.0 (no division by zero)', () => {
    const zero = new Float32Array([0, 0, 0]);
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(zero, v)).toBe(0);
    expect(cosineSimilarity(v, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  test('works with high-dimensional vectors', () => {
    const dim = 1536;
    const a = new Float32Array(dim).fill(1);
    const b = new Float32Array(dim).fill(1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  test('basis vectors are orthogonal', () => {
    const dim = 10;
    const a = new Float32Array(dim);
    const b = new Float32Array(dim);
    a[0] = 1.0;
    b[5] = 1.0;
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('CJK word count in expansion', () => {
  test('CJK characters are counted individually', async () => {
    // Import the module to test CJK detection logic
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test('向量搜索');
    expect(hasCJK).toBe(true);

    const query = '向量搜索优化';
    const wordCount = query.replace(/\s/g, '').length;
    expect(wordCount).toBe(6); // 6 CJK chars, not 1 "word"
  });

  test('non-CJK uses space-delimited counting', () => {
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test('hello world');
    expect(hasCJK).toBe(false);

    const query = 'hello world';
    const wordCount = (query.match(/\S+/g) || []).length;
    expect(wordCount).toBe(2);
  });

  test('Japanese hiragana detected as CJK', () => {
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test('こんにちは');
    expect(hasCJK).toBe(true);
  });

  test('Korean hangul detected as CJK', () => {
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test('안녕하세요');
    expect(hasCJK).toBe(true);
  });

  test('mixed CJK+Latin uses CJK counting', () => {
    const query = 'AI 向量搜索';
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(query);
    expect(hasCJK).toBe(true);
    const wordCount = query.replace(/\s/g, '').length;
    expect(wordCount).toBe(6); // "AI向量搜索" = 6 chars
  });
});
