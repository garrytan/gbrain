import { expect, test } from 'bun:test';
import { compareRelevance, latencyPercentiles, rankDocuments, summarizeRelevance } from './metrics.ts';

const vector = (...values: number[]) => new Float32Array(values);

test('ranks by maximum chunk cosine and uses document ID for ties', () => {
  const ranked = rankDocuments(vector(1, 0), [
    { id: 'z', chunks: [vector(0, 1), vector(1, 0)] },
    { id: 'b', chunks: [vector(1, 0)] },
    { id: 'a', chunks: [vector(1, 0)] },
  ]);
  expect(ranked).toEqual([
    { id: 'a', score: 1 }, { id: 'b', score: 1 }, { id: 'z', score: 1 },
  ]);
});

test('reports multi-label relevance hits and per-query gains/regressions', () => {
  const queries = [
    { id: 'one', ranked: [{ id: 'a', score: 1 }, { id: 'b', score: 0 }], relevant: ['a', 'b'] },
    { id: 'two', ranked: [{ id: 'x', score: 1 }], relevant: ['y'] },
  ];
  const topTwo = summarizeRelevance(queries, 2);
  expect(topTwo.perQuery[0]).toEqual({ id: 'one', relevantHits: 2, relevantCount: 2, hit: true });
  expect(topTwo).toMatchObject({ hitQueries: 1, hitRate: 0.5, relevantHits: 2, relevantCount: 3 });
  expect(compareRelevance(
    [{ id: 'one', hit: true }, { id: 'two', hit: false }],
    [{ id: 'one', hit: false }, { id: 'two', hit: true }],
  )).toEqual({ gains: ['two'], regressions: ['one'], unchanged: 0 });
});

test('uses nearest-rank median and p95 without mutating samples', () => {
  const samples = [90, 10, 50, 30, 70];
  expect(latencyPercentiles(samples)).toEqual({ samples: [90, 10, 50, 30, 70], medianMs: 50, p95Ms: 90 });
  expect(samples).toEqual([90, 10, 50, 30, 70]);
  expect(latencyPercentiles([])).toEqual({ samples: [], medianMs: null, p95Ms: null });
});
