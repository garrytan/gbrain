/**
 * computeChunkCharBudget — official recipe/model context resolution.
 *
 * Pins two things:
 *   1. Current-generation models resolve their real context budget instead
 *      of the unknown-model fallback (the gap this map extension closes).
 *   2. Provider-prefixed ids resolve to the same entry as bare ids.
 *      resolveModel returns prefixed strings when TIER_DEFAULTS / config
 *      values carry a prefix (the current tier defaults all do); before the
 *      prefix-strip fix, every tier-resolved brain silently fell to the
 *      180K fallback — a 5x prompt-budget cut on 1M-context models.
 */

import { describe, test, expect } from 'bun:test';
import { resolveChatContextTokens } from '../src/core/ai/model-resolver.ts';
import { computeChunkCharBudget } from '../src/core/cycle/synthesize.ts';

// Mirror the module's constants (deliberately duplicated: a silent change to
// either should fail this suite, not be absorbed by it).
const CHARS_PER_TOKEN = 3.5;
const HEADROOM_RATIO = 0.9;
const UNKNOWN_BUDGET = Math.floor(180_000 * CHARS_PER_TOKEN);
const budgetFor = (contextTokens: number) =>
  Math.floor(contextTokens * HEADROOM_RATIO * CHARS_PER_TOKEN);

describe('computeChunkCharBudget — model resolution', () => {
  test('official model resolver exposes recipe context metadata', () => {
    expect(resolveChatContextTokens('deepseek:deepseek-v4-flash')).toBe(1_000_000);
    expect(resolveChatContextTokens('deepseek:deepseek-v4-pro')).toBe(1_000_000);
    expect(resolveChatContextTokens('anthropic:claude-opus-4-7')).toBe(1_000_000);
    expect(resolveChatContextTokens('anthropic:claude-sonnet-4-6')).toBe(200_000);
    // openai recipe declares the gpt-5.6 family window (GA 2026-07-09).
    expect(resolveChatContextTokens('openai:gpt-5')).toBe(1_050_000);
    expect(computeChunkCharBudget('openai:gpt-5', null)).toBe(budgetFor(1_050_000));
  });

  test('DeepSeek v4 models use the 1M context declared by the official recipe', () => {
    for (const model of ['deepseek:deepseek-v4-flash', 'deepseek:deepseek-v4-pro']) {
      expect(computeChunkCharBudget(model, null)).toBe(budgetFor(1_000_000));
      expect(computeChunkCharBudget(model, null)).not.toBe(UNKNOWN_BUDGET);
    }
  });

  test('current-generation 1M-context models get their real budget, not the fallback', () => {
    for (const model of ['claude-sonnet-5', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8']) {
      expect(computeChunkCharBudget(model, null)).toBe(budgetFor(1_000_000));
    }
  });

  test('provider-prefixed ids resolve to the same entry as bare ids', () => {
    for (const bare of ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-6']) {
      expect(computeChunkCharBudget(`anthropic:${bare}`, null)).toBe(
        computeChunkCharBudget(bare, null),
      );
    }
    // The load-bearing case: a prefixed 1M-context model must NOT fall to
    // the 180K unknown-model budget.
    expect(computeChunkCharBudget('anthropic:claude-sonnet-5', null)).toBe(budgetFor(1_000_000));
    expect(computeChunkCharBudget('anthropic:claude-sonnet-5', null)).not.toBe(UNKNOWN_BUDGET);
  });

  test('unknown models fall back to the conservative 180K budget', () => {
    expect(computeChunkCharBudget('some-custom-model', null)).toBe(UNKNOWN_BUDGET);
    expect(computeChunkCharBudget('unknown-provider:custom-model', null)).toBe(UNKNOWN_BUDGET);
  });

  test('existing known Anthropic model budgets do not regress', () => {
    expect(computeChunkCharBudget('anthropic:claude-sonnet-5', null)).toBe(budgetFor(1_000_000));
    expect(computeChunkCharBudget('anthropic:claude-sonnet-4-6', null)).toBe(budgetFor(200_000));
    expect(computeChunkCharBudget('anthropic:claude-haiku-4-5-20251001', null)).toBe(budgetFor(200_000));
  });

  test('config override wins over the map', () => {
    expect(computeChunkCharBudget('claude-sonnet-5', 200_000)).toBe(
      Math.floor(200_000 * CHARS_PER_TOKEN),
    );
  });
});
