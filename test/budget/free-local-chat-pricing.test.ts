import { describe, test, expect } from 'bun:test';
import { BudgetTracker, BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';

/**
 * Regression guard for a silent-zero-yield bug: `cycle.extract_atoms` always
 * constructs its BudgetTracker with a cap (config only accepts `n > 0`, so it
 * cannot be unset). Local chat models have no CANONICAL_PRICING entry, so TX2
 * hard-failed `no_pricing` before the first call and every page was skipped
 * with `budget_exhausted: true` at $0 spent — extraction reported success and
 * produced nothing.
 */
const est = (modelId: string, kind: 'chat' | 'embed' | 'rerank' = 'chat') => ({
  modelId, kind, estimatedInputTokens: 12_000, maxOutputTokens: 4096,
});

describe('free local chat providers under a cost cap', () => {
  test('ollama chat reserves at $0 instead of hard-failing', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.3, label: 'test' });
    expect(() => t.reserve(est('ollama:gemma4:26b'))).not.toThrow();
    expect(t.totalSpent).toBe(0);
  });

  test('llama-server chat also reserves at $0', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.3, label: 'test' });
    expect(() => t.reserve(est('llama-server:qwen3-32b'))).not.toThrow();
  });

  test('a genuinely unpriced remote provider still hard-fails (TX2 intact)', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.3, label: 'test' });
    let err: unknown;
    try { t.reserve(est('some-unknown-vendor:mystery-model')); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BudgetExhausted);
    expect((err as BudgetExhausted).reason).toBe('no_pricing');
  });

  test('litellm is NOT free — a proxy can front a paid provider', () => {
    // Mirrors the embed set's deliberate exclusion. Pricing-unknown is the
    // honest state for a proxy, so the cap must still hard-fail.
    const t = new BudgetTracker({ maxCostUsd: 0.3, label: 'test' });
    expect(() => t.reserve(est('litellm:gpt-5.4'))).toThrow(BudgetExhausted);
  });

  test('priced models are unaffected — real cost still projected', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.3, label: 'test' });
    expect(() => t.reserve(est('anthropic:claude-haiku-4-5'))).not.toThrow();
    // And a cap smaller than the projected cost still throws on cost, not pricing.
    const tight = new BudgetTracker({ maxCostUsd: 0.000001, label: 'test' });
    let err: unknown;
    try { tight.reserve(est('anthropic:claude-opus-4-7')); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(BudgetExhausted);
    expect((err as BudgetExhausted).reason).toBe('cost');
  });

  test('embed and rerank paths are untouched by the chat addition', () => {
    const t = new BudgetTracker({ maxCostUsd: 0.3, label: 'test' });
    expect(() => t.reserve(est('ollama:nomic-embed-text', 'embed'))).not.toThrow();
  });
});
