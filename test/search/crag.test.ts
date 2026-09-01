/**
 * #1663 — CRAG confidence grading (pure). The gate the `query` op keys its
 * meta + escalation off. No engine, no LLM — fast parallel loop.
 */
import { describe, test, expect } from 'bun:test';
import {
  gradeRetrievalConfidence,
  shouldEscalateRetrieval,
  confidenceRank,
  DEFAULT_CRAG_MIN_TOP,
} from '../../src/core/search/crag.ts';
import type { SearchResult } from '../../src/core/types.ts';

function r(partial: Partial<SearchResult>): SearchResult {
  return {
    slug: 's', title: 't', chunk_text: '', type: 'note', source_id: 'default',
    chunk_index: 0, chunk_id: 1, score: 0.5, ...partial,
  } as SearchResult;
}

describe('gradeRetrievalConfidence (#1663)', () => {
  test('zero results → weak / zero_results', () => {
    expect(gradeRetrievalConfidence([])).toEqual({ level: 'weak', reason: 'zero_results' });
  });

  test('identity-tier top signals are strong', () => {
    expect(gradeRetrievalConfidence([r({ exact_lookup: 'slug' })]).level).toBe('strong');
    expect(gradeRetrievalConfidence([r({ exact_lookup: 'slug' })]).reason).toBe('exact_lookup');
    expect(gradeRetrievalConfidence([r({ alias_hit: true })]).reason).toBe('alias_hit');
    expect(gradeRetrievalConfidence([r({ evidence: 'exact_title_match' })]).reason).toBe('exact_title_match');
    expect(gradeRetrievalConfidence([r({ evidence: 'high_vector_match' })]).reason).toBe('high_vector_match');
  });

  test('reranked top at/above the floor is strong; below is weak', () => {
    const strong = gradeRetrievalConfidence([r({ rerank_score: DEFAULT_CRAG_MIN_TOP })]);
    expect(strong.level).toBe('strong');
    expect(strong.reason).toBe('rerank_top');
    expect(strong.top_rerank_score).toBe(DEFAULT_CRAG_MIN_TOP);

    const weak = gradeRetrievalConfidence([r({ rerank_score: 0.05, evidence: 'weak_semantic' })]);
    expect(weak.level).toBe('weak');
    expect(weak.reason).toBe('rerank_top_below_floor');
  });

  test('floor is overridable', () => {
    expect(gradeRetrievalConfidence([r({ rerank_score: 0.15 })], { minTopScore: 0.1 }).level).toBe('strong');
    expect(gradeRetrievalConfidence([r({ rerank_score: 0.15 })], { minTopScore: 0.3 }).level).toBe('weak');
  });

  test('no reranker: keyword_exact top is moderate; weak_semantic top is weak', () => {
    expect(gradeRetrievalConfidence([r({ evidence: 'keyword_exact' })])).toMatchObject({
      level: 'moderate',
      reason: 'keyword_exact_top',
    });
    expect(gradeRetrievalConfidence([r({ evidence: 'weak_semantic' })])).toMatchObject({
      level: 'weak',
      reason: 'weak_semantic_top',
    });
  });

  test('only rank-1 drives the grade (a weak tail below a strong top is fine)', () => {
    const g = gradeRetrievalConfidence([
      r({ evidence: 'high_vector_match' }),
      r({ evidence: 'weak_semantic' }),
      r({ evidence: 'weak_semantic' }),
    ]);
    expect(g.level).toBe('strong');
  });
});

describe('shouldEscalateRetrieval / confidenceRank (#1663)', () => {
  test('escalates only when enabled, weak, and not already escalated', () => {
    const weak = gradeRetrievalConfidence([]);
    expect(shouldEscalateRetrieval(weak, { enabled: true })).toBe(true);
    expect(shouldEscalateRetrieval(weak, { enabled: false })).toBe(false);
    expect(shouldEscalateRetrieval(weak, { enabled: true, alreadyEscalated: true })).toBe(false);
    const strong = gradeRetrievalConfidence([r({ alias_hit: true })]);
    expect(shouldEscalateRetrieval(strong, { enabled: true })).toBe(false);
  });

  test('#4610: callerExpanded gates the re-run (the documented high-ceiling skip)', () => {
    const weak = gradeRetrievalConfidence([]);
    // First pass already ran with expansion → the re-run would re-pay the
    // expansion LLM call + rerank for a near-identical query. Skip it.
    expect(shouldEscalateRetrieval(weak, { enabled: true, callerExpanded: true })).toBe(false);
    // Caller explicitly opted out of expansion → the forced-expansion re-run
    // has something new to find. Fire.
    expect(shouldEscalateRetrieval(weak, { enabled: true, callerExpanded: false })).toBe(true);
    expect(shouldEscalateRetrieval(weak, {
      enabled: true, alreadyEscalated: false, callerExpanded: false,
    })).toBe(true);
  });

  test('rank ordering: strong > moderate > weak', () => {
    expect(confidenceRank('strong')).toBeGreaterThan(confidenceRank('moderate'));
    expect(confidenceRank('moderate')).toBeGreaterThan(confidenceRank('weak'));
  });
});
