/**
 * #6712 PR 4a: the convergence bench's pure helpers (scripts/bench/sync-convergence-lib.ts): nearest-rank
 * percentiles, per-read breakdowns and the deterministic fixture generator.
 */
import { describe, expect, test } from 'bun:test';
import { breakdown, fixtureContent, fixturePath, percentile, summarize } from '../scripts/bench/sync-convergence-lib.ts';

describe('nearest-rank statistics', () => {
  test('percentile picks the smallest sample with at least p% at or below it', () => {
    const xs = [5, 1, 4, 2, 3, 7, 6];
    expect(percentile(xs, 50)).toBe(4);
    expect(percentile(xs, 95)).toBe(7);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19);
    expect(percentile([9], 0)).toBe(9);
    expect(percentile([], 95)).toBeNull();
  });
  test('summarize rounds to 0.1 ms and reports n', () => {
    expect(summarize([1.04, 2.06, 3.01])).toEqual({ n: 3, p50: 2.1, p95: 3, max: 3, mean: 2 });
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null, max: null, mean: null });
  });
  test('breakdown summarizes each read over the rounds that carry it', () => {
    const b = breakdown([{ T: 10, X: 1 }, { T: 30 }, { T: 20, X: 3 }]);
    expect(Object.keys(b)).toEqual(['T', 'X']);
    expect(b.T).toMatchObject({ n: 3, p50: 20, max: 30 });
    expect(b.X).toMatchObject({ n: 2, p50: 1, max: 3 });
  });
});

describe('fixture generator', () => {
  test('paths fan out over two 100-way directory levels', () => {
    expect(fixturePath(0)).toBe('d00/e00/note-0.md');
    expect(fixturePath(123456)).toBe('d56/e34/note-123456.md');
  });
  test('content is deterministic synthetic Markdown of 1-2 KB, and a drift edit changes it', () => {
    for (const i of [0, 1, 999, 60_999, 599_999]) {
      const bytes = fixtureContent(i);
      expect(bytes.equals(fixtureContent(i))).toBe(true);
      expect(bytes.length).toBeGreaterThanOrEqual(1024);
      expect(bytes.length).toBeLessThanOrEqual(2200);
      expect(bytes.toString('utf8').startsWith(`---\ntitle: Note ${i}\n---\n`)).toBe(true);
      expect(fixtureContent(i, 0).equals(bytes)).toBe(false);
    }
  });
});
