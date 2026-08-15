/**
 * v0.37.0 — domain-bank distance normalization (D6 + codex r2 #9).
 *
 * Pinned cases from the codex-r2 fix: same-vector → 0, orthogonal → 0.5,
 * opposite → 1, missing-vector → caller responsibility (skipped at retrieval).
 */

import { describe, test, expect } from 'bun:test';
import { normalizedCosineDistance } from '../../src/core/brainstorm/domain-bank.ts';

function v(...nums: number[]): Float32Array {
  return new Float32Array(nums);
}

describe('normalizedCosineDistance — codex r2 #9 pinned cases', () => {
  test('same vector → distance 0 (identical)', () => {
    const a = v(0.6, 0.8, 0.0);
    expect(normalizedCosineDistance(a, a)).toBeCloseTo(0, 6);
  });

  test('orthogonal unit vectors → distance 0.5 (neutral)', () => {
    const x = v(1, 0, 0);
    const y = v(0, 1, 0);
    expect(normalizedCosineDistance(x, y)).toBeCloseTo(0.5, 6);
  });

  test('opposite unit vectors → distance 1 (maximally far)', () => {
    const x = v(1, 0, 0);
    const y = v(-1, 0, 0);
    expect(normalizedCosineDistance(x, y)).toBeCloseTo(1, 6);
  });

  test('45-degree separation lands between 0 and 0.5', () => {
    // cos(45°) ≈ 0.707, so cosDist ≈ 0.293, halved → 0.146
    const x = v(1, 0);
    const y = v(Math.sqrt(0.5), Math.sqrt(0.5));
    const d = normalizedCosineDistance(x, y);
    expect(d).toBeGreaterThan(0.1);
    expect(d).toBeLessThan(0.2);
  });

  test('zero-vector edge → 0.5 (neutral, no division-by-zero)', () => {
    const z = v(0, 0, 0);
    const a = v(1, 1, 1);
    expect(normalizedCosineDistance(z, a)).toBeCloseTo(0.5, 6);
  });

  test('dimension mismatch throws', () => {
    expect(() => normalizedCosineDistance(v(1, 0), v(1, 0, 0))).toThrow(/dim mismatch/);
  });

  test('result is symmetric: d(a,b) === d(b,a)', () => {
    const a = v(0.3, 0.4, 0.5);
    const b = v(0.7, 0.1, 0.2);
    expect(normalizedCosineDistance(a, b)).toBeCloseTo(normalizedCosineDistance(b, a), 6);
  });

  test('result is bounded [0, 1] even on non-unit vectors', () => {
    const a = v(10, 0, 0);
    const b = v(0, 5, 0);
    const d = normalizedCosineDistance(a, b);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1);
  });
});
