/**
 * v0.42.11.0 (#1784) — cycle-default resolver unit tests.
 *
 * Pins the 4 branches of resolveCycleDefault + the banner-suffix contract.
 * Pure functions, no DB, no env mutation.
 */
import { describe, test, expect } from 'bun:test';
import {
  resolveCycleDefault,
  cycleDefaultSuffix,
  DEFAULT_CYCLES_TTY,
  DEFAULT_CYCLES_NONTTY,
} from '../../src/core/eval/cycle-default.ts';

describe('resolveCycleDefault', () => {
  test('explicit value wins (TTY) — no annotation', () => {
    const r = resolveCycleDefault(5, true);
    expect(r).toEqual({ cycles: 5, usedNonTtyDefault: false });
  });

  test('explicit value wins (non-TTY) — no annotation', () => {
    const r = resolveCycleDefault(5, false);
    expect(r).toEqual({ cycles: 5, usedNonTtyDefault: false });
  });

  test('TTY default → 3, no annotation', () => {
    const r = resolveCycleDefault(undefined, true);
    expect(r).toEqual({ cycles: DEFAULT_CYCLES_TTY, usedNonTtyDefault: false });
    expect(r.cycles).toBe(3);
  });

  test('non-TTY default → 1, ANNOTATED (the silent-degradation case)', () => {
    const r = resolveCycleDefault(undefined, false);
    expect(r).toEqual({ cycles: DEFAULT_CYCLES_NONTTY, usedNonTtyDefault: true });
    expect(r.cycles).toBe(1);
  });

  test('explicit 1 in non-TTY is NOT flagged as the default (user asked for it)', () => {
    const r = resolveCycleDefault(1, false);
    expect(r.usedNonTtyDefault).toBe(false);
  });
});

describe('cycleDefaultSuffix', () => {
  test('empty unless the non-TTY default was applied', () => {
    expect(cycleDefaultSuffix({ cycles: 3, usedNonTtyDefault: false })).toBe('');
    expect(cycleDefaultSuffix({ cycles: 5, usedNonTtyDefault: false })).toBe('');
  });

  test('names the --cycles override when annotated', () => {
    const s = cycleDefaultSuffix({ cycles: 1, usedNonTtyDefault: true });
    expect(s).toContain('non-interactive default');
    expect(s).toContain('--cycles');
  });

  test('round-trips with resolveCycleDefault non-TTY path', () => {
    expect(cycleDefaultSuffix(resolveCycleDefault(undefined, false))).not.toBe('');
    expect(cycleDefaultSuffix(resolveCycleDefault(undefined, true))).toBe('');
  });
});
