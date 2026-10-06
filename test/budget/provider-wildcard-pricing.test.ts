/**
 * D20 provider wildcard overrides and the one price resolver (`priceFor`).
 *
 * `"claude-cli:*": 0` lets a subscription operator price every claude-cli
 * model at once. It is accepted only for providers whose recipe declares
 * `billing: 'subscription'`; a bare `*` and a wildcard on a per-token API
 * provider are dropped at parse, and `gbrain pricing set` refuses them.
 * Precedence: exact model override > provider wildcard > shipped tables.
 *
 * #5847: `deepseek:deepseek-flash` is priced, so the dream BudgetMeter meters
 * it instead of warning NO_PRICING and charging the Sonnet fallback.
 *
 * Hermetic: pure functions plus a BudgetMeter/BudgetTracker with a tmp audit path.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAllowedPricingOverrideKey, isModelPriceable, priceFor } from '../../src/core/budget/reservation-cost.ts';
import { BudgetTracker, parsePricingOverrides, _resetBudgetTrackerWarningsForTest } from '../../src/core/budget/budget-tracker.ts';
import { BudgetMeter } from '../../src/core/cycle/budget-meter.ts';
import { mergePricing, wildcardMatches } from '../../src/commands/pricing.ts';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-wildcard-'));
  _resetBudgetTrackerWarningsForTest();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('provider wildcard keys', () => {
  test('claude-cli:* is accepted; openai:*, a bare *, and an embedded * are rejected', () => {
    expect(isAllowedPricingOverrideKey('claude-cli:*')).toBe(true);
    expect(isAllowedPricingOverrideKey('CLAUDE-CLI:*')).toBe(true);
    expect(isAllowedPricingOverrideKey('openai:*')).toBe(false);
    expect(isAllowedPricingOverrideKey('anthropic:*')).toBe(false);
    expect(isAllowedPricingOverrideKey('*')).toBe(false);
    expect(isAllowedPricingOverrideKey('claude-cli:claude-*')).toBe(false);
    expect(isAllowedPricingOverrideKey('no-such-provider:*')).toBe(false);
    expect(isAllowedPricingOverrideKey('openai:gpt-5.5')).toBe(true);
  });

  test('parsePricingOverrides drops the rejected wildcards and keeps the accepted one', () => {
    const parsed = parsePricingOverrides({ 'claude-cli:*': 0, 'openai:*': 0, '*': 0 });
    expect(parsed).toEqual({ 'claude-cli:*': { input: 0, output: 0 } });
  });

  test('precedence: exact > provider wildcard > shipped table', () => {
    const overrides = parsePricingOverrides({
      'claude-cli:*': 0,
      'claude-cli:claude-opus-5-5': { input: 1, output: 2 },
    });
    expect(priceFor('claude-cli:claude-opus-5-5', 'chat', overrides)).toEqual({ pricing: { input: 1, output: 2 }, source: 'override' });
    expect(priceFor('claude-cli:claude-sonnet-5-5', 'chat', overrides)).toEqual({ pricing: { input: 0, output: 0 }, source: 'provider_wildcard' });
    expect(priceFor('claude-cli:claude-sonnet-5-5', 'chat')?.source).toBe('table');
    expect(priceFor('claude-cli:claude-sonnet-5-5', 'chat')?.pricing.input).toBe(2);
    expect(priceFor('anthropic:claude-sonnet-5-5', 'chat', overrides)?.source).toBe('table');
  });

  test('a wildcard prices a model no table knows, under a user cap', () => {
    const overrides = parsePricingOverrides({ 'claude-cli:*': 0 });
    expect(isModelPriceable('claude-cli:claude-next-unreleased', 'chat')).toBe(false);
    expect(isModelPriceable('claude-cli:claude-next-unreleased', 'chat', overrides)).toBe(true);
    const t = new BudgetTracker({ label: 't', auditPath: join(tmp, 'a.jsonl'), maxCostUsd: 1, pricingOverrides: overrides });
    expect(() => t.reserve({ modelId: 'claude-cli:claude-next-unreleased', kind: 'chat', estimatedInputTokens: 1000, maxOutputTokens: 1000 })).not.toThrow();
  });

  test('gbrain pricing list names the recipe models a wildcard prices', () => {
    const models = wildcardMatches('claude-cli:*');
    expect(models).toContain('claude-cli:claude-opus-5-5');
    expect(models.every((m) => m.startsWith('claude-cli:'))).toBe(true);
    expect(wildcardMatches('claude-cli:claude-opus-5-5')).toEqual([]);
  });

  test('mergePricing keeps the wildcard key as written', () => {
    const { next } = mergePricing({}, { model: 'claude-cli:*', rate: 0 }, new Date(0));
    expect(Object.keys(next)).toEqual(['claude-cli:*']);
  });
});

describe('#5847 deepseek:deepseek-flash is priced', () => {
  test('BudgetMeter meters it at the peak row without the NO_PRICING warning', () => {
    let err = '';
    const spy = spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => {
      err += typeof c === 'string' ? c : new TextDecoder().decode(c);
      return true;
    }) as typeof process.stderr.write);
    let res;
    try {
      const meter = new BudgetMeter({ budgetUsd: 1, phase: 'test', auditPath: join(tmp, 'm.jsonl') });
      res = meter.check({ modelId: 'deepseek:deepseek-flash', estimatedInputTokens: 0, maxOutputTokens: 32_000 });
    } finally {
      spy.mockRestore();
    }
    expect(err).not.toContain('NO_PRICING');
    expect(res.unpriced).toBeFalsy();
    expect(res.estimatedCostUsd).toBeCloseTo(32_000 / 1_000_000 * 1.2, 9);
  });
});

describe('#5873 an override keyed by a model alias prices the id the provider serves for it', () => {
  test('nvidia:nemotron-3-super override prices nvidia:nvidia/nemotron-3-super-120b-a12b', () => {
    const served = 'nvidia:nvidia/nemotron-3-super-120b-a12b';
    expect(isModelPriceable(served, 'chat', { 'nvidia:nemotron-3-super': { input: 1, output: 2 } })).toBe(false);
    const parsed = parsePricingOverrides({ 'nvidia:nemotron-3-super': { input: 1, output: 2 } });
    expect(priceFor(served, 'chat', parsed)).toEqual({ pricing: { input: 1, output: 2 }, source: 'override' });
  });

  test('an explicit row for the served id wins over the alias row', () => {
    const served = 'nvidia:nvidia/nemotron-3-super-120b-a12b';
    const parsed = parsePricingOverrides({ 'nvidia:nemotron-3-super': 1, [served]: 5 });
    expect(priceFor(served, 'chat', parsed)?.pricing).toEqual({ input: 5, output: 5 });
  });
});
