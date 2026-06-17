import { describe, it, expect } from 'bun:test';
import { rankCandidates, runWhoknows, findExperts, type WhoknowsResult } from '../src/commands/whoknows.ts';
import type { PageType } from '../src/core/types.ts';

/**
 * v0.33 whoknows — pure-function unit tests covering the 10 locked
 * shadow-path cases from ENG-D3 plus a few obvious sanity asserts.
 *
 * The ranking spec (also documented in src/commands/whoknows.ts):
 *
 *   score = log(1 + raw_match)               // expertise (sub-linear)
 *         × max(0.1, exp(-days/180))         // recency (floored)
 *         × (0.5 + 0.5 × clamp(salience))    // salience (centered)
 *
 * These tests exercise rankCandidates (pure) and the CLI registration.
 * Integration against a real brain lives in test/e2e/whoknows.test.ts.
 */

function input(
  slug: string,
  raw_match: number,
  days: number | null,
  salience: number | null,
  type: PageType = 'person',
) {
  return {
    slug,
    source_id: 'default',
    title: slug,
    type,
    raw_match,
    days_since_effective: days,
    salience_raw: salience,
  };
}

describe('whoknows / rankCandidates — locked shadow paths (ENG-D3)', () => {
  // Case 1: zero hybrid-search results → empty array
  it('returns empty array on empty input', () => {
    expect(rankCandidates([])).toEqual([]);
  });

  // Case 2: negative recency input → floor activates, score stays valid
  it('negative days_since_effective clamps to 0 (recency_decay = 1.0)', () => {
    const ranked = rankCandidates([input('alice', 0.5, -10, 0.5)]);
    expect(ranked[0].factors.recency_decay).toBeCloseTo(1.0, 5);
    expect(Number.isFinite(ranked[0].score)).toBe(true);
  });

  // Case 3: NaN salience → defaults to neutral (0.5)
  it('NaN salience defaults to neutral 0.5', () => {
    const ranked = rankCandidates([input('bob', 0.5, 30, NaN)]);
    expect(ranked[0].factors.salience).toBeCloseTo(0.5, 5);
    expect(ranked[0].factors.salience_factor).toBeCloseTo(0.75, 5);
  });

  // Case 4: undefined / null match score → 0 expertise, score zeros gracefully
  it('NaN raw_match → expertise=0; score zeros gracefully without NaN', () => {
    const ranked = rankCandidates([input('carol', NaN, 30, 0.5)]);
    expect(ranked[0].factors.expertise).toBe(0);
    expect(ranked[0].score).toBe(0);
    expect(Number.isFinite(ranked[0].score)).toBe(true);
  });

  // Case 5: person-type filter — verified at SQL level by SearchOpts.types.
  // Here we assert rankCandidates preserves the type field passed in.
  it('preserves page type in the result row (filter happens upstream at SQL)', () => {
    const ranked = rankCandidates([
      input('alice', 0.5, 30, 0.5, 'person'),
      input('acme', 0.3, 30, 0.5, 'company'),
    ]);
    expect(ranked.find((r) => r.slug === 'alice')?.type).toBe('person');
    expect(ranked.find((r) => r.slug === 'acme')?.type).toBe('company');
  });

  // Case 6: --explain output includes all factor values
  it('every result includes the full factor breakdown for --explain', () => {
    const [row] = rankCandidates([input('alice', 0.5, 60, 0.4)]);
    expect(row.factors).toBeDefined();
    expect(typeof row.factors.expertise).toBe('number');
    expect(typeof row.factors.recency_decay).toBe('number');
    expect(typeof row.factors.recency_factor).toBe('number');
    expect(typeof row.factors.salience).toBe('number');
    expect(typeof row.factors.salience_factor).toBe('number');
    expect(typeof row.factors.raw_match).toBe('number');
    // days_since_effective may be null for cold-start; the shape is correct either way.
    expect('days_since_effective' in row.factors).toBe(true);
  });

  // Case 7: top-K honors opts.limit; defaults to 5
  it('top-K honors limit; defaults to 5; clamped to >= 1', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      input(`person-${String(i).padStart(2, '0')}`, 0.5 - i * 0.01, 30, 0.5),
    );
    expect(rankCandidates(many).length).toBe(5); // default
    expect(rankCandidates(many, 3).length).toBe(3);
    expect(rankCandidates(many, 100).length).toBe(12);
    expect(rankCandidates(many, 0).length).toBe(1); // clamped to >= 1
  });

  // Case 8: recency floor (0.1) — extreme days never produces NaN/Infinity
  it('extreme days_since_effective is floored, never produces NaN/Infinity', () => {
    const ranked = rankCandidates([
      input('ancient', 0.5, 365 * 100, 0.5), // 100 years
      input('cold-start', 0.5, null, 0.5), // never updated
    ]);
    for (const r of ranked) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.factors.recency_factor).toBeGreaterThanOrEqual(0.1);
    }
    // cold-start (null days) → recency_factor = floor (0.1)
    const cold = ranked.find((r) => r.slug === 'cold-start')!;
    expect(cold.factors.recency_factor).toBeCloseTo(0.1, 5);
  });

  // Case 9: stable ordering — same-score ties break by slug alphabetical
  it('same-score ties break alphabetically by slug for determinism', () => {
    const ranked = rankCandidates([
      input('zoe', 0.5, 30, 0.5),
      input('alice', 0.5, 30, 0.5),
      input('bob', 0.5, 30, 0.5),
    ]);
    expect(ranked.map((r) => r.slug)).toEqual(['alice', 'bob', 'zoe']);
  });

  // Case 10: contract shape — public exports exist and have expected types
  it('public surface: rankCandidates / findExperts / runWhoknows are functions', () => {
    expect(typeof rankCandidates).toBe('function');
    expect(typeof findExperts).toBe('function');
    expect(typeof runWhoknows).toBe('function');
  });
});

