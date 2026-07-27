/**
 * Consistency guard: every cross-modal DEFAULT_SLOTS model must be listed
 * in its recipe's chat touchpoint. `openai:gpt-4o` drifted out of the
 * OpenAI recipe while remaining the slot-A default — the gateway then
 * rejected slot A ("not listed for OpenAI chat") on every install, and the
 * 3-slot judge panel could never reach its 2-model quorum without a Google
 * key, pinning every batch verdict at inconclusive (which the nightly
 * quality probe surfaces as a doctor WARN).
 */
import { describe, expect, test } from 'bun:test';

import { DEFAULT_SLOTS } from '../src/core/cross-modal-eval/runner.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { splitProviderModelId } from '../src/core/model-id.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';

describe('cross-modal DEFAULT_SLOTS ↔ recipe consistency', () => {
  test('every default slot model is listed in its recipe chat touchpoint', () => {
    for (const slot of DEFAULT_SLOTS) {
      const { provider, model } = splitProviderModelId(slot.model);
      expect(provider).not.toBeNull();
      const recipe = getRecipe(provider!);
      expect(recipe, `slot ${slot.id}: unknown recipe "${provider}"`).toBeDefined();
      const chatModels = recipe!.touchpoints.chat?.models ?? [];
      expect(
        chatModels,
        `slot ${slot.id}: "${model}" not listed for ${provider} chat — the judge slot can never run`,
      ).toContain(model);
    }
  });

  test('every default slot model has a canonical pricing entry', () => {
    // Without one, estimateCost silently drops the slot from the
    // --max-usd pre-flight and est_cost_usd audit rows (~1/3 under-count).
    for (const slot of DEFAULT_SLOTS) {
      expect(
        canonicalLookup(slot.model),
        `slot ${slot.id}: "${slot.model}" missing from CANONICAL_PRICING`,
      ).toBeDefined();
    }
  });

  test('slots span three distinct providers (uncorrelated blind spots)', () => {
    const providers = new Set(DEFAULT_SLOTS.map(s => splitProviderModelId(s.model).provider));
    expect(providers.size).toBe(3);
  });
});
