import { describe, it, expect } from 'bun:test';
import { applyRecencyBoost } from '../src/core/search/recency.ts';
import type { SearchResult } from '../src/core/types.ts';

function makeResult(slug: string, score: number): SearchResult {
  return {
    slug,
    page_id: 1,
    title: slug,
    type: 'concept' as any,
    chunk_text: 'test',
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score,
    stale: false,
  };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe('applyRecencyBoost', () => {
  it('brand-new page gets max boost at strength=1 (~2.0x)', () => {
    const results = [makeResult('new-page', 1.0)];
    const timestamps = new Map([['new-page', new Date()]]);
    applyRecencyBoost(results, timestamps, 1);
    // factor = 1 + 1.0 / (1 + 0/30) = 2.0
    expect(results[0].score).toBeCloseTo(2.0, 1);
  });

  it('brand-new page gets max boost at strength=2 (~2.5x)', () => {
    const results = [makeResult('new-page', 1.0)];
    const timestamps = new Map([['new-page', new Date()]]);
    applyRecencyBoost(results, timestamps, 2);
    // factor = 1 + 1.5 / (1 + 0/7) = 2.5
    expect(results[0].score).toBeCloseTo(2.5, 1);
  });

  it('30-day-old page gets ~half boost at strength=1 (~1.5x)', () => {
    const results = [makeResult('old-page', 1.0)];
    const timestamps = new Map([['old-page', daysAgo(30)]]);
    applyRecencyBoost(results, timestamps, 1);
    // factor = 1 + 1.0 / (1 + 30/30) = 1 + 1/2 = 1.5
    expect(results[0].score).toBeCloseTo(1.5, 1);
  });

  it('365-day-old page gets minimal boost at strength=1', () => {
    const results = [makeResult('ancient', 1.0)];
    const timestamps = new Map([['ancient', daysAgo(365)]]);
    applyRecencyBoost(results, timestamps, 1);
    // factor = 1 + 1.0 / (1 + 365/30) ≈ 1.076
    expect(results[0].score).toBeGreaterThan(1.0);
    expect(results[0].score).toBeLessThan(1.1);
  });

  it('strength=2 decays faster than strength=1', () => {
    const r1 = [makeResult('page', 1.0)];
    const r2 = [makeResult('page', 1.0)];
    const timestamps = new Map([['page', daysAgo(14)]]);
    applyRecencyBoost(r1, timestamps, 1);
    applyRecencyBoost(r2, timestamps, 2);
    // At 14 days: strength=1 factor = 1 + 1/(1+14/30) ≈ 1.68
    // At 14 days: strength=2 factor = 1 + 1.5/(1+14/7) = 1 + 1.5/3 = 1.5
    // strength=2 has already decayed more at 14 days
    expect(r1[0].score).toBeGreaterThan(r2[0].score);
  });

  it('page with no timestamp gets no boost (score unchanged)', () => {
    const results = [makeResult('no-ts', 0.75)];
    const timestamps = new Map<string, Date>(); // empty
    applyRecencyBoost(results, timestamps, 1);
    expect(results[0].score).toBe(0.75);
  });

  it('empty results array is a no-op', () => {
    const results: SearchResult[] = [];
    const timestamps = new Map<string, Date>();
    applyRecencyBoost(results, timestamps, 1);
    expect(results).toHaveLength(0);
  });

  it('mutates results in place (same contract as backlink boost)', () => {
    const result = makeResult('test', 1.0);
    const results = [result];
    const timestamps = new Map([['test', new Date()]]);
    applyRecencyBoost(results, timestamps, 1);
    // Same object reference, mutated score
    expect(results[0]).toBe(result);
    expect(result.score).toBeGreaterThan(1.0);
  });

  it('multiple results get independent boosts', () => {
    const results = [
      makeResult('new', 1.0),
      makeResult('medium', 1.0),
      makeResult('old', 1.0),
    ];
    const timestamps = new Map<string, Date>([
      ['new', daysAgo(0)],
      ['medium', daysAgo(30)],
      ['old', daysAgo(365)],
    ]);
    applyRecencyBoost(results, timestamps, 1);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });
});

// Intent detection tests (recency is auto-triggered by temporal intent)
import { classifyQueryIntent } from '../src/core/search/intent.ts';

describe('intent classification → recency triggering', () => {
  it('"what\'s new with Ollama" → temporal (triggers recency)', () => {
    expect(classifyQueryIntent("what's new with Ollama")).toBe('temporal');
  });

  it('"recent updates on X" → temporal (triggers recency)', () => {
    expect(classifyQueryIntent('recent updates on X')).toBe('temporal');
  });

  it('"latest on YC Labs" → temporal (triggers recency)', () => {
    expect(classifyQueryIntent('latest on YC Labs')).toBe('temporal');
  });

  it('"who is Garry Tan" → entity (no recency)', () => {
    expect(classifyQueryIntent('who is Garry Tan')).toBe('entity');
  });

  it('"tell me about Ollama" → entity (no recency)', () => {
    expect(classifyQueryIntent('tell me about Ollama')).toBe('entity');
  });

  it('"Ollama" (bare name) → general (no recency)', () => {
    expect(classifyQueryIntent('Ollama')).toBe('general');
  });
});