describe('whoknows / rankCandidates — ranking sanity', () => {
  it('higher raw_match outranks lower (with all else equal)', () => {
    const ranked = rankCandidates([
      input('low-match', 0.1, 30, 0.5),
      input('high-match', 0.9, 30, 0.5),
    ]);
    expect(ranked[0].slug).toBe('high-match');
  });

  it('more recent outranks older (with all else equal)', () => {
    const ranked = rankCandidates([
      input('old', 0.5, 365, 0.5),
      input('recent', 0.5, 7, 0.5),
    ]);
    expect(ranked[0].slug).toBe('recent');
  });

  it('higher salience outranks lower (with all else equal)', () => {
    const ranked = rankCandidates([
      input('low-salience', 0.5, 30, 0.1),
      input('high-salience', 0.5, 30, 0.9),
    ]);
    expect(ranked[0].slug).toBe('high-salience');
  });

  it('all-zero candidate scores 0 but still appears in the result set', () => {
    const ranked = rankCandidates([input('flat', 0, 365 * 10, 0)]);
    expect(ranked.length).toBe(1);
    expect(ranked[0].score).toBe(0);
  });
});

describe('whoknows / rankCandidates — composite key safety', () => {
  it('preserves source_id on each result row', () => {
    const ranked = rankCandidates([
      { slug: 'alice', source_id: 'srcA', title: 'Alice', type: 'person', raw_match: 0.5, days_since_effective: 30, salience_raw: 0.5 },
      { slug: 'alice', source_id: 'srcB', title: 'Alice B', type: 'person', raw_match: 0.6, days_since_effective: 30, salience_raw: 0.5 },
    ]);
    // Both rows preserved with their source_ids — composite key intact.
    expect(ranked.length).toBe(2);
    const sources = new Set(ranked.map((r) => r.source_id));
    expect(sources.has('srcA')).toBe(true);
    expect(sources.has('srcB')).toBe(true);
  });
});

describe('whoknows / rankCandidates — factor decomposition', () => {
  it('returns the exact factor breakdown for a known input', () => {
    // expertise = log(1 + 0.5) ≈ 0.405
    // recency_decay = exp(-30/180) ≈ 0.846
    // salience_factor = 0.5 + 0.5*0.5 = 0.75
    // score ≈ 0.405 * 0.846 * 0.75 ≈ 0.257
    const [row] = rankCandidates([input('alice', 0.5, 30, 0.5)]);
    expect(row.factors.expertise).toBeCloseTo(Math.log1p(0.5), 5);
    expect(row.factors.recency_decay).toBeCloseTo(Math.exp(-30 / 180), 5);
    expect(row.factors.recency_factor).toBeCloseTo(Math.exp(-30 / 180), 5);
    expect(row.factors.salience_factor).toBeCloseTo(0.75, 5);
    expect(row.score).toBeCloseTo(Math.log1p(0.5) * Math.exp(-30 / 180) * 0.75, 5);
  });
});

// Case-marker comment: the 10 ENG-D3 cases live above (1-10 in the
// "locked shadow paths" describe block). The additional describes cover
// ranking sanity and source-id safety beyond the locked minimum.
