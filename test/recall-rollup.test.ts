/**
 * v0.32 — `gbrain recall --rollup` correctness. Pure-function tests on
 * `computeRollup` (no engine, no I/O).
 *
 * CRITICAL REGRESSIONS pinned here (Codex round 1 #8):
 *   1. Top-K computed over the FULL FactRow[] result, not a LIMIT-100 slice.
 *   2. JSON shape is `{entity_slug, count}` matching
 *      `test/facts-doctor-shape.test.ts:49` — NOT `{slug, count}`.
 */

import { describe, test, expect } from 'bun:test';
import { computeRollup } from '../src/commands/recall.ts';
import type { FactRow } from '../src/core/engine.ts';

function fact(entity_slug: string | null, id = 0): FactRow {
  return {
    id,
    source_id: 'default',
    entity_slug,
    fact: 'test',
    kind: 'fact',
    visibility: 'private',
    notability: 'medium',
    context: null,
    valid_from: new Date(0),
    valid_until: null,
    expired_at: null,
    superseded_by: null,
    consolidated_at: null,
    consolidated_into: null,
    source: 'test',
    source_session: null,
    confidence: 0.5,
    embedding: null,
    embedded_at: null,
    created_at: new Date(0),
  };
}

describe('computeRollup — top-5 over the full window (Codex round 1 #8 regression)', () => {
  test('counts entities across the entire input (not a prefix slice)', () => {
    // Construct 150 rows: 60 with entity_slug='people/alice', 50 with
    // 'people/bob', 30 with 'people/charlie', 10 split across 5 other entities.
    // If computeRollup were operating on a LIMIT-100 prefix of the rows it
    // would mis-rank — but the actual ordering of rows in the input array
    // doesn't preserve the "limit" property anyway, which is the whole point
    // of fixing this in the caller.
    const rows: FactRow[] = [];
    for (let i = 0; i < 60; i++) rows.push(fact('people/alice', 1000 + i));
    for (let i = 0; i < 50; i++) rows.push(fact('people/bob', 2000 + i));
    for (let i = 0; i < 30; i++) rows.push(fact('people/charlie', 3000 + i));
    for (let i = 0; i < 10; i++) rows.push(fact(`people/other-${i}`, 4000 + i));
    expect(rows.length).toBe(150);

    const top = computeRollup(rows);
    expect(top.length).toBe(5);
    expect(top[0]).toEqual({ entity_slug: 'people/alice', count: 60 });
    expect(top[1]).toEqual({ entity_slug: 'people/bob', count: 50 });
    expect(top[2]).toEqual({ entity_slug: 'people/charlie', count: 30 });
    // The remaining 7 'people/other-*' entries each had count=1; top 5 takes
    // 2 of them, sorted by slug for stable output.
    expect(top[3].count).toBe(1);
    expect(top[4].count).toBe(1);
  });

  test('skips facts with null entity_slug (does not turn into a "(no entity)" bucket)', () => {
    const rows: FactRow[] = [
      fact('e/a', 1),
      fact(null, 2),
      fact('e/a', 3),
      fact(null, 4),
      fact('e/b', 5),
    ];
    const top = computeRollup(rows);
    expect(top).toEqual([
      { entity_slug: 'e/a', count: 2 },
      { entity_slug: 'e/b', count: 1 },
    ]);
  });

  test('ties broken by slug alphabetically (stable output)', () => {
    const rows: FactRow[] = [
      fact('e/zebra', 1),
      fact('e/alpha', 2),
      fact('e/zebra', 3),
      fact('e/alpha', 4),
    ];
    const top = computeRollup(rows);
    expect(top.length).toBe(2);
    // Both have count 2; alphabetical tie-break puts 'e/alpha' first.
    expect(top[0].entity_slug).toBe('e/alpha');
    expect(top[1].entity_slug).toBe('e/zebra');
  });

  test('empty input returns empty array', () => {
    expect(computeRollup([])).toEqual([]);
  });

  test('input with only null entity_slug returns empty array', () => {
    expect(computeRollup([fact(null), fact(null)])).toEqual([]);
  });
});

describe('computeRollup JSON shape (Codex round 1 #8 shape-drift regression)', () => {
  test('every row uses the key `entity_slug` (matches engine.getStats and test/facts-doctor-shape.test.ts:49)', () => {
    const rows: FactRow[] = [fact('e/a'), fact('e/b'), fact('e/a')];
    const top = computeRollup(rows);
    for (const row of top) {
      expect(Object.prototype.hasOwnProperty.call(row, 'entity_slug')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(row, 'count')).toBe(true);
      // Defense against future refactors that might introduce a `slug` field:
      expect(Object.prototype.hasOwnProperty.call(row, 'slug')).toBe(false);
    }
  });

  test('count is a plain JS number (not BigInt, not string) so JSON.stringify round-trips cleanly', () => {
    const rows: FactRow[] = [fact('e/a'), fact('e/a'), fact('e/a')];
    const top = computeRollup(rows);
    expect(typeof top[0].count).toBe('number');
    const roundtripped = JSON.parse(JSON.stringify(top));
    expect(roundtripped[0]).toEqual({ entity_slug: 'e/a', count: 3 });
  });
});
