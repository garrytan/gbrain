/**
 * v0.42.x — Life Chronicle (#2390) E1 temporal recall boost (Phase A.4).
 * Pure-function test of applyChronicleTypeBoost: boosts event/diary on temporal
 * queries, leaves everything else untouched (the no-regression guarantee — the
 * function is only CALLED when recency !== 'off', and even then only moves
 * chronicle types).
 */
import { describe, test, expect } from 'bun:test';
import { applyChronicleTypeBoost } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';

function r(slug: string, type: string, score = 1.0): SearchResult {
  return {
    slug, page_id: 1, title: slug, type, chunk_text: '', chunk_source: 'compiled_truth',
    chunk_id: 1, chunk_index: 0, score, stale: false,
  } as SearchResult;
}

describe('applyChronicleTypeBoost', () => {
  test('boosts event + diary, leaves other types untouched', () => {
    const rows = [r('life/events/a', 'event'), r('life/diary/b', 'diary'), r('wiki/note', 'note'), r('people/x', 'person')];
    applyChronicleTypeBoost(rows, 'on');
    expect(rows[0].score).toBeCloseTo(1.15);
    expect(rows[0].chronicle_boost).toBeCloseTo(1.15);
    expect(rows[1].score).toBeCloseTo(1.15);
    expect(rows[2].score).toBe(1.0); // note unchanged
    expect(rows[2].chronicle_boost).toBeUndefined();
    expect(rows[3].score).toBe(1.0); // person unchanged
  });

  test('strong uses a larger factor', () => {
    const rows = [r('life/events/a', 'event')];
    applyChronicleTypeBoost(rows, 'strong');
    expect(rows[0].score).toBeCloseTo(1.25);
  });

  test('floor gate skips low-score results', () => {
    const rows = [r('life/events/a', 'event', 0.1)];
    applyChronicleTypeBoost(rows, 'on', 0.5); // 0.1 < floor 0.5 → skipped
    expect(rows[0].score).toBe(0.1);
    expect(rows[0].chronicle_boost).toBeUndefined();
  });
});
