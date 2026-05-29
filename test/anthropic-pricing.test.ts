/**
 * v0.41.20.0 — pin estimateMaxCostUsd across bare/colon/slash/unknown ids.
 *
 * No prior coverage existed for this helper. The slash-form bug class
 * (#1540) refired here for OpenRouter and CLI `--judge-model` users
 * before this fix; this file pins the centralized parse path so any
 * future refactor of parseModelId or estimateMaxCostUsd can't silently
 * drop slash-form support.
 */

import { describe, test, expect } from 'bun:test';
import { ANTHROPIC_PRICING, estimateMaxCostUsd } from '../src/core/anthropic-pricing.ts';

describe('estimateMaxCostUsd', () => {
  // Sonnet 4.6 = $3 input / $15 output per MTok.
  // 1M input + 0 output → $3.00
  // 0 input + 1M output → $15.00

  test('bare key claude-sonnet-4-6 → hits pricing', () => {
    const cost = estimateMaxCostUsd('claude-sonnet-4-6', 1_000_000, 0);
    expect(cost).toBeCloseTo(3.0, 5);
  });

  test('colon-prefixed anthropic:claude-sonnet-4-6 → hits pricing via tail', () => {
    const cost = estimateMaxCostUsd('anthropic:claude-sonnet-4-6', 1_000_000, 0);
    expect(cost).toBeCloseTo(3.0, 5);
  });

  test('slash-prefixed anthropic/claude-sonnet-4-6 → hits pricing via tail (THE FIX)', () => {
    // Pre-v0.41.20.0: this returned null because the inline split only
    // handled `:`. CLI `--judge-model anthropic/...` + `--max-cost N` then
    // hit BudgetTracker no_pricing fail-closed.
    const cost = estimateMaxCostUsd('anthropic/claude-sonnet-4-6', 1_000_000, 0);
    expect(cost).toBeCloseTo(3.0, 5);
  });

  test('mixed input + output cost math', () => {
    // 100K input + 50K output for opus 4.7 ($5/$25)
    // = 0.1 * 5 + 0.05 * 25 = 0.5 + 1.25 = 1.75
    const cost = estimateMaxCostUsd('anthropic/claude-opus-4-7', 100_000, 50_000);
    expect(cost).toBeCloseTo(1.75, 5);
  });

  test('unknown model → returns null (caller warn-once + bypass)', () => {
    expect(estimateMaxCostUsd('mistral:medium', 1_000, 1_000)).toBeNull();
    expect(estimateMaxCostUsd('gpt-5', 1_000, 1_000)).toBeNull();
  });

  test('OpenRouter nested form returns null — tail is `anthropic/claude-...` which is not a pricing key', () => {
    // Per D2 architecture: parseModelId returns {provider:'openrouter',
    // model:'anthropic/claude-sonnet-4-6'}; lookup on the tail
    // 'anthropic/claude-sonnet-4-6' misses (table has bare 'claude-sonnet-4-6').
    // OpenRouter pricing is intentionally out of scope (TODO #2).
    expect(estimateMaxCostUsd('openrouter:anthropic/claude-sonnet-4-6', 1_000, 1_000)).toBeNull();
  });

  test('every key in ANTHROPIC_PRICING is reachable via bare/colon/slash form', () => {
    // Regression guard: if someone adds a new entry to ANTHROPIC_PRICING,
    // it should be reachable via all three forms automatically (the route
    // is structural, not per-key).
    for (const key of Object.keys(ANTHROPIC_PRICING)) {
      expect(estimateMaxCostUsd(key, 1_000_000, 0)).not.toBeNull();
      expect(estimateMaxCostUsd(`anthropic:${key}`, 1_000_000, 0)).not.toBeNull();
      expect(estimateMaxCostUsd(`anthropic/${key}`, 1_000_000, 0)).not.toBeNull();
    }
  });
});
