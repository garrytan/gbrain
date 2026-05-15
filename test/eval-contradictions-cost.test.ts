/**
 * Cost tracker tests — pre-flight estimator + mid-run cumulative + cap behavior.
 */

import { describe, test, expect } from 'bun:test';
import {
  CostTracker,
  estimateUpperBoundCost,
} from '../src/core/eval-contradictions/cost-tracker.ts';

describe('estimateUpperBoundCost', () => {
  test('zero pairs and zero queries → ~zero cost', () => {
    const c = estimateUpperBoundCost({
      pairCount: 0,
      queryCount: 0,
      judgeModel: 'claude-haiku-4-5',
    });
    expect(c).toBe(0);
  });

  test('haiku is cheaper than sonnet for the same pair count', () => {
    const haiku = estimateUpperBoundCost({
      pairCount: 100,
      queryCount: 10,
      judgeModel: 'claude-haiku-4-5',
    });
    const sonnet = estimateUpperBoundCost({
      pairCount: 100,
      queryCount: 10,
      judgeModel: 'claude-sonnet-4-6',
    });
    expect(sonnet).toBeGreaterThan(haiku);
  });

  test('scales linearly in pair count', () => {
    const c50 = estimateUpperBoundCost({
      pairCount: 50, queryCount: 0, judgeModel: 'claude-haiku-4-5',
    });
    const c100 = estimateUpperBoundCost({
      pairCount: 100, queryCount: 0, judgeModel: 'claude-haiku-4-5',
    });
    expect(c100).toBeCloseTo(c50 * 2, 8);
  });

  test('embedding cost included even with zero pairs', () => {
    const c = estimateUpperBoundCost({
      pairCount: 0,
      queryCount: 1000,
      judgeModel: 'claude-haiku-4-5',
    });
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(0.01); // 1000 queries × 50 tok × $0.13/Mtok = ~$0.0065
  });

  test('unknown model falls back to haiku pricing', () => {
    const c1 = estimateUpperBoundCost({
      pairCount: 100, queryCount: 0, judgeModel: 'made-up-model',
    });
    const c2 = estimateUpperBoundCost({
      pairCount: 100, queryCount: 0, judgeModel: 'claude-haiku-4-5',
    });
    expect(c1).toBeCloseTo(c2, 8);
  });
});

describe('CostTracker', () => {
  test('fresh tracker has zero totals', () => {
    const t = new CostTracker({ capUsd: 5 });
    expect(t.judge()).toBe(0);
    expect(t.embedding()).toBe(0);
    expect(t.total()).toBe(0);
    expect(t.exceededCap()).toBe(false);
  });

  test('records judge calls cumulatively', () => {
    const t = new CostTracker({ capUsd: 5 });
    t.recordJudgeCall('claude-haiku-4-5', { inputTokens: 500, outputTokens: 80 });
    const after1 = t.judge();
    t.recordJudgeCall('claude-haiku-4-5', { inputTokens: 500, outputTokens: 80 });
    expect(t.judge()).toBeCloseTo(after1 * 2, 8);
  });

  test('records embedding cost separately', () => {
    const t = new CostTracker({ capUsd: 5 });
    t.recordEmbeddingCall(1000);
    expect(t.judge()).toBe(0);
    expect(t.embedding()).toBeGreaterThan(0);
  });

  test('exceededCap fires when cumulative crosses budget', () => {
    const t = new CostTracker({ capUsd: 0.001 });
    // 100 haiku calls easily exceeds $0.001
    for (let i = 0; i < 100; i++) {
      t.recordJudgeCall('claude-haiku-4-5', { inputTokens: 500, outputTokens: 80 });
    }
    expect(t.exceededCap()).toBe(true);
  });

  test('finalize includes estimate_note explaining soft-ceiling semantics', () => {
    const t = new CostTracker({ capUsd: 5 });
    const out = t.finalize();
    expect(out.estimate_note).toContain('approximate');
    expect(out.estimate_note).toContain('soft ceiling');
  });

  test('finalize sums judge + embedding into total', () => {
    const t = new CostTracker({ capUsd: 5 });
    t.recordJudgeCall('claude-haiku-4-5', { inputTokens: 1000, outputTokens: 100 });
    t.recordEmbeddingCall(500);
    const out = t.finalize();
    expect(out.total).toBeCloseTo(out.judge + out.embedding, 6);
  });

  test('zero cap exceededCap fires on any spend', () => {
    const t = new CostTracker({ capUsd: 0 });
    expect(t.exceededCap()).toBe(false);
    t.recordEmbeddingCall(10);
    expect(t.exceededCap()).toBe(true);
  });

  test('negative cap clamped to zero', () => {
    const t = new CostTracker({ capUsd: -5 });
    expect(t.capUsd()).toBe(0);
  });

  test('values are rounded to 6 decimals in the breakdown', () => {
    const t = new CostTracker({ capUsd: 100 });
    t.recordJudgeCall('claude-haiku-4-5', { inputTokens: 1, outputTokens: 1 });
    const out = t.finalize();
    // 6e-6 rounded ok; no scientific-notation tail in JSON output expected.
    expect(Number.isFinite(out.judge)).toBe(true);
    expect(Number.isFinite(out.total)).toBe(true);
  });
});
