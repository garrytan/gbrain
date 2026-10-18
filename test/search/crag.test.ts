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
  RELAXED_CORROBORATION_DEPTH,
  relaxedTopCorroborated,
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

  test('every grade carries the rank-1 rerank score when the reranker ran, including identity tiers', () => {
    for (const evidence of ['high_vector_match', 'exact_title_match', 'alias_hit'] as const) {
      const g = gradeRetrievalConfidence([r({ evidence, rerank_score: 0.91 })]);
      expect({ level: g.level, reason: g.reason, top_rerank_score: g.top_rerank_score }).toEqual({ level: 'strong', reason: evidence, top_rerank_score: 0.91 });
    }
    expect(gradeRetrievalConfidence([r({ evidence: 'high_vector_match' })]).top_rerank_score).toBeUndefined();
    expect(gradeRetrievalConfidence([r({ evidence: 'high_vector_match', rerank_score: 3, rerank_score_kind: 'rubric' })]).top_rerank_score).toBeUndefined();
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

// gbrain-evals A4-2: on the keyword path every natural question graded
// moderate, although the rank-1 row was an OR-relaxed match for 120 of 120
// unanswerable questions (and 80 of 120 answerable ones).
describe('A4-2: an OR-relaxed keyword top is weak', () => {
  test('keyword_relaxed top → weak / keyword_relaxed_top, even when labelled keyword_exact upstream', () => {
    const g = gradeRetrievalConfidence([r({ keyword_relaxed: true, evidence: 'keyword_exact' })]);
    expect(g).toEqual({ level: 'weak', reason: 'keyword_relaxed_top', top_evidence: 'keyword_exact' });
  });
  test('a strict keyword top stays moderate; identity and rerank signals still win over relaxed', () => {
    expect(gradeRetrievalConfidence([r({ evidence: 'keyword_exact' })]).reason).toBe('keyword_exact_top');
    expect(gradeRetrievalConfidence([r({ keyword_relaxed: true, evidence: 'exact_title_match' })]).level).toBe('strong');
    expect(gradeRetrievalConfidence([r({ keyword_relaxed: true, rerank_score: 0.9 })]).reason).toBe('rerank_top');
  });
});

// #5919: a relaxed top is moderate only when the top rows corroborate it.
describe('#5919: corroborating an OR-relaxed keyword top', () => {
  const relaxed = (title: string, chunk_text: string) => r({ keyword_relaxed: true, evidence: 'weak_semantic', title, chunk_text });
  const profile = relaxed('Quillon Example', 'Quillon Example is headquartered in Varnholt. Quillon Example has 212 employees.');
  const note = relaxed('Diligence note: Pellar Example', 'Diligence note on Pellar Example. Pellar Example was founded in March 1998.');
  const other = relaxed('Brisk Example', 'Brisk Example is headquartered in Ostrel.');

  test('one framing word the corpus never writes, rest co-located in one row → moderate', () => {
    const query = 'Which city is Quillon Example headquartered in?';
    expect(relaxedTopCorroborated([profile, other], query)).toBe(true);
    expect(gradeRetrievalConfidence([profile, other], { query })).toEqual({
      level: 'moderate', reason: 'keyword_relaxed_corroborated', top_evidence: 'weak_semantic',
    });
  });

  test('the corroborating row may sit lower in the top five', () => {
    const query = 'How many employees does Quillon Example have?';
    expect(gradeRetrievalConfidence([other, note, profile], { query }).level).toBe('moderate');
  });

  test('inflections compare equal ("headquarters" vs "headquartered")', () => {
    expect(relaxedTopCorroborated([profile], 'Which city has the Quillon Example headquarters?')).toBe(true);
  });

  test('entity in one row, attribute only in others (missing attribute) → weak', () => {
    const query = 'Which city is Pellar Example headquartered in?';
    expect(relaxedTopCorroborated([note, other], query)).toBe(false);
    expect(gradeRetrievalConfidence([note, other], { query })).toMatchObject({ level: 'weak', reason: 'keyword_relaxed_top' });
  });

  test('a name in the question that no row mentions (absent entity) → weak', () => {
    const query = 'When was Corvane Example founded?';
    expect(relaxedTopCorroborated([note], query)).toBe(false);
    expect(relaxedTopCorroborated([note], 'when was corvane example founded?')).toBe(true);
  });

  test('more than one unmatched content term (attribute phrased in words the evidence never uses) → weak', () => {
    const arr = relaxed('Quillon Example', 'Quillon Example reports $4.2M ARR.');
    expect(relaxedTopCorroborated([arr], 'What is the annual recurring revenue of Quillon Example?')).toBe(false);
  });

  test('a framing word written in another window row is treated like an attribute written elsewhere → weak', () => {
    const cityRow = relaxed('Brisk Example', 'Brisk Example is headquartered in a coastal city.');
    expect(relaxedTopCorroborated([profile, cityRow], 'Which city is Quillon Example headquartered in?')).toBe(false);
  });

  test('only rows inside the top five count', () => {
    const query = 'Which city is Quillon Example headquartered in?';
    const filler = Array.from({ length: RELAXED_CORROBORATION_DEPTH }, () => relaxed('Brisk Example', 'Brisk Example sells kites.'));
    expect(relaxedTopCorroborated([...filler, profile], query)).toBe(false);
  });

  test('without the query text a relaxed top stays weak', () => {
    expect(gradeRetrievalConfidence([profile]).reason).toBe('keyword_relaxed_top');
  });
});
