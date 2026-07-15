/**
 * v0.34 W7 — per-op graph metrics tests.
 * Pure-function tests; no engine needed.
 */
import { describe, test, expect } from 'bun:test';
import {
  nodeSetJaccard,
  depthGroupStability,
  truncationMatch,
  adjustedRandIndex,
  compareCodeWalk,
} from '../../src/core/eval-capture-graph.ts';

describe('W7: nodeSetJaccard', () => {
  test('identical sets → 1.0', () => {
    const a = [{ symbol: 'foo' }, { symbol: 'bar' }];
    const b = [{ symbol: 'foo' }, { symbol: 'bar' }];
    expect(nodeSetJaccard(a, b)).toBe(1);
  });

  test('disjoint sets → 0', () => {
    expect(nodeSetJaccard([{ symbol: 'a' }], [{ symbol: 'b' }])).toBe(0);
  });

  test('partial overlap (3 shared of 4 total)', () => {
    const a = [{ symbol: 'x' }, { symbol: 'y' }, { symbol: 'z' }];
    const b = [{ symbol: 'x' }, { symbol: 'y' }, { symbol: 'w' }];
    // intersection=2, union=4 → 0.5
    expect(nodeSetJaccard(a, b)).toBe(0.5);
  });

  test('both empty → NaN (degenerate)', () => {
    expect(Number.isNaN(nodeSetJaccard([], []))).toBe(true);
  });

  test('one empty → 0', () => {
    expect(nodeSetJaccard([], [{ symbol: 'foo' }])).toBe(0);
  });

  test('file + line distinguish same-name symbols', () => {
    const a = [{ symbol: 'foo', file: 'a.ts', line: 1 }];
    const b = [{ symbol: 'foo', file: 'a.ts', line: 2 }];
    expect(nodeSetJaccard(a, b)).toBe(0);
  });

  test('dedup within a single side', () => {
    const a = [{ symbol: 'foo' }, { symbol: 'foo' }];
    const b = [{ symbol: 'foo' }];
    expect(nodeSetJaccard(a, b)).toBe(1);
  });
});

describe('W7: depthGroupStability', () => {
  test('all nodes in same depth → 1.0', () => {
    const a = [{ depth: 1, nodes: [{ symbol: 'a' }, { symbol: 'b' }] }];
    const b = [{ depth: 1, nodes: [{ symbol: 'a' }, { symbol: 'b' }] }];
    expect(depthGroupStability(a, b)).toBe(1);
  });

  test('one node moved buckets → 0.5 with 2 nodes', () => {
    const a = [{ depth: 1, nodes: [{ symbol: 'a' }, { symbol: 'b' }] }];
    const b = [
      { depth: 1, nodes: [{ symbol: 'a' }] },
      { depth: 2, nodes: [{ symbol: 'b' }] },
    ];
    expect(depthGroupStability(a, b)).toBe(0.5);
  });

  test('both empty → 1.0', () => {
    expect(depthGroupStability([], [])).toBe(1);
  });

  test('completely reshuffled → 0', () => {
    const a = [{ depth: 1, nodes: [{ symbol: 'a' }] }];
    const b = [{ depth: 2, nodes: [{ symbol: 'a' }] }];
    expect(depthGroupStability(a, b)).toBe(0);
  });
});

describe('W7: truncationMatch', () => {
  test('both none → 1', () => {
    expect(truncationMatch('none', 'none')).toBe(1);
    expect(truncationMatch(undefined, undefined)).toBe(1);
  });

  test('mismatch → 0', () => {
    expect(truncationMatch('max_nodes', 'depth_cap')).toBe(0);
  });

  test('undefined treated as none', () => {
    expect(truncationMatch('none', undefined)).toBe(1);
  });
});

describe('W7: adjustedRandIndex', () => {
  test('identical clusterings → 1', () => {
    const a = ['A', 'A', 'B', 'B'];
    const b = ['X', 'X', 'Y', 'Y'];
    // Same partition, different labels — ARI should be 1.
    expect(adjustedRandIndex(a, b)).toBeCloseTo(1, 5);
  });

  test('all items in one cluster vs all in distinct → expected 0', () => {
    const a = ['A', 'A', 'A', 'A'];
    const b = ['W', 'X', 'Y', 'Z'];
    // Singleton vs single-group clustering: ARI should be 0 (no agreement
    // beyond chance).
    const ari = adjustedRandIndex(a, b);
    expect(ari).toBeCloseTo(0, 5);
  });

  test('equal-length contract enforced', () => {
    expect(() => adjustedRandIndex(['A'], ['X', 'Y'])).toThrow(/equal length/);
  });

  test('singleton input → 1.0', () => {
    expect(adjustedRandIndex(['A'], ['X'])).toBe(1);
  });
});

describe('W7: compareCodeWalk', () => {
  test('shared depth_groups → high jaccard + stability', () => {
    const a = {
      depth_groups: [{ depth: 1, nodes: [{ symbol: 'x' }, { symbol: 'y' }] }],
      truncation: 'none',
    };
    const b = {
      depth_groups: [{ depth: 1, nodes: [{ symbol: 'x' }, { symbol: 'y' }] }],
      truncation: 'none',
    };
    const cmp = compareCodeWalk(a, b);
    expect(cmp.jaccard).toBe(1);
    expect(cmp.depth_stability).toBe(1);
    expect(cmp.truncation_match).toBe(1);
  });

  test('no overlap → low jaccard, full reshuffle → low stability', () => {
    const a = {
      depth_groups: [{ depth: 1, nodes: [{ symbol: 'x' }] }],
      truncation: 'none',
    };
    const b = {
      depth_groups: [{ depth: 1, nodes: [{ symbol: 'y' }] }],
      truncation: 'max_nodes',
    };
    const cmp = compareCodeWalk(a, b);
    expect(cmp.jaccard).toBe(0);
    expect(cmp.truncation_match).toBe(0);
  });
});
