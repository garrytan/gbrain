/**
 * Cross-source tier breakdown tests (M6).
 */

import { describe, test, expect } from 'bun:test';
import {
  buildSourceTierBreakdown,
  classifySlugTier,
} from '../src/core/eval-contradictions/cross-source.ts';
import type { ContradictionPair } from '../src/core/eval-contradictions/types.ts';

function mkPair(slugA: string, slugB: string): ContradictionPair {
  return {
    kind: 'cross_slug_chunks',
    a: { slug: slugA, chunk_id: 1, take_id: null, source_tier: 'curated', holder: null, text: 'a', effective_date: null, effective_date_source: null },
    b: { slug: slugB, chunk_id: 2, take_id: null, source_tier: 'curated', holder: null, text: 'b', effective_date: null, effective_date_source: null },
    combined_score: 1,
  };
}

describe('classifySlugTier', () => {
  test('curated prefixes (boost > 1.0)', () => {
    expect(classifySlugTier('originals/talks/foo')).toBe('curated');
    expect(classifySlugTier('concepts/widget')).toBe('curated');
    expect(classifySlugTier('writing/essay-1')).toBe('curated');
    expect(classifySlugTier('people/alice')).toBe('curated');
    expect(classifySlugTier('companies/acme')).toBe('curated');
  });

  test('bulk prefixes (boost < 1.0)', () => {
    expect(classifySlugTier('daily/2026-05-10')).toBe('bulk');
    expect(classifySlugTier('media/x/post-123')).toBe('bulk');
    expect(classifySlugTier('openclaw/chat/session-1')).toBe('bulk');
  });

  test('baseline prefixes map to other (boost = 1.0)', () => {
    expect(classifySlugTier('yc/something')).toBe('other');
    expect(classifySlugTier('civic/whatever')).toBe('other');
  });

  test('unknown prefix maps to other', () => {
    expect(classifySlugTier('made-up-prefix/page')).toBe('other');
    expect(classifySlugTier('random/thing')).toBe('other');
  });

  test('empty slug maps to other', () => {
    expect(classifySlugTier('')).toBe('other');
  });

  test('longest-prefix-match wins', () => {
    // media/articles/ is curated (1.1), media/x/ is bulk (0.7).
    expect(classifySlugTier('media/articles/foo')).toBe('curated');
    expect(classifySlugTier('media/x/bar')).toBe('bulk');
  });

  test('case-insensitive', () => {
    expect(classifySlugTier('Originals/Talks/Foo')).toBe('curated');
    expect(classifySlugTier('OPENCLAW/CHAT/whatever')).toBe('bulk');
  });
});

describe('buildSourceTierBreakdown', () => {
  test('empty input yields all zeros', () => {
    const out = buildSourceTierBreakdown([]);
    expect(out).toEqual({
      curated_vs_curated: 0,
      curated_vs_bulk: 0,
      bulk_vs_bulk: 0,
      other: 0,
    });
  });

  test('curated_vs_curated counts both-curated pairs', () => {
    const out = buildSourceTierBreakdown([
      mkPair('originals/a', 'concepts/b'),
      mkPair('people/x', 'companies/y'),
    ]);
    expect(out.curated_vs_curated).toBe(2);
    expect(out.curated_vs_bulk).toBe(0);
  });

  test('curated_vs_bulk counts mixed pairs (order-independent)', () => {
    const out = buildSourceTierBreakdown([
      mkPair('originals/a', 'daily/2026-05-10'),
      mkPair('openclaw/chat/session-1', 'people/alice'),
    ]);
    expect(out.curated_vs_bulk).toBe(2);
    expect(out.curated_vs_curated).toBe(0);
    expect(out.bulk_vs_bulk).toBe(0);
  });

  test('bulk_vs_bulk counts both-bulk pairs', () => {
    const out = buildSourceTierBreakdown([
      mkPair('daily/2026-05-10', 'openclaw/chat/session-1'),
    ]);
    expect(out.bulk_vs_bulk).toBe(1);
  });

  test('other catches unrecognized prefixes', () => {
    const out = buildSourceTierBreakdown([
      mkPair('random/foo', 'yc/bar'),
      mkPair('made-up/x', 'civic/y'),
    ]);
    expect(out.other).toBe(2);
  });

  test('mixed input correctly partitions', () => {
    const out = buildSourceTierBreakdown([
      mkPair('originals/a', 'concepts/b'),    // curated_vs_curated
      mkPair('people/x', 'openclaw/chat/y'),  // curated_vs_bulk
      mkPair('daily/x', 'media/x/y'),         // bulk_vs_bulk
      mkPair('yc/x', 'civic/y'),              // other (both baseline)
    ]);
    expect(out.curated_vs_curated).toBe(1);
    expect(out.curated_vs_bulk).toBe(1);
    expect(out.bulk_vs_bulk).toBe(1);
    expect(out.other).toBe(1);
  });
});
