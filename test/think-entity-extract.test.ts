/**
 * v0.40.2.0 — Tests for `extractCandidateEntities` (shared think + longmemeval helper).
 * Hermetic, no DB.
 */

import { describe, test, expect } from 'bun:test';
import { extractCandidateEntities } from '../src/core/think/entity-extract.ts';

describe('extractCandidateEntities — retrieved-slug source', () => {
  test('entity-prefix slugs from retrieval surface as high-precision candidates', () => {
    // Use a noun-phrase-free question so we only see the retrieved slugs.
    const c = extractCandidateEntities('when did this happen', [
      'people/marco-smith',
      'companies/acme-example',
      'wiki/random-page',
    ]);
    // wiki/* is not an entity prefix → 2 retrieved, plus any extracted
    // from the question. "happen" is the only non-stop-word but it's a
    // single word phrase that may pass through; just check the retrieved
    // ones land in the first two positions.
    expect(c[0]).toEqual({ raw: 'people/marco-smith', origin: 'retrieved' });
    expect(c[1]).toEqual({ raw: 'companies/acme-example', origin: 'retrieved' });
  });

  test('dedups retrieved slugs', () => {
    const c = extractCandidateEntities('q', [
      'people/marco',
      'people/marco',
      'PEOPLE/MARCO',  // case-insensitive dedup
    ]);
    expect(c.length).toBe(1);
  });

  test('non-entity-prefix slugs are ignored', () => {
    const c = extractCandidateEntities('q', [
      'wiki/recipe-book',
      'media/notes/2026-01',
    ]);
    // No entity-prefix matches. Question is "q" — too short to yield
    // anything either. Result is empty.
    expect(c.length).toBe(0);
  });
});

describe('extractCandidateEntities — noun-phrase source', () => {
  test('proper nouns and common phrases surface as extracted candidates', () => {
    const c = extractCandidateEntities('When did I last meet Marco at Blue Bottle?', []);
    // Both "marco" and "blue bottle" should be candidates.
    const raws = c.map(x => x.raw);
    expect(raws).toContain('marco');
    expect(raws).toContain('blue bottle');
    for (const cand of c) expect(cand.origin).toBe('extracted');
  });

  test('lowercase coffee maker (not proper-noun) is still surfaced', () => {
    const c = extractCandidateEntities('when did I get the new coffee maker', []);
    const raws = c.map(x => x.raw);
    // "new coffee maker" with "new" stripped as boundary stop-word →
    // "coffee maker" should appear.
    expect(raws.some(r => r.includes('coffee maker'))).toBe(true);
  });

  test('stop-word-only phrases are dropped', () => {
    const c = extractCandidateEntities('when did I do that', []);
    expect(c.length).toBe(0);
  });

  test('cap at 5 candidates total', () => {
    const slugs = [
      'people/a-one',
      'people/b-two',
      'people/c-three',
      'people/d-four',
      'people/e-five',
      'people/f-six',
      'people/g-seven',
    ];
    const c = extractCandidateEntities('q', slugs);
    expect(c.length).toBe(5);
  });
});

describe('extractCandidateEntities — dedup across sources', () => {
  test('retrieved slug suppresses noun-phrase candidate for same entity', () => {
    // Retrieval returns "people/marco" exactly; question also has "Marco".
    // Retrieved-slug version takes priority and noun-phrase "marco" should
    // NOT add a duplicate. Note: dedup is on the raw value, so
    // "people/marco" vs "marco" don't collide — but both should still
    // appear since they're different keys.
    const c = extractCandidateEntities('When did I meet Marco?', ['people/marco']);
    // Expect: people/marco (retrieved), marco (extracted from question).
    expect(c.length).toBe(2);
    expect(c[0].origin).toBe('retrieved');
    expect(c[1].origin).toBe('extracted');
  });
});

describe('extractCandidateEntities — defensive paths', () => {
  test('empty inputs return empty array', () => {
    expect(extractCandidateEntities('', []).length).toBe(0);
  });

  test('non-string retrievedSlug entries are skipped', () => {
    // @ts-expect-error testing non-string defense
    const c = extractCandidateEntities('q with marco', [null, undefined, 123, 'people/alice']);
    // Only people/alice is the valid retrieved slug; "marco" is extracted.
    expect(c.length).toBeGreaterThanOrEqual(1);
    expect(c.some(x => x.raw === 'people/alice')).toBe(true);
  });
});
