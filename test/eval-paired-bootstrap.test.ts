/**
 * Paired cluster statistics (src/core/eval/paired-bootstrap.ts): the port of
 * the gbrain-evals situation-recall comparator used by `gbrain eval compare`.
 */
import { describe, expect, test } from 'bun:test';
import { holmAdjusted, pairedClusterStatistics } from '../src/core/eval/paired-bootstrap.ts';

const opts = { seed: 42, draws: 10_000 };

describe('pairedClusterStatistics', () => {
  test('exact sign-flip enumeration at 16 or fewer clusters', () => {
    // Five questions, all improved: the two all-same-sign flips out of 2^5
    // are as extreme as observed (two-sided) → p = 2/32.
    const pairs = Array.from({ length: 5 }, (_, i) => ({ cluster: `q${i}`, baseline: 0, candidate: 1 }));
    const st = pairedClusterStatistics(pairs, opts);
    expect(st.p_value).toBe(2 / 32);
    expect(st).toMatchObject({ n: 5, clusters: 5, wins: 5, losses: 0, ties: 0, delta: 1, lower95: 1, upper95: 1 });
  });

  test('no discordant pairs → zero delta, degenerate interval, p = 1', () => {
    const st = pairedClusterStatistics([{ cluster: 'a', baseline: 1, candidate: 1 }, { cluster: 'b', baseline: 0, candidate: 0 }], opts);
    expect(st).toMatchObject({ delta: 0, lower95: 0, upper95: 0, p_value: 1, ties: 2 });
  });

  test('clusters resample whole: rows sharing a cluster move together', () => {
    // One cluster of 10 improvements and 10 singleton ties. Clustered, the
    // 11 clusters give a much wider interval than 20 independent rows would.
    const clustered = [
      ...Array.from({ length: 10 }, () => ({ cluster: 'big', baseline: 0, candidate: 1 })),
      ...Array.from({ length: 10 }, (_, i) => ({ cluster: `t${i}`, baseline: 1, candidate: 1 })),
    ];
    const independent = clustered.map((p, i) => ({ ...p, cluster: `r${i}` }));
    const a = pairedClusterStatistics(clustered, opts);
    const b = pairedClusterStatistics(independent, opts);
    expect(a.clusters).toBe(11);
    expect(a.delta).toBeCloseTo(0.5, 10);
    expect(a.upper95 - a.lower95).toBeGreaterThan(b.upper95 - b.lower95);
    // Exact enumeration over 11 clusters: only the one non-zero cluster
    // matters, so half the flips are as extreme → p = 1.
    expect(a.p_value).toBe(1);
  });

  test('rejects too few draws and non-finite values', () => {
    expect(() => pairedClusterStatistics([{ cluster: 'a', baseline: 0, candidate: 1 }], { seed: 1, draws: 10 })).toThrow();
    expect(() => pairedClusterStatistics([{ cluster: 'a', baseline: Number.NaN, candidate: 1 }], opts)).toThrow();
    expect(() => pairedClusterStatistics([], opts)).toThrow();
  });
});

describe('holmAdjusted', () => {
  test('step-down with monotone enforcement', () => {
    expect(holmAdjusted([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(holmAdjusted([0.5])).toEqual([0.5]);
    expect(holmAdjusted([0.2, 0.9])).toEqual([0.4, 0.9]);
  });
});
