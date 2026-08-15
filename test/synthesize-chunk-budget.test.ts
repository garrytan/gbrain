/**
 * computeChunkCharBudget — MODEL_CONTEXT_TOKENS resolution.
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
import { computeChunkCharBudget } from '../src/core/cycle/synthesize.ts';

// Mirror the module's constants (deliberately duplicated: a silent change to
// either should fail this suite, not be absorbed by it).
const CHARS_PER_TOKEN = 3.5;
const HEADROOM_RATIO = 0.9;
const UNKNOWN_BUDGET = Math.floor(180_000 * CHARS_PER_TOKEN);
const budgetFor = (contextTokens: number) =>
  Math.floor(contextTokens * HEADROOM_RATIO * CHARS_PER_TOKEN);

describe('computeChunkCharBudget — model resolution', () => {
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
    expect(computeChunkCharBudget('openai:gpt-5', null)).toBe(UNKNOWN_BUDGET);
    expect(computeChunkCharBudget('some-custom-model', null)).toBe(UNKNOWN_BUDGET);
  });

  test('config override wins over the map', () => {
    expect(computeChunkCharBudget('claude-sonnet-5', 200_000)).toBe(
      Math.floor(200_000 * CHARS_PER_TOKEN),
    );
  });
});
