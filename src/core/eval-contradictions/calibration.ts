/**
 * eval-contradictions/calibration — Wilson confidence interval on the headline %.
 *
 * The probe outputs a fraction like "12/50 queries had a suspected contradiction
 * (24%)." Without a CI, that single number is overclaimed: 24% on n=50 could be
 * anywhere from ~14% to ~37% at 95% confidence. Saying "24% with 95% CI 14-37"
 * is the difference between a defensible measurement and a vibes-based number.
 *
 * Why Wilson over normal-approximation: stable at small n and at extreme p
 * (close to 0 or 1). The normal approximation breaks where we care most.
 *
 * n < 30 returns a small_sample_note string so the consumer can disclaim the
 * bound rather than treat it as actionable.
 */

import type { Calibration, WilsonCI } from './types.ts';

/** 95% confidence z-score. */
const Z_95 = 1.959963984540054;

/**
 * Wilson score interval for a binomial proportion at 95% confidence.
 *
 * Returns the point estimate (k/n) and lower/upper bounds. Edge cases:
 * - n === 0: returns all zeros. Caller decides UX.
 * - k > n: clamps k to n.
 * - k < 0: clamps to 0.
 */
export function wilsonCI(numerator: number, denominator: number): WilsonCI {
  if (denominator <= 0) {
    return { point: 0, lower: 0, upper: 0 };
  }
  const k = Math.max(0, Math.min(numerator, denominator));
  const n = denominator;
  const p = k / n;
  const z = Z_95;
  const z2 = z * z;
  const center = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  // Pin exact boundaries: when k === 0 the lower bound must be exactly 0;
  // when k === n the upper bound must be exactly 1. Otherwise floating-point
  // residuals (6e-18, 0.9999...) leak through and confuse callers.
  const lowerRaw = Math.max(0, center - margin);
  const upperRaw = Math.min(1, center + margin);
  return {
    point: p,
    lower: k === 0 ? 0 : lowerRaw,
    upper: k === n ? 1 : upperRaw,
  };
}

/** Build the calibration block for the ProbeReport. n < 30 triggers small-sample note. */
export function buildCalibration(opts: {
  queriesTotal: number;
  queriesWithContradiction: number;
}): Calibration {
  const clean = Math.max(0, opts.queriesTotal - opts.queriesWithContradiction);
  const ci = wilsonCI(opts.queriesWithContradiction, opts.queriesTotal);
  const cal: Calibration = {
    queries_total: opts.queriesTotal,
    queries_judged_clean: clean,
    queries_with_contradiction: opts.queriesWithContradiction,
    wilson_ci_95: ci,
  };
  if (opts.queriesTotal < 30) {
    cal.small_sample_note = `n=${opts.queriesTotal} is below 30; the 95% CI is too wide to act on. Run more queries before drawing conclusions.`;
  }
  return cal;
}
