/**
 * Anti-rot guard (#1607): every hardcoded default model string shipped in
 * source code must pass the native-recipe chat allowlist. Hardcoded defaults
 * do NOT get the config `extendedModels` escape hatch in assertTouchpoint,
 * so a default that drifts out of its recipe's allowlist throws "not listed"
 * at runtime — exactly how the eval cross-modal defaults rotted (gpt-4o was
 * the shipped slot-A default while the openai chat allowlist rejected it).
 *
 * Covers: cross-modal DEFAULT_SLOTS, model-config DEFAULT_ALIASES and
 * TIER_DEFAULTS. Also asserts DEFAULT_SLOTS models are priced from the
 * canonical table so cost estimates don't silently go blind.
 */

import { describe, test, expect } from 'bun:test';
import { DEFAULT_SLOTS } from '../src/core/cross-modal-eval/runner.ts';
import { DEFAULT_ALIASES, TIER_DEFAULTS } from '../src/core/model-config.ts';
import { resolveRecipe, assertTouchpoint } from '../src/core/ai/model-resolver.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';

function expectInChatAllowlist(model: string, label: string) {
  const { parsed, recipe } = resolveRecipe(model);
  expect(
    () => assertTouchpoint(recipe, 'chat', parsed.modelId),
    `${label} default "${model}" is not in the ${recipe.id} chat allowlist`,
  ).not.toThrow();
}

describe('shipped default models pass native chat allowlists (#1607)', () => {
  test('eval cross-modal DEFAULT_SLOTS', () => {
    for (const slot of DEFAULT_SLOTS) {
      expectInChatAllowlist(slot.model, `slot ${slot.id}`);
    }
  });

  test('eval cross-modal DEFAULT_SLOTS are priced from canonical', () => {
    for (const slot of DEFAULT_SLOTS) {
      expect(canonicalLookup(slot.model), `${slot.model} has no canonical pricing`).toBeDefined();
    }
  });

  test('model-config DEFAULT_ALIASES', () => {
    for (const [alias, model] of Object.entries(DEFAULT_ALIASES)) {
      expectInChatAllowlist(model, `alias "${alias}"`);
    }
  });

  test('model-config TIER_DEFAULTS', () => {
    for (const [tier, model] of Object.entries(TIER_DEFAULTS)) {
      expectInChatAllowlist(model, `tier "${tier}"`);
    }
  });
});
