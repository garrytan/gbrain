/**
 * takes-quality-eval/pricing — fail-closed lookup tests (codex review #4).
 */
import { describe, test, expect } from 'bun:test';
import {
  getPricing,
  estimateCost,
  PricingNotFoundError,
  MODEL_PRICING,
} from '../src/core/takes-quality-eval/pricing.ts';

describe('getPricing — fail-closed contract', () => {
  test('returns pricing for the default 3-model panel', () => {
    expect(getPricing('openai:gpt-4o')).toBeDefined();
    expect(getPricing('anthropic:claude-opus-4-7')).toBeDefined();
    expect(getPricing('google:gemini-1.5-pro')).toBeDefined();
  });

  test('throws PricingNotFoundError on unknown model', () => {
    expect(() => getPricing('unknown:gpt-99')).toThrow(PricingNotFoundError);
  });

  test('error message names the model AND points to the file', () => {
    try {
      getPricing('foo:bar');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PricingNotFoundError);
      expect((e as Error).message).toContain('foo:bar');
      expect((e as Error).message).toContain('src/core/takes-quality-eval/pricing.ts');
      expect((e as Error).message).toContain('--budget-usd 0');
    }
  });
});

describe('estimateCost', () => {
  test('returns USD cost for known model', () => {
    // openai:gpt-4o = $2.50/1M in + $10.00/1M out
    // 1M in + 1M out = $12.50
    const c = estimateCost('openai:gpt-4o', 1_000_000, 1_000_000);
    expect(c).toBeCloseTo(12.5, 5);
  });

  test('zero tokens → zero cost', () => {
    expect(estimateCost('openai:gpt-4o', 0, 0)).toBe(0);
  });

  test('throws on unknown model (matches getPricing)', () => {
    expect(() => estimateCost('unknown:foo', 100, 100)).toThrow(PricingNotFoundError);
  });
});

describe('MODEL_PRICING table', () => {
  test('every entry has finite positive rates', () => {
    for (const [model, p] of Object.entries(MODEL_PRICING)) {
      expect(Number.isFinite(p.input_per_1m)).toBe(true);
      expect(Number.isFinite(p.output_per_1m)).toBe(true);
      expect(p.input_per_1m).toBeGreaterThan(0);
      expect(p.output_per_1m).toBeGreaterThan(0);
      // Output is typically more expensive than input; canary on weird drift.
      expect(p.output_per_1m).toBeGreaterThanOrEqual(p.input_per_1m);
      // Sanity guard against an accidental integer column (model id has the colon).
      expect(model).toContain(':');
    }
  });
});
