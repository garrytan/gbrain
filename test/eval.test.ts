/**
 * Unit tests for src/core/search/eval.ts
 *
 * Pure function tests — no database, no API keys, runs in: bun test
 */

import { describe, test, expect } from 'bun:test';
import {
  precisionAtK,
  recallAtK,
  mrr,
  ndcgAtK,
  parseQrels,
} from '../src/core/search/eval.ts';

// ─────────────────────────────────────────────────────────────────
// precisionAtK
// ─────────────────────────────────────────────────────────────────

describe('precisionAtK', () => {
  test('all hits relevant → 1.0', () => {
    const relevant = new Set(['a', 'b', 'c']);
    expect(precisionAtK(['a', 'b', 'c'], relevant, 3)).toBe(1.0);
  });

  test('no hits relevant → 0.0', () => {
    const relevant = new Set(['x', 'y']);
    expect(precisionAtK(['a', 'b', 'c'], relevant, 3)).toBe(0.0);
  });

  test('partial: 2 of 5 hits relevant at k=5', () => {
    const relevant = new Set(['a', 'c']);
    expect(precisionAtK(['a', 'b', 'c', 'd', 'e'], relevant, 5)).toBeCloseTo(2 / 5);
  });

  test('k=1 with first hit relevant → 1.0', () => {
    const relevant = new Set(['a']);
    expect(precisionAtK(['a', 'b', 'c'], relevant, 1)).toBe(1.0);
  });

  test('k=1 with first hit not relevant → 0.0', () => {
    const relevant = new Set(['b']);
    expect(precisionAtK(['a', 'b', 'c'], relevant, 1)).toBe(0.0);
  });

  test('k greater than hits length → uses actual hits', () => {
    const relevant = new Set(['a', 'b']);
    // 2 relevant in 2 hits but k=10 → still 2/10
    expect(precisionAtK(['a', 'b'], relevant, 10)).toBeCloseTo(2 / 10);
  });

  test('empty hits → 0', () => {
    expect(precisionAtK([], new Set(['a']), 5)).toBe(0);
  });

  test('empty relevant set → 0', () => {
    expect(precisionAtK(['a', 'b'], new Set(), 5)).toBe(0);
  });

  test('k=0 → 0', () => {
    expect(precisionAtK(['a', 'b'], new Set(['a']), 0)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// recallAtK
// ─────────────────────────────────────────────────────────────────

describe('recallAtK', () => {
  test('all relevant found → 1.0', () => {
    const relevant = new Set(['a', 'b']);
    expect(recallAtK(['a', 'b', 'c'], relevant, 3)).toBe(1.0);
  });

  test('none found → 0.0', () => {
    const relevant = new Set(['x', 'y', 'z']);
    expect(recallAtK(['a', 'b', 'c'], relevant, 3)).toBe(0.0);
  });

  test('1 of 3 relevant found', () => {
    const relevant = new Set(['a', 'x', 'y']);
    expect(recallAtK(['a', 'b', 'c'], relevant, 3)).toBeCloseTo(1 / 3);
  });

  test('relevant found beyond k → not counted', () => {
    const relevant = new Set(['a', 'b']);
    // 'b' is at rank 5, beyond k=3
    expect(recallAtK(['a', 'x', 'y', 'z', 'b'], relevant, 3)).toBeCloseTo(1 / 2);
  });

  test('empty hits → 0', () => {
    expect(recallAtK([], new Set(['a']), 5)).toBe(0);
  });

  test('empty relevant set → 0', () => {
    expect(recallAtK(['a', 'b'], new Set(), 5)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// mrr
// ─────────────────────────────────────────────────────────────────

describe('mrr', () => {
  test('first hit relevant → 1.0', () => {
    expect(mrr(['a', 'b', 'c'], new Set(['a']))).toBe(1.0);
  });

  test('second hit relevant → 0.5', () => {
    expect(mrr(['x', 'a', 'c'], new Set(['a']))).toBeCloseTo(0.5);
  });

  test('third hit relevant → 1/3', () => {
    expect(mrr(['x', 'y', 'a'], new Set(['a']))).toBeCloseTo(1 / 3);
  });

  test('no relevant hit → 0', () => {
    expect(mrr(['x', 'y', 'z'], new Set(['a']))).toBe(0);
  });

  test('empty hits → 0', () => {
    expect(mrr([], new Set(['a']))).toBe(0);
  });

  test('empty relevant → 0', () => {
    expect(mrr(['a', 'b'], new Set())).toBe(0);
  });

  test('uses first relevant hit when multiple are relevant', () => {
    // 'b' is rank 2, 'c' is rank 3 — MRR should use 'b' at rank 2
    expect(mrr(['x', 'b', 'c'], new Set(['b', 'c']))).toBeCloseTo(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────
// ndcgAtK
// ─────────────────────────────────────────────────────────────────

describe('ndcgAtK', () => {
  test('perfect ranking with binary relevance → 1.0', () => {
    const grades = new Map([['a', 1], ['b', 1]]);
    // Hits: a at rank1, b at rank2 — same as ideal
    expect(ndcgAtK(['a', 'b', 'c'], grades, 5)).toBeCloseTo(1.0);
  });

  test('single relevant doc at rank 1 → 1.0', () => {
    const grades = new Map([['a', 1]]);
    expect(ndcgAtK(['a', 'x', 'y'], grades, 5)).toBeCloseTo(1.0);
  });

  test('single relevant doc at rank 2 → less than 1', () => {
    const grades = new Map([['a', 1]]);
    const score = ndcgAtK(['x', 'a', 'y'], grades, 5);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  test('no relevant in hits → 0', () => {
    const grades = new Map([['a', 1], ['b', 1]]);
    expect(ndcgAtK(['x', 'y', 'z'], grades, 5)).toBe(0);
  });

  test('graded relevance: higher grade docs placed first → nDCG=1', () => {
    const grades = new Map([['a', 3], ['b', 2], ['c', 1]]);
    expect(ndcgAtK(['a', 'b', 'c'], grades, 3)).toBeCloseTo(1.0);
  });

  test('graded relevance: lower grade first → nDCG < 1', () => {
    const grades = new Map([['a', 3], ['b', 2], ['c', 1]]);
    // Reversed: worst first
    const score = ndcgAtK(['c', 'b', 'a'], grades, 3);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  test('graded relevance: reversed is worse than perfect', () => {
    const grades = new Map([['a', 3], ['b', 2], ['c', 1]]);
    const perfect = ndcgAtK(['a', 'b', 'c'], grades, 3);
    const reversed = ndcgAtK(['c', 'b', 'a'], grades, 3);
    expect(perfect).toBeGreaterThan(reversed);
  });

  test('k=1 picks only the first hit', () => {
    const grades = new Map([['a', 1], ['b', 1]]);
    // Only 'x' at rank1, not relevant
    expect(ndcgAtK(['x', 'a', 'b'], grades, 1)).toBe(0);
    // Only 'a' at rank1, relevant
    expect(ndcgAtK(['a', 'x', 'b'], grades, 1)).toBeCloseTo(1.0);
  });

  test('empty hits → 0', () => {
    expect(ndcgAtK([], new Map([['a', 1]]), 5)).toBe(0);
  });

  test('empty grades → 0', () => {
    expect(ndcgAtK(['a', 'b'], new Map(), 5)).toBe(0);
  });

  test('k=0 → 0', () => {
    expect(ndcgAtK(['a', 'b'], new Map([['a', 1]]), 0)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// parseQrels
// ─────────────────────────────────────────────────────────────────

describe('parseQrels', () => {
  test('parses inline JSON array', () => {
    const input = JSON.stringify([
      { query: 'foo', relevant: ['a', 'b'] },
    ]);
    const result = parseQrels(input);
    expect(result).toHaveLength(1);
    expect(result[0].query).toBe('foo');
    expect(result[0].relevant).toEqual(['a', 'b']);
  });

  test('parses inline JSON object with queries array', () => {
    const input = JSON.stringify({
      version: 1,
      queries: [{ query: 'bar', relevant: ['x'] }],
    });
    const result = parseQrels(input);
    expect(result).toHaveLength(1);
    expect(result[0].query).toBe('bar');
  });

  test('preserves grades when present', () => {
    const input = JSON.stringify([
      { query: 'baz', relevant: ['a'], grades: { a: 3, b: 1 } },
    ]);
    const result = parseQrels(input);
    expect(result[0].grades).toEqual({ a: 3, b: 1 });
  });

  test('throws on invalid JSON', () => {
    expect(() => parseQrels('not-json')).toThrow();
  });

  test('throws on unrecognized format', () => {
    expect(() => parseQrels(JSON.stringify({ foo: 'bar' }))).toThrow();
  });
});
