/**
 * Google/Gemini prompt-cache capability is a per-model predicate, not a flat
 * boolean: Gemini's implicit caching (the only kind the gateway can benefit
 * from — it sends no cache directives on the Google path) is default-on for
 * 2.5 and newer, and absent on 1.5/2.0.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { googleSupportsPromptCache } from '../../src/core/ai/recipes/google.ts';
import { getProviderCapabilities } from '../../src/core/ai/capabilities.ts';

describe('recipe: google prompt cache', () => {
  test('chat touchpoint wires the predicate, not a boolean', () => {
    const chat = getRecipe('google')!.touchpoints.chat!;
    expect(chat.supports_prompt_cache).toBe(googleSupportsPromptCache);
  });

  test('2.5 and newer cache; older families and non-Gemini ids do not', () => {
    expect(googleSupportsPromptCache('gemini-2.5-flash')).toBe(true);
    expect(googleSupportsPromptCache('gemini-2.5-pro')).toBe(true);
    expect(googleSupportsPromptCache('gemini-3-flash-preview')).toBe(true);
    // Version digits trail the family name on this one — position varies.
    expect(googleSupportsPromptCache('gemini-3.6-flash')).toBe(true);
    // `-latest` aliases carry no digits but always point at current models.
    expect(googleSupportsPromptCache('gemini-flash-latest')).toBe(true);
    expect(googleSupportsPromptCache('gemini-pro-latest')).toBe(true);

    expect(googleSupportsPromptCache('gemini-2.0-flash')).toBe(false);
    expect(googleSupportsPromptCache('gemini-2.0-flash-exp')).toBe(false);
    expect(googleSupportsPromptCache('gemini-1.5-pro')).toBe(false);
    expect(googleSupportsPromptCache('gemini-embedding-001')).toBe(false);
    expect(googleSupportsPromptCache('gemma-3-27b-it')).toBe(false);
  });

  test('off-list passthrough ids resolve through the capability layer', () => {
    // The recipe's `models` list is not enforced for native Google ids at the
    // config plane, so a newer Gemini the list has not caught up to still has
    // to be classified correctly.
    expect(getProviderCapabilities('google:gemini-2.5-flash').supportsPromptCaching).toBe(true);
    expect(getProviderCapabilities('google:gemini-1.5-pro').supportsPromptCaching).toBe(false);
  });
});
