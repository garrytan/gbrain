/**
 * v0.31.2 — facts/eligibility.ts predicate tests.
 *
 * Pin the contract so future changes are intentional:
 *   - Type-only branch: parsed.type ∈ ELIGIBLE_TYPES is enough.
 *   - Slug-only branch: meetings/, personal/, daily/ rescue mistyped pages.
 *   - Both branches: typed AND slug-prefixed → still ok.
 *   - Neither: rejected with kind:<type> reason.
 *   - Negative paths: null parsed, wiki/agents/, dream_generated, too_short.
 *
 * Pure-function tests; no DB.
 */

import { describe, test, expect } from 'bun:test';
import { isFactsBackstopEligible } from '../src/core/facts/eligibility.ts';
import type { PageType } from '../src/core/types.ts';

const LONG_BODY = 'x'.repeat(120); // > 80 char threshold

function fixture(overrides: {
  slug?: string;
  type?: PageType;
  body?: string;
  frontmatter?: Record<string, unknown>;
} = {}) {
  return {
    slug: overrides.slug ?? 'meetings/2026-05-09-call',
    parsed: {
      type: overrides.type ?? 'meeting' as PageType,
      compiled_truth: overrides.body ?? LONG_BODY,
      frontmatter: overrides.frontmatter ?? {},
    },
  };
}

describe('isFactsBackstopEligible — branches', () => {
  test('TYPED-ONLY: type=meeting, slug=arbitrary → ok', () => {
    const f = fixture({ slug: 'wiki/x/y', type: 'meeting' });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: true });
  });

  test('SLUG-ONLY: type=note (legacy default), slug=meetings/... → ok via rescue', () => {
    const f = fixture({ slug: 'meetings/2026-05-09', type: 'note' });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: true });
  });

  test('SLUG-ONLY: type=note, slug=personal/... → ok', () => {
    const f = fixture({ slug: 'personal/journal-entry', type: 'note' });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: true });
  });

  test('SLUG-ONLY: type=note, slug=daily/2026-05-09 → ok', () => {
    const f = fixture({ slug: 'daily/2026-05-09', type: 'note' });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: true });
  });

  test('BOTH: type=meeting, slug=meetings/... → ok', () => {
    const f = fixture({ slug: 'meetings/2026-05-09', type: 'meeting' });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: true });
  });

  test('NEITHER: type=concept, slug=concepts/... → rejected with kind:concept reason', () => {
    const f = fixture({ slug: 'concepts/abstract-thing', type: 'concept' });
    const r = isFactsBackstopEligible(f.slug, f.parsed);
    expect(r).toEqual({ ok: false, reason: 'kind:concept' });
  });
});

describe('isFactsBackstopEligible — guards', () => {
  test('null parsed → no_parsed_page', () => {
    expect(isFactsBackstopEligible('any/slug', null)).toEqual({ ok: false, reason: 'no_parsed_page' });
  });

  test('undefined parsed → no_parsed_page', () => {
    expect(isFactsBackstopEligible('any/slug', undefined)).toEqual({ ok: false, reason: 'no_parsed_page' });
  });

  test('subagent namespace (wiki/agents/...) is rejected even with eligible type', () => {
    const f = fixture({ slug: 'wiki/agents/sonnet-1/scratch', type: 'meeting' });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: false, reason: 'subagent_namespace' });
  });

  test('dream_generated:true frontmatter is rejected (anti-loop)', () => {
    const f = fixture({
      slug: 'meetings/dream-output',
      type: 'meeting',
      frontmatter: { dream_generated: true },
    });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: false, reason: 'dream_generated' });
  });

  test('dream_generated:false (or missing) is fine', () => {
    const f = fixture({
      slug: 'meetings/normal-page',
      type: 'meeting',
      frontmatter: { dream_generated: false },
    });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: true });
  });

  test('body < 80 chars → too_short', () => {
    const f = fixture({ body: 'TODO: write meeting notes' });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: false, reason: 'too_short' });
  });

  test('body exactly 80 chars → ok', () => {
    const f = fixture({ body: 'a'.repeat(80) });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: true });
  });

  test('whitespace body collapses to too_short after trim', () => {
    const f = fixture({ body: '   \n   \t   ' });
    expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: false, reason: 'too_short' });
  });
});

describe('isFactsBackstopEligible — eligible-types coverage', () => {
  for (const t of ['note', 'meeting', 'slack', 'email', 'calendar-event', 'source', 'writing'] as PageType[]) {
    test(`type=${t} on arbitrary slug → ok`, () => {
      const f = fixture({ slug: 'wiki/whatever/x', type: t });
      expect(isFactsBackstopEligible(f.slug, f.parsed)).toEqual({ ok: true });
    });
  }

  for (const t of ['person', 'company', 'deal', 'concept', 'project', 'image', 'code'] as PageType[]) {
    test(`type=${t} on non-rescued slug → rejected with kind:${t}`, () => {
      const f = fixture({ slug: 'wiki/whatever/x', type: t });
      const r = isFactsBackstopEligible(f.slug, f.parsed);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(`kind:${t}`);
    });
  }
});
