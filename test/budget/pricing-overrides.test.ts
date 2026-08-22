import { describe, test, expect } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BudgetTracker,
  BudgetExhausted,
  parsePricingOverrides,
  loadPricingOverrides,
  isModelPriceable,
} from '../../src/core/budget/budget-tracker.ts';

/**
 * #4312 — operator config-plane price overrides (`pricing.overrides`).
 *
 * A LiteLLM proxy can front a PAID provider, so `litellm:*` is deliberately
 * absent from the free-local sets and from the shipped pricing tables — which
 * meant every `--max-cost` run through a proxy TX2 hard-failed `no_pricing`
 * at $0. Operators now declare their real rate in the config plane; unknown
 * paid routes without an override stay fail-closed.
 */

const auditPath = () => join(tmpdir(), `gbrain-budget-test-${Math.random().toString(36).slice(2)}.jsonl`);

const est = (modelId: string, kind: 'chat' | 'embed' | 'rerank' = 'chat') => ({
  modelId, kind, estimatedInputTokens: 1_000_000, maxOutputTokens: 0,
});

describe('parsePricingOverrides', () => {
  test('JSON string with scalar and object forms', () => {
    const p = parsePricingOverrides(
      '{"litellm:text-embedding-3-large": 0.13, "litellm:gpt-4o": {"input": 2.5, "output": 10}}',
    );
    expect(p).toEqual({
      'litellm:text-embedding-3-large': { input: 0.13, output: 0.13 },
      'litellm:gpt-4o': { input: 2.5, output: 10 },
    });
  });

  test('pricePerMTok spelling and key lowercasing', () => {
    const p = parsePricingOverrides({ 'LiteLLM:MyModel': { pricePerMTok: 0.5 } });
    expect(p).toEqual({ 'litellm:mymodel': { input: 0.5, output: 0.5 } });
  });

  test('invalid entries are dropped (stay fail-closed); junk value → undefined', () => {
    expect(parsePricingOverrides('{"a": -1, "b": "free", "c": null}')).toBeUndefined();
    expect(parsePricingOverrides('not json')).toBeUndefined();
    expect(parsePricingOverrides(null)).toBeUndefined();
    expect(parsePricingOverrides('')).toBeUndefined();
    expect(parsePricingOverrides([1, 2])).toBeUndefined();
    const partial = parsePricingOverrides('{"good": 1, "bad": -3}');
    expect(partial).toEqual({ good: { input: 1, output: 1 } });
  });
});

describe('BudgetTracker with pricingOverrides (#4312)', () => {
  test('pre-fix behavior: unpriced proxy model under --max-cost hard-fails no_pricing', () => {
    const t = new BudgetTracker({ maxCostUsd: 1, label: 'test', auditPath: auditPath() });
    expect(() => t.reserve(est('litellm:custom-chat-model'))).toThrow(BudgetExhausted);
    try {
      t.reserve(est('litellm:custom-chat-model'));
    } catch (e) {
      expect((e as BudgetExhausted).reason).toBe('no_pricing');
    }
  });

  test('chat route: override prices the call and the cap is enforced against it', () => {
    const t = new BudgetTracker({
      maxCostUsd: 1,
      label: 'test',
      auditPath: auditPath(),
      pricingOverrides: parsePricingOverrides('{"litellm:custom-chat-model": {"input": 0.4, "output": 2}}'),
    });
    // 1M input tokens at $0.4/M → $0.40 projected, under the $1 cap.
    expect(() => t.reserve(est('litellm:custom-chat-model'))).not.toThrow();
    t.record({ modelId: 'litellm:custom-chat-model', inputTokens: 1_000_000, outputTokens: 0, kind: 'chat' });
    expect(t.totalSpent).toBeCloseTo(0.4, 6);
    // output tokens bill at the output rate
    t.record({ modelId: 'litellm:custom-chat-model', inputTokens: 0, outputTokens: 100_000, kind: 'chat' });
    expect(t.totalSpent).toBeCloseTo(0.6, 6);
  });

  test('embed route: override prices litellm embeddings too', () => {
    const t = new BudgetTracker({
      maxCostUsd: 1,
      label: 'test',
      auditPath: auditPath(),
      pricingOverrides: parsePricingOverrides('{"litellm:text-embedding-3-large": 0.13}'),
    });
    expect(() => t.reserve(est('litellm:text-embedding-3-large', 'embed'))).not.toThrow();
    t.record({ modelId: 'litellm:text-embedding-3-large', inputTokens: 1_000_000, kind: 'embed' });
    expect(t.totalSpent).toBeCloseTo(0.13, 6);
  });

  test('cap still bites: an overpriced override projects past --max-cost and throws cost', () => {
    const t = new BudgetTracker({
      maxCostUsd: 0.05,
      label: 'test',
      auditPath: auditPath(),
      pricingOverrides: parsePricingOverrides('{"litellm:pricey": 5}'),
    });
    try {
      t.reserve(est('litellm:pricey'));
      throw new Error('expected BudgetExhausted');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExhausted);
      expect((e as BudgetExhausted).reason).toBe('cost');
    }
  });

  test('unknown paid routes WITHOUT an override stay fail-closed', () => {
    const t = new BudgetTracker({
      maxCostUsd: 1,
      label: 'test',
      auditPath: auditPath(),
      pricingOverrides: parsePricingOverrides('{"litellm:other-model": 1}'),
    });
    expect(() => t.reserve(est('litellm:not-overridden'))).toThrow(BudgetExhausted);
  });

  test('override wins over a shipped table row (operator owns the bill)', () => {
    const t = new BudgetTracker({
      label: 'test',
      auditPath: auditPath(),
      pricingOverrides: parsePricingOverrides('{"voyage:voyage-4": 0.5}'),
    });
    t.record({ modelId: 'voyage:voyage-4', inputTokens: 1_000_000, kind: 'embed' });
    expect(t.totalSpent).toBeCloseTo(0.5, 6); // table says 0.06; override says 0.5
  });

  test('isModelPriceable consults overrides', () => {
    const overrides = parsePricingOverrides('{"litellm:x": 1}');
    expect(isModelPriceable('litellm:x', 'chat')).toBe(false);
    expect(isModelPriceable('litellm:x', 'chat', overrides)).toBe(true);
  });
});

describe('loadPricingOverrides — config-plane loader', () => {
  test('reads pricing.overrides from the engine config plane', async () => {
    const fake = {
      getConfig: async (key: string) =>
        key === 'pricing.overrides' ? '{"litellm:gpt-4o": 2.5}' : null,
    };
    expect(await loadPricingOverrides(fake)).toEqual({ 'litellm:gpt-4o': { input: 2.5, output: 2.5 } });
  });

  test('fail-open: config read failure → undefined (models stay fail-closed)', async () => {
    const boom = { getConfig: async () => { throw new Error('db down'); } };
    expect(await loadPricingOverrides(boom)).toBeUndefined();
  });
});
