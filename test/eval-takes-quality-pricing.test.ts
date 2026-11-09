/**
 * takes-quality-eval/pricing — canonical-table lookup, operator overrides,
 * and the unpriced-model refusal under a user cap (new models must run).
 */
import { describe, test, expect } from 'bun:test';
import {
  getPricing,
  estimateCost,
  unpricedUnderCapError,
  unpricedWarning,
} from '../src/core/takes-quality-eval/pricing.ts';
import { CANONICAL_PRICING } from '../src/core/model-pricing.ts';

describe('getPricing — canonical table', () => {
  test('returns pricing for the default 3-model panel', () => {
    expect(getPricing('openai:gpt-5.2')).not.toBeNull();
    expect(getPricing('anthropic:claude-opus-4-7')).not.toBeNull();
    expect(getPricing('google:gemini-2.5-flash')).not.toBeNull();
  });

  test('every canonically priced model is budget-gateable, including new ones', () => {
    for (const id of ['anthropic:claude-fable-5', 'anthropic:claude-fable-5-1', 'anthropic:claude-fable-5-2', 'openai:gpt-5.6-sol', 'openai:gpt-5.6-luna']) {
      expect(getPricing(id)).toEqual({ input_per_1m: CANONICAL_PRICING[id]!.input, output_per_1m: CANONICAL_PRICING[id]!.output });
    }
  });

  test('returns null for an unpriced model', () => {
    expect(getPricing('unknown:gpt-99')).toBeNull();
  });

  test('a registered override wins over the table and prices an unpriced model', () => {
    const overrides = { 'unknown:gpt-99': { input: 1, output: 2 }, 'openai:gpt-4o': { input: 0.5, output: 0.5 } };
    expect(getPricing('unknown:gpt-99', overrides)).toEqual({ input_per_1m: 1, output_per_1m: 2 });
    expect(getPricing('openai:gpt-4o', overrides)).toEqual({ input_per_1m: 0.5, output_per_1m: 0.5 });
  });

  test('opus 4.7 priced at $5/$25 (regression: was a stale $15/$75) — gbrain#1819', () => {
    const p = getPricing('anthropic:claude-opus-4-7')!;
    expect(p.input_per_1m).toBeCloseTo(5.0, 5);
    expect(p.output_per_1m).toBeCloseTo(25.0, 5);
  });

  test('opus 4.8 is supported and priced $5/$25 — gbrain#1819', () => {
    const p = getPricing('anthropic:claude-opus-4-8')!;
    expect(p.input_per_1m).toBeCloseTo(5.0, 5);
    expect(p.output_per_1m).toBeCloseTo(25.0, 5);
  });

  test('opus 5 is supported and priced $5/$25', () => {
    const p = getPricing('anthropic:claude-opus-5')!;
    expect(p.input_per_1m).toBeCloseTo(5.0, 5);
    expect(p.output_per_1m).toBeCloseTo(25.0, 5);
  });
});

describe('unpriced models', () => {
  test('under a user cap: no_pricing refusal whose fix registers the rate with gbrain pricing set', () => {
    const e = unpricedUnderCapError('foo:bar', 2);
    expect(e.code).toBe('no_pricing');
    expect(e.message).toContain('foo:bar');
    expect(e.message).toContain('$2.00 cost cap');
    expect(e.fix!.argv).toEqual([
      'gbrain', 'pricing', 'set', 'foo:bar',
      '--input', '<usd-per-1M-input-tokens>', '--output', '<usd-per-1M-output-tokens>',
      '--source', '<pricing-page-url>',
    ]);
    expect(e.fix!.inputs!.map(i => i.name)).toEqual(['usd-per-1M-input-tokens', 'usd-per-1M-output-tokens', 'pricing-page-url']);
    expect(e.fix!.verify).toEqual({ argv: ['gbrain', 'pricing', 'list'] });
  });

  test('without a cap: the warning names the registration command', () => {
    expect(unpricedWarning('foo:bar')).toContain('gbrain pricing set foo:bar --input');
  });
});

describe('estimateCost', () => {
  test('returns USD cost for known model', () => {
    // openai:gpt-4o = $2.50/1M in + $10.00/1M out
    // 1M in + 1M out = $12.50
    expect(estimateCost('openai:gpt-4o', 1_000_000, 1_000_000)).toBeCloseTo(12.5, 5);
  });

  test('zero tokens → zero cost', () => {
    expect(estimateCost('openai:gpt-4o', 0, 0)).toBe(0);
  });

  test('unpriced model → null, never a silent zero', () => {
    expect(estimateCost('unknown:foo', 100, 100)).toBeNull();
  });
});
