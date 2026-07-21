/**
 * #2507 / #1270 — provider-recipe + default-alias rot guards.
 *
 * The Google recipe shipped retired model ids (gemini-2.0-flash*,
 * gemini-1.5-pro) while DEFAULT_ALIASES.gemini pointed at a model that 404s
 * on the Generative Language API, and the cross-modal DEFAULT_SLOTS
 * hardcoded ids outside every recipe allowlist. These tests pin the repaired
 * state AND add the structural anti-rot invariant: every default alias (and
 * every default cross-modal slot, which resolves through the aliases) must
 * name a chat model its recipe's allowlist accepts — so a future model-family
 * bump that touches DEFAULT_ALIASES without refreshing the recipe fails CI
 * instead of degrading `think` / cross-modal runs at call time.
 */

import { describe, test, expect } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { assertTouchpoint, resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { DEFAULT_ALIASES } from '../../src/core/model-config.ts';
import { DEFAULT_SLOTS, resolveSlots } from '../../src/core/cross-modal-eval/runner.ts';

describe('google recipe — current model ids (#2507)', () => {
  test('retired gemini ids are gone from the chat allowlist', () => {
    const chat = getRecipe('google')!.touchpoints.chat!;
    for (const retired of ['gemini-2.0-flash', 'gemini-2.0-flash-exp', 'gemini-1.5-pro']) {
      expect(chat.models).not.toContain(retired);
    }
  });

  test('current GA ids pass assertTouchpoint for chat', () => {
    for (const id of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-pro-latest', 'gemini-flash-latest']) {
      expect(() => assertTouchpoint(getRecipe('google')!, 'chat', id)).not.toThrow();
    }
  });

  test('current flash ids pass assertTouchpoint for expansion', () => {
    for (const id of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest']) {
      expect(() => assertTouchpoint(getRecipe('google')!, 'expansion', id)).not.toThrow();
    }
  });
});

describe('DEFAULT_ALIASES stay recipe-valid (anti-rot, #2507)', () => {
  test('every default alias resolves to a chat model its recipe allows', () => {
    for (const [alias, full] of Object.entries(DEFAULT_ALIASES)) {
      const { parsed, recipe } = resolveRecipe(full);
      expect(
        () => assertTouchpoint(recipe, 'chat', parsed.modelId),
        `alias "${alias}" → "${full}" must be in the ${recipe.id} recipe chat allowlist`,
      ).not.toThrow();
    }
  });
});

describe('cross-modal DEFAULT_SLOTS (#1270)', () => {
  test('default slots resolve via aliases to recipe-allowlisted chat models', async () => {
    const resolved = await resolveSlots(DEFAULT_SLOTS);
    expect(resolved).toHaveLength(3);
    for (const slot of resolved) {
      expect(slot.model).toContain(':'); // full provider:model id after resolution
      const { parsed, recipe } = resolveRecipe(slot.model);
      expect(
        () => assertTouchpoint(recipe, 'chat', parsed.modelId),
        `slot ${slot.id} → "${slot.model}" must be in the ${recipe.id} recipe chat allowlist`,
      ).not.toThrow();
    }
    // Three distinct provider families so blind spots don't correlate.
    expect(new Set(resolved.map(s => s.model.split(':')[0]))).toEqual(
      new Set(['openai', 'anthropic', 'google']),
    );
  });

  test('resolveSlots passes full provider:model ids through unchanged', async () => {
    const custom = [{ id: 'A', model: 'ollama:llama3' }];
    expect(await resolveSlots(custom)).toEqual(custom);
  });
});
