/**
 * Adversarial: noisy LLM judge.
 *
 * D12 median-of-3 + epsilon=0.05 is the load-bearing defense. These tests
 * pin the math: a judge that returns ±0.10 jitter must not accept noise
 * as improvement.
 */

import { describe, expect, test } from 'bun:test';
import { median } from '../../../src/core/skillopt/validate-gate.ts';
import { VALIDATION_EPSILON } from '../../../src/core/skillopt/types.ts';

describe('adversarial: noisy judge', () => {
  test('median of 3 close runs returns the middle value', () => {
    expect(median([0.62, 0.65, 0.63])).toBeCloseTo(0.63, 5);
    expect(median([0.5, 0.5, 0.5])).toBe(0.5);
  });

  test('median of [low, low, high] rejects the outlier high', () => {
    // Pathological: 2 honest 0.50 scores + 1 jittery 0.95.
    // Median is 0.50, NOT 0.65 (which is what mean would give).
    expect(median([0.5, 0.5, 0.95])).toBe(0.5);
  });

  test('median of [high, high, low] keeps the high signal', () => {
    expect(median([0.85, 0.85, 0.10])).toBe(0.85);
  });

  test('epsilon=0.05 means a 0.04 improvement is REJECTED as noise', () => {
    const best = 0.50;
    const candidate = 0.54; // +0.04 improvement
    const threshold = best + VALIDATION_EPSILON;
    expect(candidate > threshold).toBe(false); // rejected
  });

  test('epsilon=0.05 means a 0.06 improvement is ACCEPTED as signal', () => {
    const best = 0.50;
    const candidate = 0.56;
    const threshold = best + VALIDATION_EPSILON;
    expect(candidate > threshold).toBe(true); // accepted
  });

  test('boundary: exactly 0.05 improvement is REJECTED (strict > threshold)', () => {
    // The paper-faithful gate is STRICT > best + epsilon, not >=.
    // Equal-to-threshold is a tie, which counts as no margin.
    const best = 0.50;
    const candidate = 0.55;
    const threshold = best + VALIDATION_EPSILON;
    expect(candidate > threshold).toBe(false);
  });

  test('100-run jitter simulation: random noise around best does NOT accept', () => {
    // Simulate 100 noisy gate evaluations where the candidate is actually
    // NO better than baseline. With median-of-3 + epsilon=0.05, the
    // expected acceptance rate should be near zero.
    const best = 0.70;
    let accepts = 0;
    const rng = makeSeededRng(42);
    for (let i = 0; i < 100; i++) {
      // Three runs, each within ±0.04 of 0.70.
      const runs = [
        0.70 + (rng() - 0.5) * 0.08,
        0.70 + (rng() - 0.5) * 0.08,
        0.70 + (rng() - 0.5) * 0.08,
      ];
      const m = median(runs);
      if (m > best + VALIDATION_EPSILON) accepts += 1;
    }
    // With ±0.04 noise and a 0.05 margin, we expect VERY few false accepts.
    expect(accepts).toBeLessThanOrEqual(2); // <= 2% false positive rate
  });

  test('median of empty array returns 0 (no judge ran)', () => {
    expect(median([])).toBe(0);
  });

  test('median of single value returns that value', () => {
    expect(median([0.42])).toBe(0.42);
  });

  test('median of even-length array averages the middle two', () => {
    expect(median([0.4, 0.5, 0.6, 0.7])).toBe(0.55);
  });
});

// Mulberry32 PRNG so the noise simulation is reproducible.
function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
