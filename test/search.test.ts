/**
 * Search pipeline unit tests — RRF normalization, compiled truth boost,
 * cosine similarity, dedup key, and CJK word count.
 */

import { describe, test, expect } from 'bun:test';
import { rrfFusion, cosineSimilarity, applyQueryAwareBoosts, hybridSearch } from '../src/core/search/hybrid.ts';
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

describe('applyQueryAwareBoosts', () => {
  test('prefers maintained summary pages over compatibility stubs for exact entity queries', () => {
    const compatibility = makeResult({
      slug: 'knowledge/people/roger-gimbel',
      title: 'Roger Gimbel',
      type: 'people-profile' as any,
      chunk_text: 'Legacy compatibility note.',
      score: 1.0,
    });
    const summary = makeResult({
      slug: 'knowledge/people/roger-gimbel/summary',
      title: 'Summary',
      type: 'people-profile' as any,
      chunk_text: '# Roger Gimbel',
      score: 0.7,
    });
    const boosted = applyQueryAwareBoosts([compatibility, summary], 'Roger Gimbel');
    expect(boosted[0].slug).toBe('knowledge/people/roger-gimbel/summary');
    expect(boosted[0].score).toBeGreaterThan(boosted[1].score);
  });

  test('prefers company summary pages over same-name agent pages for exact company queries', () => {
    const agent = makeResult({
      slug: 'knowledge/agents/rodaco',
      title: 'Rodaco',
      type: 'agent-profile' as any,
      chunk_text: 'Backup agent on Intel Mac.',
      score: 1.0,
    });
    const company = makeResult({
      slug: 'knowledge/companies/rodaco/summary',
      title: 'Summary',
      type: 'company-summary' as any,
      chunk_text: '# Rodaco',
      score: 0.7,
    });
    const boosted = applyQueryAwareBoosts([agent, company], 'Rodaco');
    expect(boosted[0].slug).toBe('knowledge/companies/rodaco/summary');
    expect(boosted[0].score).toBeGreaterThan(boosted[1].score);
  });

  test('promotes canonical entity pages above digest noise for exact-name queries', () => {
    const digest = makeResult({
      slug: '2026-03-20',
      title: '2026 03 20',
      type: 'concept',
      chunk_text: 'Current progress for review from Roger Gimbel',
      score: 1.0,
    });
    const canonical = makeResult({
      slug: 'knowledge/people/roger-gimbel/summary',
      title: 'Summary',
      type: 'people-profile' as any,
      chunk_text: '# Roger Gimbel',
      score: 0.7,
    });
    const boosted = applyQueryAwareBoosts([digest, canonical], 'Roger Gimbel');
    expect(boosted[0].slug).toBe('knowledge/people/roger-gimbel/summary');
    expect(boosted[0].score).toBeGreaterThan(boosted[1].score);
  });

  test('promotes project-status pages when slug matches the query', () => {
    const pilot = makeResult({
      slug: 'knowledge/projects/selfgrowth-knowledge-pilot/readme',
      title: 'SelfGrowth Knowledge Pilot',
      type: 'project',
      score: 1.0,
    });
    const status = makeResult({
      slug: 'projects/control/project-status/selfgrowth',
      title: 'Selfgrowth',
      type: 'project-status' as any,
      score: 0.8,
    });
    const boosted = applyQueryAwareBoosts([pilot, status], 'SelfGrowth');
    expect(boosted[0].slug).toBe('projects/control/project-status/selfgrowth');
  });

  test('demotes raw imported pages below structured canonical pages for exact entity queries', () => {
    const rawImport = makeResult({
      slug: 'knowledge/projects/selfgrowth-knowledge-pilot/raw/imported-selfgrowth',
      title: 'selfgrowth',
      type: 'project',
      score: 1.0,
    });
    const status = makeResult({
      slug: 'projects/control/project-status/selfgrowth',
      title: 'Selfgrowth',
      type: 'project-status' as any,
      score: 0.8,
    });
    const boosted = applyQueryAwareBoosts([rawImport, status], 'SelfGrowth');
    expect(boosted[0].slug).toBe('projects/control/project-status/selfgrowth');
  });

  test('prefers canonical agent pages when the query adds an explicit type hint', () => {
    const article = makeResult({
      slug: 'clippings/how-to-build-smart-stress-tested-openclaw-hermes-agents-for-under-30',
      title: 'How to Build Smart, Stress-Tested OpenClaw + Hermes Agents for Under $30',
      type: 'concept',
      score: 1.0,
    });
    const agent = makeResult({
      slug: 'knowledge/agents/hermes',
      title: 'Hermes',
      type: 'agent-profile' as any,
      chunk_text: '# Hermes',
      score: 0.75,
    });
    const boosted = applyQueryAwareBoosts([article, agent], 'Hermes Agent');
    expect(boosted[0].slug).toBe('knowledge/agents/hermes');
  });

  test('prefers canonical company summaries when the query adds a brand-style ai suffix', () => {
    const noisy = makeResult({
      slug: 'claude-memory/feedback_obsidian_vaults',
      title: 'Feedback Obsidian Vaults',
      type: 'feedback',
      chunk_text: 'Winston and Rodaco have separate Obsidian vaults. Two AI agents with different identities.',
      score: 1.0,
    });
    const company = makeResult({
      slug: 'knowledge/companies/rodaco/summary',
      title: 'Summary',
      type: 'company-summary' as any,
      chunk_text: '# Rodaco',
      score: 0.7,
    });
    const boosted = applyQueryAwareBoosts([noisy, company], 'Rodaco AI');
    expect(boosted[0].slug).toBe('knowledge/companies/rodaco/summary');
  });

  test('does not treat unspaced prefixes as ai suffix aliases', () => {
    const noisy = makeResult({
      slug: 'knowledge/companies/openai/summary',
      title: 'Summary',
      type: 'company-summary' as any,
      chunk_text: '# OpenAI',
      score: 1.0,
    });
    const wrongPrefix = makeResult({
      slug: 'knowledge/companies/open/summary',
      title: 'Summary',
      type: 'company-summary' as any,
      chunk_text: '# Open',
      score: 0.7,
    });
    const boosted = applyQueryAwareBoosts([noisy, wrongPrefix], 'OpenAI');
    expect(boosted[0].slug).toBe('knowledge/companies/openai/summary');
  });

  test('prefers the explicit company canonical page for ambiguous company disambiguators', () => {
    const agent = makeResult({
      slug: 'knowledge/agents/rodaco',
      title: 'Rodaco',
      type: 'agent-profile' as any,
      chunk_text: '# Rodaco',
      score: 1.0,
    });
    const company = makeResult({
      slug: 'knowledge/companies/rodaco/summary',
      title: 'Summary',
      type: 'company-summary' as any,
      chunk_text: '# Rodaco',
      score: 0.2,
    });
    const boosted = applyQueryAwareBoosts([agent, company], 'Rodaco Company');
    expect(boosted[0].slug).toBe('knowledge/companies/rodaco/summary');
  });

  test('prefers the explicit agent canonical page for ambiguous agent disambiguators', () => {
    const company = makeResult({
      slug: 'knowledge/companies/rodaco/summary',
      title: 'Summary',
      type: 'company-summary' as any,
      chunk_text: '# Rodaco',
      score: 1.0,
    });
    const agent = makeResult({
      slug: 'knowledge/agents/rodaco',
      title: 'Rodaco',
      type: 'agent-profile' as any,
      chunk_text: '# Rodaco',
      score: 0.15,
    });
    const boosted = applyQueryAwareBoosts([company, agent], 'Rodaco Agent');
    expect(boosted[0].slug).toBe('knowledge/agents/rodaco');
  });

  test('prefers the explicit Hermes agent canonical page for assistant-style aliases', () => {
    const installNote = makeResult({
      slug: 'claude-memory/project_hermes_m5',
      title: 'Project Hermes M5',
      type: 'project',
      chunk_text: 'Hermes Agent on the M5 Mac.',
      score: 1.0,
    });
    const agent = makeResult({
      slug: 'knowledge/agents/hermes',
      title: 'Hermes',
      type: 'agent-profile' as any,
      chunk_text: '# Hermes',
      score: 0.15,
    });
    const boosted = applyQueryAwareBoosts([installNote, agent], 'Hermes Assistant');
    expect(boosted[0].slug).toBe('knowledge/agents/hermes');
  });
});

