/**
 * #4256/#3695 — compiledTruthBoost predicate boundaries.
 *
 * The title arm COALESCEs a page with no text chunk into a synthetic row
 * (chunk_id 0 + empty chunk_text). Such a row has no real compiled_truth chunk
 * and must not gain the 2x chunk-authority boost; every other compiled_truth
 * row still does. The predicate is `chunk_id === 0 AND trimmed text empty` —
 * BOTH halves must hold, so a chunk_id-0 row with real text and a nonzero
 * chunk with (unusually) empty text both keep the boost. Pure, no engine.
 */
import { describe, test, expect } from 'bun:test';
import { compiledTruthBoost } from '../../src/core/search/hybrid.ts';
import type { SearchResult } from '../../src/core/types.ts';

function row(extra: Partial<SearchResult>): SearchResult {
  return {
    slug: 'notes/x', title: 'X', score: 1, type: 'note', source_id: 'default',
    chunk_index: 0, chunk_id: 1, chunk_source: 'compiled_truth', chunk_text: 'real body text',
    ...extra,
  } as unknown as SearchResult;
}

describe('compiledTruthBoost — synthetic-title-row predicate boundaries', () => {
  test('chunk_id 0 + real text IS boosted (a genuine first chunk)', () => {
    expect(compiledTruthBoost(row({ chunk_id: 0, chunk_text: 'real body text' }), true)).toBeGreaterThan(1);
  });

  test('nonzero chunk_id + empty text IS boosted (only the chunk_id-0 synthetic shape is excluded)', () => {
    expect(compiledTruthBoost(row({ chunk_id: 7, chunk_text: '' }), true)).toBeGreaterThan(1);
  });

  test('chunk_id 0 + whitespace-only text is NOT boosted (trimmed-empty counts as empty)', () => {
    expect(compiledTruthBoost(row({ chunk_id: 0, chunk_text: '   \n\t ' }), true)).toBe(1.0);
  });

  test('chunk_id 0 + undefined text is NOT boosted (missing text is the synthetic shape)', () => {
    expect(compiledTruthBoost(row({ chunk_id: 0, chunk_text: undefined }), true)).toBe(1.0);
  });

  test('applyBoost=false, a non-compiled_truth source, and an unverified row all stay at 1.0', () => {
    expect(compiledTruthBoost(row({}), false)).toBe(1.0);
    expect(compiledTruthBoost(row({ chunk_source: 'timeline' }), true)).toBe(1.0);
    expect(compiledTruthBoost(row({ unverified: true }), true)).toBe(1.0);
  });
});
