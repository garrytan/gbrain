/**
 * SkillOpt LR-schedule unit tests.
 *
 * Pure-function tests: no engine, no env mutation, no fixtures. All three
 * schedules are deterministic given (base, t, totalSteps).
 */

import { describe, expect, test } from 'bun:test';
import { cosineLr, linearLr, constantLr, resolveLrSchedule } from '../../src/core/skillopt/lr-schedule.ts';

describe('cosineLr', () => {
  test('peaks at base for t=1, decays toward 1 by totalSteps', () => {
    expect(cosineLr(4, 1, 10)).toBe(4);
    expect(cosineLr(4, 10, 10)).toBe(1);
    // Mid-curve point — Math.ceil keeps it above 1.
    expect(cosineLr(4, 5, 10)).toBeGreaterThan(1);
    expect(cosineLr(4, 5, 10)).toBeLessThanOrEqual(4);
  });

  test('monotone non-increasing within bounds', () => {
    const seq: number[] = [];
    for (let t = 1; t <= 10; t++) seq.push(cosineLr(4, t, 10));
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!).toBeLessThanOrEqual(seq[i - 1]!);
    }
  });

  test('totalSteps=1 returns base', () => {
    expect(cosineLr(4, 1, 1)).toBe(4);
  });
});

describe('linearLr', () => {
  test('starts at base, ends at 1', () => {
    expect(linearLr(4, 1, 10)).toBe(4);
    expect(linearLr(4, 10, 10)).toBe(1);
  });

  test('monotone non-increasing', () => {
    const seq: number[] = [];
    for (let t = 1; t <= 10; t++) seq.push(linearLr(4, t, 10));
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!).toBeLessThanOrEqual(seq[i - 1]!);
    }
  });
});

describe('constantLr', () => {
  test('returns base regardless of t or totalSteps', () => {
    expect(constantLr(4, 1, 10)).toBe(4);
    expect(constantLr(4, 5, 10)).toBe(4);
    expect(constantLr(4, 10, 10)).toBe(4);
  });

  test('floors at 1 when base < 1', () => {
    expect(constantLr(0, 1, 1)).toBe(1);
  });
});

describe('resolveLrSchedule', () => {
  test('returns the matching function for each schedule name', () => {
    expect(resolveLrSchedule('cosine')(4, 1, 1)).toBe(4);
    expect(resolveLrSchedule('linear')(4, 1, 1)).toBe(4);
    expect(resolveLrSchedule('constant')(4, 1, 1)).toBe(4);
  });
});