describe('hybridSearch exact-query candidate rescue', () => {
  test('widens the keyword candidate pool so exact canonical company pages are not missed behind noisy lexical matches', async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const dataset: SearchResult[] = [
        makeResult({
          slug: 'knowledge/agents/rodaco',
          title: 'Rodaco',
          type: 'agent-profile' as any,
          chunk_text: 'Backup agent on Intel Mac.',
          chunk_source: 'compiled_truth',
          chunk_id: 1,
          score: 0.710937,
        }),
      ];

      for (let i = 0; i < 56; i++) {
        dataset.push(makeResult({
          slug: `noise/page-${i}`,
          title: `Noise ${i}`,
          type: 'project',
          chunk_text: `Rodaco mention ${i}`,
          chunk_source: 'compiled_truth',
          chunk_id: i + 2,
          score: 0.35 - i * 0.001,
        }));
      }

      dataset.push(makeResult({
        slug: 'knowledge/companies/rodaco/summary',
        title: 'Summary',
        type: 'company-summary' as any,
        chunk_text: '# Rodaco',
        chunk_source: 'compiled_truth',
        chunk_id: 1000,
        score: 0.33098254,
      }));

      const engine = {
        searchKeyword: async (_query: string, opts?: { limit?: number }) => dataset.slice(0, opts?.limit ?? dataset.length),
      } as any;

      const results = await hybridSearch(engine, 'Rodaco', { limit: 10, expansion: false, detail: 'medium' });
      expect(results[0].slug).toBe('knowledge/companies/rodaco/summary');
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    }
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
