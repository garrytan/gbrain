/**
 * Pure-function tests for src/core/contextual-retrieval-service.ts.
 *
 * The full service test (PHASE 1 + PHASE 2 happy path, refusal restart,
 * transient error propagation) needs a real PGLite + gateway stub seam.
 * That lands in test/e2e/contextual-retrieval.test.ts. This file pins
 * the service's pure helpers: corpus_generation hash composition + the
 * expectedMode helper used by the T9 reindex sweep predicate.
 */

import { describe, test, expect } from 'bun:test';
import {
  computeCorpusGeneration,
  computeSourceTextHash,
  expectedModeForPageSourceOnly,
  TITLE_WRAPPER_VERSION,
} from '../src/core/contextual-retrieval-service.ts';

describe('computeCorpusGeneration', () => {
  test('returns 16-char hex hash', () => {
    const h = computeCorpusGeneration({
      crMode: 'title',
      haikuModel: 'anthropic:claude-haiku-4-5-20251001',
    });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  test('deterministic for same inputs', () => {
    const h1 = computeCorpusGeneration({
      crMode: 'per_chunk_synopsis',
      haikuModel: 'anthropic:claude-haiku-4-5-20251001',
    });
    const h2 = computeCorpusGeneration({
      crMode: 'per_chunk_synopsis',
      haikuModel: 'anthropic:claude-haiku-4-5-20251001',
    });
    expect(h1).toBe(h2);
  });

  test('different mode → different hash', () => {
    const haikuModel = 'anthropic:claude-haiku-4-5-20251001';
    const a = computeCorpusGeneration({ crMode: 'title', haikuModel });
    const b = computeCorpusGeneration({ crMode: 'per_chunk_synopsis', haikuModel });
    const c = computeCorpusGeneration({ crMode: 'none', haikuModel });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  test('different model → different hash', () => {
    const a = computeCorpusGeneration({
      crMode: 'title',
      haikuModel: 'anthropic:claude-haiku-4-5-20251001',
    });
    const b = computeCorpusGeneration({
      crMode: 'title',
      haikuModel: 'anthropic:claude-haiku-future-model',
    });
    expect(a).not.toBe(b);
  });

  test('TITLE_WRAPPER_VERSION is stable across reads', () => {
    // Bump this constant only when changing the wrapper text shape.
    // The hash composition includes it so a future change invalidates
    // prior cache entries.
    expect(TITLE_WRAPPER_VERSION).toBe(1);
  });
});

describe('computeSourceTextHash', () => {
  test('returns 16-char hex', () => {
    expect(computeSourceTextHash('any text')).toMatch(/^[0-9a-f]{16}$/);
  });

  test('deterministic', () => {
    const a = computeSourceTextHash('source text');
    const b = computeSourceTextHash('source text');
    expect(a).toBe(b);
  });

  test('different text → different hash (D27 P1-4 cache invalidation)', () => {
    const a = computeSourceTextHash('original page body');
    const b = computeSourceTextHash('edited page body');
    expect(a).not.toBe(b);
  });

  test('empty input still produces a hash', () => {
    expect(computeSourceTextHash('')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('expectedModeForPageSourceOnly (T9 reindex sweep helper)', () => {
  test('kill switch returns none regardless of source/global', () => {
    expect(
      expectedModeForPageSourceOnly({
        source: { id: 'default', contextual_retrieval_mode: 'per_chunk_synopsis' },
        globalMode: 'per_chunk_synopsis',
        killSwitchDisabled: true,
      }),
    ).toBe('none');
  });

  test('source override beats global when set', () => {
    expect(
      expectedModeForPageSourceOnly({
        source: { id: 'team', contextual_retrieval_mode: 'title' },
        globalMode: 'per_chunk_synopsis',
      }),
    ).toBe('title');
  });

  test('global wins when source override is null', () => {
    expect(
      expectedModeForPageSourceOnly({
        source: { id: 'team', contextual_retrieval_mode: null },
        globalMode: 'per_chunk_synopsis',
      }),
    ).toBe('per_chunk_synopsis');
  });

  test('invalid source override (typo) falls through to global', () => {
    expect(
      expectedModeForPageSourceOnly({
        source: { id: 'team', contextual_retrieval_mode: 'per_chunk' as string },
        globalMode: 'title',
      }),
    ).toBe('title');
  });

  test('all three CR modes round-trip through source override', () => {
    for (const mode of ['none', 'title', 'per_chunk_synopsis'] as const) {
      expect(
        expectedModeForPageSourceOnly({
          source: { id: 'team', contextual_retrieval_mode: mode },
          globalMode: 'none',
        }),
      ).toBe(mode);
    }
  });
});
