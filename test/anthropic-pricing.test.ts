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
import { CANONICAL_PRICING } from '../src/core/model-pricing.ts';

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

  test('opus 4.8 priced same as 4.7 ($5/$25) — closes #1819', () => {
    // 100K in + 50K out = 0.1*5 + 0.05*25 = 0.5 + 1.25 = 1.75. Pre-fix this
    // model was absent from the pricing table → estimateMaxCostUsd returned
    // null and the dream-cycle budget gate silently no-op'd on 4.8 runs.
    const cost = estimateMaxCostUsd('anthropic:claude-opus-4-8', 100_000, 50_000);
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

/**
 * garrytan/gbrain#2504 — non-Anthropic canonical models must be priceable.
 *
 * `ANTHROPIC_PRICING` is `CANONICAL_PRICING` filtered to `anthropic:` keys, and
 * `estimateMaxCostUsd` used to resolve against that view alone — so every
 * non-Anthropic model returned null despite canonical carrying its rate.
 * `BudgetTracker.reserve()` hard-throws on a null estimate when a cap is set,
 * which took out every cost-capped path (enrich, enrich_thin, extract_atoms,
 * skillopt) on OpenAI / Gemini / DeepSeek models.
 */
describe('estimateMaxCostUsd — canonical (non-Anthropic) coverage (#2504)', () => {
  test.each([
    ['openai:gpt-5.2'],
    ['openai:gpt-4o'],
    ['deepseek:deepseek-chat'],
    ['deepseek:deepseek-v4-flash'],
    ['google:gemini-2.0-flash'],
  ])('%s prices from canonical instead of null', (modelId) => {
    const cost = estimateMaxCostUsd(modelId, 1_000_000, 0);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  test('every canonical entry is priceable by its fully-qualified id', () => {
    for (const key of Object.keys(CANONICAL_PRICING)) {
      expect(estimateMaxCostUsd(key, 1_000, 1_000)).not.toBeNull();
    }
  });

  test('genuinely unknown models still return null (TX2 contract intact)', () => {
    expect(estimateMaxCostUsd('acme:not-a-real-model', 1_000, 1_000)).toBeNull();
  });

  test('routing-provider ids stay unpriced — a router bills its own rates', () => {
    // Resolving these to the vendor's direct price would UNDER-estimate spend.
    // Refusing is the correct posture until a router rate table exists (TODO #2).
    expect(estimateMaxCostUsd('openrouter:openai/gpt-5.2', 1_000, 1_000)).toBeNull();
    expect(estimateMaxCostUsd('openrouter:acme/nope', 1_000, 1_000)).toBeNull();
  });
});
