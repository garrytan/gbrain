/**
 * v0.37.x — payload-fitter batch strategy contract.
 *
 * Hermetic. No LLM, no embed. Just the deterministic chunking gate.
 */

import { describe, test, expect } from 'bun:test';
import { fit } from '../../../src/core/diarize/payload-fitter.ts';

describe('fit batch', () => {
  test('returns input items unchanged when all fit', async () => {
    const items = ['short', 'also-short', 'tiny'];
    const r = await fit({
      items,
      strategy: 'batch',
      maxTokensPerCall: 1000,
      estimateTokens: (s) => s.length,
    });
    expect(r.fitted).toEqual(items);
    expect(r.dropped).toBe(0);
    expect(r.degraded).toBe(false);
    expect(r.success_ratio).toBe(1.0);
  });

  test('reports dropped count for over-budget items', async () => {
    const items = ['a'.repeat(10), 'b'.repeat(2000), 'c'.repeat(50)];
    const r = await fit({
      items,
      strategy: 'batch',
      maxTokensPerCall: 100,
      estimateTokens: (s) => s.length,
    });
    expect(r.dropped).toBe(1);
    expect(r.success_ratio).toBeCloseTo(2 / 3, 6);
    // batch never flags degraded; it surfaces dropped count for caller
    expect(r.degraded).toBe(false);
  });

  test('empty input is a no-op success', async () => {
    const r = await fit({
      items: [],
      strategy: 'batch',
      maxTokensPerCall: 100,
      estimateTokens: () => 0,
    });
    expect(r.fitted).toEqual([]);
    expect(r.success_ratio).toBe(1.0);
  });

  test('deterministic — same input yields the same fitted list', async () => {
    const items = ['one', 'two', 'three'];
    const a = await fit({ items, strategy: 'batch', maxTokensPerCall: 100, estimateTokens: (s) => s.length });
    const b = await fit({ items, strategy: 'batch', maxTokensPerCall: 100, estimateTokens: (s) => s.length });
    expect(a.fitted).toEqual(b.fitted);
  });
});

describe('fit unknown strategy', () => {
  test('throws synchronously on unknown strategy', async () => {
    await expect(
      fit({
        items: ['x'],
        // @ts-expect-error — intentional unknown for the error path
        strategy: 'mystery',
        maxTokensPerCall: 100,
        estimateTokens: (s) => s.length,
      }),
    ).rejects.toThrow(/unknown strategy/);
  });
});
