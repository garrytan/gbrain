/**
 * Consistency guard for the takes-quality DEFAULT_MODEL_PANEL — the sibling
 * of test/cross-modal-default-slots.test.ts (#3510).
 *
 * `google:gemini-1.5-pro` sat in the panel after Google retired it, and
 * `openai:gpt-4o` after the OpenAI recipe dropped it from its chat list —
 * either way the gateway rejects the slot on every default run. The guard
 * only works if recipes list LIVE models: removing a dead model from its
 * recipe makes every hardcoded default that still names it fail here at
 * once. Do not re-add retired models to a recipe to quiet this test.
 */
import { describe, expect, test } from 'bun:test';

import { DEFAULT_MODEL_PANEL } from '../src/core/takes-quality-eval/runner.ts';
import { getPricing } from '../src/core/takes-quality-eval/pricing.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { splitProviderModelId } from '../src/core/model-id.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';

describe('takes-quality DEFAULT_MODEL_PANEL ↔ recipe consistency', () => {
  test('every default panel model is listed in its recipe chat touchpoint', () => {
    for (const id of DEFAULT_MODEL_PANEL) {
      const { provider, model } = splitProviderModelId(id);
      expect(provider).not.toBeNull();
      const recipe = getRecipe(provider!);
      expect(recipe, `unknown recipe "${provider}"`).toBeDefined();
      expect(
        recipe!.touchpoints.chat?.models ?? [],
        `"${model}" not listed for ${provider} chat — the default panel can never run`,
      ).toContain(model);
    }
  });

  test('every default panel model prices via canonical AND the takes-quality allowlist', () => {
    for (const id of DEFAULT_MODEL_PANEL) {
      expect(canonicalLookup(id), `"${id}" missing from CANONICAL_PRICING`).toBeDefined();
      // getPricing throws PricingNotFoundError if the model is missing from
      // SUPPORTED_MODELS — a default that can't be budget-gated aborts every
      // `--budget-usd` run before the first call.
      expect(getPricing(id)).toBeDefined();
    }
  });

  test('panel spans three distinct providers (uncorrelated blind spots)', () => {
    const providers = new Set(DEFAULT_MODEL_PANEL.map((id) => splitProviderModelId(id).provider));
    expect(providers.size).toBe(3);
  });
});
