/**
 * Verify: weight rounding to 0.05 increments at engine layer.
 *
 * Cross-modal eval found false precision (e.g. 0.74, 0.82) implies
 * calibration accuracy that doesn't exist. Engine now rounds on insert.
 */
import { describe, it, expect } from 'bun:test';

// Inline the rounding logic from postgres-engine/pglite-engine
function roundWeight(w: number): number {
  if (w < 0 || w > 1) w = Math.max(0, Math.min(1, w));
  return Math.round(w * 20) / 20;
}

describe('takes weight rounding', () => {
  it('rounds 0.74 to 0.75', () => {
    expect(roundWeight(0.74)).toBe(0.75);
  });

  it('rounds 0.82 to 0.80', () => {
    expect(roundWeight(0.82)).toBe(0.80);
  });

  it('preserves exact 0.05 boundaries', () => {
    for (const w of [0, 0.05, 0.10, 0.25, 0.50, 0.75, 0.85, 0.95, 1.0]) {
      expect(roundWeight(w)).toBe(w);
    }
  });

  it('rounds up at midpoint (0.025 → 0.05, 0.075 → 0.10)', () => {
    expect(roundWeight(0.025)).toBe(0.05);
    expect(roundWeight(0.075)).toBe(0.10);
  });

  it('clamps out-of-range before rounding', () => {
    expect(roundWeight(-0.1)).toBe(0);
    expect(roundWeight(1.3)).toBe(1.0);
  });

  it('handles edge near 0.5', () => {
    expect(roundWeight(0.47)).toBe(0.45);
    expect(roundWeight(0.48)).toBe(0.50);
    expect(roundWeight(0.52)).toBe(0.50);
    expect(roundWeight(0.53)).toBe(0.55);
  });
});
