/**
 * Dead-alias guard — DEFAULT_ALIASES / TIER_DEFAULTS must point at LIVE,
 * recipe-listed, priced chat models.
 *
 * The sibling of test/default-model-panels.test.ts and
 * test/cross-modal-default-slots.test.ts (#3510), closing the last unguarded
 * hardcoded-default surface (#2507): `gemini` pointed at `google:gemini-3-pro`
 * — only ever a preview id (`gemini-3-pro-preview`), shut down, never
 * chat-listed nor priced — for months because nothing pinned alias targets to
 * a recipe list. The guard only works if recipes list LIVE models — do not
 * re-add a retired model to a recipe to quiet this test.
 *
 * Alias values feed the subagent queue (classifyCapabilities requires a
 * provider-qualified, tool-capable model), so this also pins parseability
 * and supports_tools. The `gpt` alias resolves DYNAMICALLY at runtime
 * (account discovery); its static DEFAULT_ALIASES entry is the documented
 * floor and must satisfy the same liveness bar.
 */
import { describe, expect, test } from 'bun:test';

import { DEFAULT_ALIASES, TIER_DEFAULTS } from '../src/core/model-config.ts';
import { getRecipe } from '../src/core/ai/recipes/index.ts';
import { resolveRecipe } from '../src/core/ai/model-resolver.ts';
import { splitProviderModelId } from '../src/core/model-id.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';

const ALL_DEFAULTS: Array<[string, string]> = [
  ...Object.entries(DEFAULT_ALIASES).map(([k, v]) => [`alias:${k}`, v] as [string, string]),
  ...Object.entries(TIER_DEFAULTS).map(([k, v]) => [`tier:${k}`, v] as [string, string]),
];

describe('DEFAULT_ALIASES + TIER_DEFAULTS ↔ recipe consistency (dead-alias guard)', () => {
  test('every default carries an explicit provider prefix and a known recipe', () => {
    for (const [name, target] of ALL_DEFAULTS) {
      const { provider, model } = splitProviderModelId(target);
      expect(provider, `${name} → "${target}" must be provider-qualified`).not.toBeNull();
      expect(model.length, `${name} → "${target}" has an empty model tail`).toBeGreaterThan(0);
      expect(getRecipe(provider!), `${name} → unknown recipe "${provider}"`).toBeDefined();
    }
  });

  test('every default target is LISTED in its recipe chat touchpoint (after recipe aliases)', () => {
    for (const [name, target] of ALL_DEFAULTS) {
      // resolveRecipe applies recipe-level aliases (e.g. anthropic's
      // undated → dated rewrites) before the listing check, matching what
      // the gateway does at call time.
      const { parsed, recipe } = resolveRecipe(target);
      const chatModels = recipe.touchpoints.chat?.models ?? [];
      expect(
        chatModels,
        `${name} → "${target}" not listed for ${recipe.id} chat — the alias resolves to a dead model`,
      ).toContain(parsed.modelId);
    }
  });

  test('every default target supports tool calling (subagent queue requirement)', () => {
    for (const [name, target] of ALL_DEFAULTS) {
      const { recipe } = resolveRecipe(target);
      expect(
        recipe.touchpoints.chat?.supports_tools,
        `${name} → "${target}": ${recipe.id} chat lacks supports_tools`,
      ).toBe(true);
    }
  });

  test('every default target has a canonical pricing entry', () => {
    for (const [name, target] of ALL_DEFAULTS) {
      expect(
        canonicalLookup(target),
        `${name} → "${target}" missing from CANONICAL_PRICING`,
      ).toBeDefined();
    }
  });
});
