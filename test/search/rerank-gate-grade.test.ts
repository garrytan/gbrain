/**
 * W3 — the pre-rerank grade (crag.ts `gradePreRerank`, `applyRerankGateTrust`).
 *
 * Protects: which deduped candidate sets the rerank gate calls strong, and
 * why. Every strong reason, every not-strong reason, the δ gap measured
 * against a DIFFERENT page (several chunks of rank-1's page do not count),
 * candidates out of cosine order, multimodal, the full-title rule and the
 * trust floor.
 * Fails when: a phrase inside a longer title counts as identity, the gap is
 * taken against rank-1's own chunks or against the next row instead of the
 * best other page, an image row or multimodal query grades strong, an
 * external_untrusted page passes the floor, or ambiguous identity grades strong.
 * Seams: none (pure).
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RERANK_GATE_MIN_GAP,
  applyRerankGateTrust,
  gradePreRerank,
  normalizeRerankGate,
  normalizeRerankGateMinGap,
  type PreRerankGradeInput,
} from '../../src/core/search/crag.ts';
import type { SearchResult } from '../../src/core/types.ts';

const row = (slug: string, cosine: number | undefined, extra: Partial<SearchResult> = {}): SearchResult => ({
  slug, page_id: slug.length, title: slug, type: 'note', source_id: 'default', chunk_id: Math.round((cosine ?? 0) * 1000),
  chunk_index: 0, chunk_text: slug, chunk_source: 'compiled_truth', score: 1, stale: false,
  ...(cosine === undefined ? {} : { cosine }), ...extra,
} as SearchResult);

const grade = (candidates: SearchResult[], over: Partial<PreRerankGradeInput> = {}) => gradePreRerank({
  candidates, query: 'what is the orbital period', exactLookupHits: [], aliasCanonicals: [], multimodal: false, ...over,
});

describe('gradePreRerank — strong reasons', () => {
  test('exactly one exact-lookup page is strong exact_lookup, and vouches for that page', () => {
    const hit = row('people/alice-example', undefined, { page_id: 7, exact_lookup: 'slug' });
    const g = grade([row('notes/a', 0.2)], { exactLookupHits: [hit] });
    expect(g).toMatchObject({ strong: true, reason: 'exact_lookup', top: { slug: 'people/alice-example', source_id: 'default', page_id: 7 } });
  });

  test('exactly one alias page is strong alias_hit', () => {
    const g = grade([row('notes/a', 0.2)], { aliasCanonicals: [{ slug: 'projects/mingtang', source_id: 'default' }] });
    expect(g).toMatchObject({ strong: true, reason: 'alias_hit', top: { slug: 'projects/mingtang' } });
  });

  test('a full-title identity at rank 1 is strong exact_title_match', () => {
    const g = grade([row('companies/acme', 0.1, { title: 'Acme Widget', title_match_boost: 1.25 })], { query: '  acme   WIDGET ' });
    expect(g).toMatchObject({ strong: true, reason: 'exact_title_match' });
  });

  test('a high cosine leading the best other page by δ is strong high_vector_match', () => {
    const g = grade([row('notes/gold', 0.92), row('notes/b', 0.85), row('notes/c', 0.5)]);
    expect(g.strong).toBe(true);
    expect(g.reason).toBe('high_vector_match');
    expect(g.top_cosine).toBeCloseTo(0.92, 10);
    expect(g.gap).toBeCloseTo(0.07, 10);
  });

  test('a single page among the candidates leads by its own cosine', () => {
    const g = grade([row('notes/gold', 0.9), row('notes/gold', 0.88, { chunk_id: 5 })]);
    expect(g).toMatchObject({ strong: true, reason: 'high_vector_match' });
    expect(g.gap).toBeCloseTo(0.9, 10);
  });
});

describe('gradePreRerank — not strong', () => {
  test('two exact-lookup pages or two alias pages are ambiguous identity', () => {
    const hits = [row('a/one', undefined), row('a/two', undefined)];
    expect(grade([row('notes/a', 0.99)], { exactLookupHits: hits }).reason).toBe('identity_ambiguous');
    const two = [{ slug: 'p/hall', source_id: 'default' }, { slug: 'p/other-hall', source_id: 'default' }];
    expect(grade([row('notes/a', 0.99)], { aliasCanonicals: two })).toMatchObject({ strong: false, reason: 'identity_ambiguous' });
  });

  test('a single-token alias hop that would move rank 1 is ambiguous identity', () => {
    expect(grade([row('notes/a', 0.99)], { aliasTokenHop: true })).toMatchObject({ strong: false, reason: 'identity_ambiguous' });
  });

  test('exact lookup wins over alias ambiguity (it is applied last, so it is rank 1)', () => {
    const two = [{ slug: 'p/hall', source_id: 'default' }, { slug: 'p/other-hall', source_id: 'default' }];
    expect(grade([], { exactLookupHits: [row('p/hall', undefined)], aliasCanonicals: two }).reason).toBe('exact_lookup');
  });

  test('a phrase inside a longer title is not identity; the cosine rule still decides', () => {
    const partial = row('companies/acme', 0.3, { title: 'Acme Widget Holdings', title_match_boost: 1.25 });
    expect(grade([partial], { query: 'acme widget' })).toMatchObject({ strong: false, reason: 'cosine_below_floor' });
    const partialHigh = row('companies/acme', 0.95, { title: 'Acme Widget Holdings', title_match_boost: 1.25 });
    expect(grade([partialHigh], { query: 'acme widget' }).reason).toBe('high_vector_match');
  });

  test('no candidates, no cosine, cosine below the floor', () => {
    expect(grade([]).reason).toBe('no_candidates');
    expect(grade([row('notes/a', undefined)]).reason).toBe('no_cosine');
    expect(grade([row('notes/a', 0.79)])).toMatchObject({ strong: false, reason: 'cosine_below_floor', top_cosine: 0.79 });
    expect(grade([row('notes/a', 0.79)], { cosineFloor: 0.7 }).strong).toBe(true);
  });

  test('the gap is against the best OTHER page, not rank-1 own chunks and not the next row', () => {
    // Out of cosine order: the best other page sits at index 3.
    const candidates = [row('notes/gold', 0.9), row('notes/gold', 0.89, { chunk_id: 2 }), row('notes/b', 0.7), row('notes/c', 0.87)];
    const g = grade(candidates);
    expect(g).toMatchObject({ strong: false, reason: 'gap_below_min' });
    expect(g.gap).toBeCloseTo(0.03, 10);
    expect(grade(candidates, { minGap: 0 }).strong).toBe(true);
  });

  test('a rank-1 that is not the cosine leader fails at δ = 0', () => {
    const g = grade([row('notes/a', 0.85), row('notes/b', 0.9), row('notes/c', 0.4)], { minGap: 0 });
    expect(g.reason).toBe('gap_below_min');
    expect(g.gap).toBeCloseTo(-0.05, 10);
  });

  test('multimodal queries and image rows are never strong, even with identity-like signals on rank 1', () => {
    expect(grade([row('notes/a', 0.99)], { multimodal: true }).reason).toBe('multimodal');
    expect(grade([row('img/a', 0.99, { modality: 'image' })]).reason).toBe('multimodal');
    const titled = row('companies/acme', 0.99, { title: 'Acme', title_match_boost: 1.25, modality: 'image' });
    expect(grade([titled], { query: 'acme' }).strong).toBe(false);
  });

  test('image rows do not set the gap for a text rank-1', () => {
    const g = grade([row('notes/gold', 0.9), row('img/b', 0.89, { modality: 'image' }), row('notes/c', 0.5)]);
    expect(g.reason).toBe('high_vector_match');
    expect(g.gap).toBeCloseTo(0.4, 10);
  });
});

describe('applyRerankGateTrust', () => {
  const strong = grade([row('notes/gold', 0.95)]);
  test('external_untrusted rank-1 cannot skip; unknown and higher tiers pass', () => {
    expect(applyRerankGateTrust(strong, 'external_untrusted')).toMatchObject({ strong: false, reason: 'below_trust_floor' });
    expect(applyRerankGateTrust(strong, 'unknown').strong).toBe(true);
    expect(applyRerankGateTrust(strong, undefined).strong).toBe(true);
    expect(applyRerankGateTrust(strong, 'agent_written').strong).toBe(true);
  });
  test('a stricter caller floor raises it', () => {
    expect(applyRerankGateTrust(strong, 'agent_written', 'tool_observed').reason).toBe('below_trust_floor');
    expect(applyRerankGateTrust(strong, 'operator_curated', 'tool_observed').strong).toBe(true);
  });
  test('a not-strong grade passes through unchanged', () => {
    const weak = grade([row('notes/a', 0.1)]);
    expect(applyRerankGateTrust(weak, 'external_untrusted')).toBe(weak);
  });
});

describe('parse contracts', () => {
  test('gate literals only, any case; everything else is unset', () => {
    expect(normalizeRerankGate(' Shadow ')).toBe('shadow');
    expect(normalizeRerankGate('off')).toBe('off');
    for (const v of ['', 'true', 'yes', 1, null, undefined, {}]) expect(normalizeRerankGate(v)).toBeUndefined();
  });
  test('δ is a number in [0, 1]', () => {
    expect(normalizeRerankGateMinGap('0')).toBe(0);
    expect(normalizeRerankGateMinGap(0.05)).toBe(0.05);
    for (const v of ['-0.1', '1.5', 'abc', '', NaN, null]) expect(normalizeRerankGateMinGap(v)).toBeUndefined();
    expect(DEFAULT_RERANK_GATE_MIN_GAP).toBe(0.05);
  });
});
