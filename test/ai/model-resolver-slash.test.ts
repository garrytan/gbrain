/**
 * v0.41.21.0 — gateway-resolver parseModelId accepts slash form.
 *
 * Codex adversarial review caught a load-bearing gap: the v0.41.21.0
 * pricing-side fix (`src/core/model-id.ts:splitProviderModelId`) let
 * BudgetTracker pass for slash-form ids, but `gateway.chat()` then routed
 * through `src/core/ai/model-resolver.ts:parseModelId` which still hard-
 * rejected no-colon ids → AIConfigError mid-judge → judge_failed for the
 * end-to-end user. The fix here extends model-resolver.ts:parseModelId to
 * also accept slash form, completing the end-to-end bug class closure.
 *
 * Bare names without ANY separator STILL throw — gateway routing always
 * needs an explicit provider. This file pins both:
 *   - slash form parses successfully
 *   - bare names still throw (back-compat)
 */

import { describe, test, expect } from 'bun:test';
import { parseModelId, resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';

describe('model-resolver parseModelId (gateway-side)', () => {
  describe('happy paths', () => {
    test('colon form parses (back-compat)', () => {
      expect(parseModelId('anthropic:claude-sonnet-4-6')).toEqual({
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
      });
    });

    test('slash form parses (THE END-TO-END FIX)', () => {
      // Pre-v0.41.21.0: threw AIConfigError "missing a provider prefix"
      // → brainstorm/lsd judge_failed despite pricing fix.
      expect(parseModelId('anthropic/claude-sonnet-4-6')).toEqual({
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6',
      });
    });

    test('colon wins over slash (OpenRouter nested-id semantic)', () => {
      // openrouter:anthropic/claude-... → transport=openrouter, model
      // includes the nested anthropic/ prefix verbatim.
      expect(parseModelId('openrouter:anthropic/claude-sonnet-4.6')).toEqual({
        providerId: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4.6',
      });
    });

    test('provider name is lowercased', () => {
      expect(parseModelId('Anthropic/claude-sonnet-4-6').providerId).toBe('anthropic');
      expect(parseModelId('OPENAI:gpt-5').providerId).toBe('openai');
    });
  });

  describe('reject paths preserved', () => {
    test('bare name with NO separator throws', () => {
      expect(() => parseModelId('claude-sonnet-4-6')).toThrow(AIConfigError);
      expect(() => parseModelId('claude-sonnet-4-6')).toThrow(/missing a provider prefix/);
    });

    test('empty string throws', () => {
      expect(() => parseModelId('')).toThrow(AIConfigError);
    });

    test('null/undefined throws', () => {
      expect(() => parseModelId(null as unknown as string)).toThrow(AIConfigError);
      expect(() => parseModelId(undefined as unknown as string)).toThrow(AIConfigError);
    });

    test('trailing-only separator throws (empty model)', () => {
      expect(() => parseModelId('anthropic:')).toThrow(AIConfigError);
      expect(() => parseModelId('anthropic/')).toThrow(AIConfigError);
    });

    test('leading-only separator throws (empty provider)', () => {
      expect(() => parseModelId(':claude-sonnet-4-6')).toThrow(AIConfigError);
      expect(() => parseModelId('/claude-sonnet-4-6')).toThrow(AIConfigError);
    });
  });

  describe('resolveRecipe end-to-end with slash form', () => {
    test('slash form resolves to the same recipe as colon form', () => {
      const colonResult = resolveRecipe('anthropic:claude-sonnet-4-6');
      const slashResult = resolveRecipe('anthropic/claude-sonnet-4-6');
      expect(slashResult.recipe.id).toBe(colonResult.recipe.id);
      expect(slashResult.parsed.providerId).toBe(colonResult.parsed.providerId);
      expect(slashResult.parsed.modelId).toBe(colonResult.parsed.modelId);
    });

    test('slash form gives the expected recipe for opus', () => {
      const result = resolveRecipe('anthropic/claude-opus-4-7');
      expect(result.parsed.providerId).toBe('anthropic');
      expect(result.parsed.modelId).toBe('claude-opus-4-7');
    });
  });
});
