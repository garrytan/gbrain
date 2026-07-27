/**
 * Calibration tests — Wilson CI and small-sample annotation.
 */

import { describe, test, expect } from 'bun:test';
import { buildCalibration, wilsonCI } from '../src/core/eval-contradictions/calibration.ts';

describe('wilsonCI', () => {
  test('zero denominator returns all zeros', () => {
    expect(wilsonCI(0, 0)).toEqual({ point: 0, lower: 0, upper: 0 });
  });

  test('half-and-half on n=100 brackets 0.5', () => {
    const ci = wilsonCI(50, 100);
    expect(ci.point).toBe(0.5);
    expect(ci.lower).toBeGreaterThan(0.39);
    expect(ci.lower).toBeLessThan(0.41);
    expect(ci.upper).toBeGreaterThan(0.59);
    expect(ci.upper).toBeLessThan(0.61);
  });

  test('zero successes on n=20 gives a useful upper bound', () => {
    const ci = wilsonCI(0, 20);
    expect(ci.point).toBe(0);
    expect(ci.lower).toBe(0);
    // 95% upper bound for 0/20 is ~16%.
    expect(ci.upper).toBeGreaterThan(0.1);
    expect(ci.upper).toBeLessThan(0.2);
  });

  test('all successes on n=10 gives a non-zero lower bound', () => {
    const ci = wilsonCI(10, 10);
    expect(ci.point).toBe(1);
    expect(ci.upper).toBe(1);
    expect(ci.lower).toBeGreaterThan(0.6);
  });

  test('clamps numerator above denominator', () => {
    const ci = wilsonCI(15, 10);
    expect(ci.point).toBe(1);
  });

  test('clamps negative numerator to zero', () => {
    const ci = wilsonCI(-3, 10);
    expect(ci.point).toBe(0);
  });

  test('typical 12/50 surfaces a roughly 14-37 band', () => {
    const ci = wilsonCI(12, 50);
    expect(ci.point).toBeCloseTo(0.24, 2);
    expect(ci.lower).toBeGreaterThan(0.13);
    expect(ci.lower).toBeLessThan(0.16);
    expect(ci.upper).toBeGreaterThan(0.35);
    expect(ci.upper).toBeLessThan(0.39);
  });
});

describe('buildCalibration', () => {
  test('emits small_sample_note when queriesTotal < 30', () => {
    const cal = buildCalibration({ queriesTotal: 10, queriesWithContradiction: 2 });
    expect(cal.small_sample_note).toBeTruthy();
    expect(cal.small_sample_note).toContain('n=10');
  });

  test('omits small_sample_note for n >= 30', () => {
    const cal = buildCalibration({ queriesTotal: 50, queriesWithContradiction: 12 });
    expect(cal.small_sample_note).toBeUndefined();
  });

  test('queries_judged_clean is total minus contradictions', () => {
    const cal = buildCalibration({ queriesTotal: 50, queriesWithContradiction: 12 });
    expect(cal.queries_judged_clean).toBe(38);
  });

  test('handles all-contradiction case', () => {
    const cal = buildCalibration({ queriesTotal: 5, queriesWithContradiction: 5 });
    expect(cal.queries_judged_clean).toBe(0);
    expect(cal.wilson_ci_95.point).toBe(1);
  });

  test('handles zero-contradiction case', () => {
    const cal = buildCalibration({ queriesTotal: 50, queriesWithContradiction: 0 });
    expect(cal.wilson_ci_95.point).toBe(0);
    expect(cal.wilson_ci_95.lower).toBe(0);
    expect(cal.wilson_ci_95.upper).toBeGreaterThan(0);
    expect(cal.wilson_ci_95.upper).toBeLessThan(0.1);
  });

  test('handles zero queries gracefully', () => {
    const cal = buildCalibration({ queriesTotal: 0, queriesWithContradiction: 0 });
    expect(cal.queries_judged_clean).toBe(0);
    expect(cal.wilson_ci_95).toEqual({ point: 0, lower: 0, upper: 0 });
    expect(cal.small_sample_note).toBeTruthy();
  });
});
