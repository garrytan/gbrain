/**
 * Parse and validate `provider:model` strings against the recipe registry.
 */

import type { ParsedModelId, Recipe, TouchpointKind, ChatTouchpoint, EmbeddingTouchpoint, ExpansionTouchpoint } from './types.ts';
import { getRecipe, RECIPES } from './recipes/index.ts';
import { AIConfigError } from './errors.ts';

/** Split "openai:text-embedding-3-large" into { providerId, modelId }. */
export function parseModelId(id: string): ParsedModelId {
  if (!id || typeof id !== 'string') {
    throw new AIConfigError(
      `Invalid model id: ${JSON.stringify(id)}`,
      'Expected format: provider:model (e.g. openai:text-embedding-3-large)',
    );
  }
  const colon = id.indexOf(':');
  if (colon === -1) {
    throw new AIConfigError(
      `Model id "${id}" is missing a provider prefix.`,
      'Use format provider:model, e.g. openai:text-embedding-3-large',
    );
  }
  const providerId = id.slice(0, colon).trim().toLowerCase();
  const modelId = id.slice(colon + 1).trim();
  if (!providerId || !modelId) {
    throw new AIConfigError(
      `Model id "${id}" has empty provider or model.`,
      'Use format provider:model, e.g. openai:text-embedding-3-large',
    );
  }
  return { providerId, modelId };
}

/**
 * Resolve a `provider:model` string to a Recipe + canonical modelId.
 * Honors `recipe.aliases` (Codex F-OV-5) so users can pass undated forms.
 * Throws AIConfigError if unknown provider.
 */
export function resolveRecipe(modelId: string): { parsed: ParsedModelId; recipe: Recipe } {
  const parsed = parseModelId(modelId);
  const recipe = getRecipe(parsed.providerId);
  if (!recipe) {
    throw new AIConfigError(
      `Unknown provider: "${parsed.providerId}"`,
      `Known providers: ${[...knownProviderIds()].join(', ')}. Add a new recipe at src/core/ai/recipes/.`,
    );
  }
  // Apply alias if the modelId matches an alias key. Canonical wins.
  const canonical = recipe.aliases?.[parsed.modelId];
  if (canonical) {
    return { parsed: { providerId: parsed.providerId, modelId: canonical }, recipe };
  }
  return { parsed, recipe };
}

type KnownTouchpointKey = 'embedding' | 'expansion' | 'chat';

function getTouchpoint(recipe: Recipe, touchpoint: TouchpointKind): EmbeddingTouchpoint | ExpansionTouchpoint | ChatTouchpoint | undefined {
  if (touchpoint === 'embedding' || touchpoint === 'expansion' || touchpoint === 'chat') {
    return recipe.touchpoints[touchpoint as KnownTouchpointKey];
  }
  return undefined;
}

/**
 * Assert the resolved recipe actually offers the requested touchpoint.
 *
 * @param extendedModels Per-gateway-instance Set of additional models the
 *   user opted into via `cfg.chat_model` / `cfg.embedding_model` /
 *   `cfg.expansion_model` / `models.default` / `models.tier.*`. When the
 *   modelId is in this set, the native-recipe allowlist check is skipped
 *   (the user explicitly chose this model via config — provider rejection
 *   surfaces at HTTP call time, with a clear `model_not_found` from the
 *   provider).
 *
 *   Default code paths (hardcoded model strings in source code) MUST NOT
 *   pass this argument — typos in code still fail fast. Only config-derived
 *   model selection extends the allowlist.
 *
 *   v0.31.12 — replaces the earlier plan to soften the validator from throw
 *   to warn (which would have removed the fail-fast contract for chat/expand/
 *   embed all three; per Codex F4/F5 in plan review).
 */
export function assertTouchpoint(
  recipe: Recipe,
  touchpoint: TouchpointKind,
  modelId: string,
  extendedModels?: ReadonlySet<string>,
): void {
  const tp = getTouchpoint(recipe, touchpoint);
  if (!tp) {
    throw new AIConfigError(
      `Provider "${recipe.id}" does not support touchpoint "${touchpoint}".`,
      touchpoint === 'embedding' && recipe.id === 'anthropic'
        ? 'Anthropic has no embedding model. Use openai or google for embeddings.'
        : touchpoint === 'chat' && (recipe.id === 'voyage' || recipe.id === 'ollama')
          ? `${recipe.name} is configured here only for embeddings. Use openai/anthropic/google/deepseek/groq/together for chat.`
          : undefined,
    );
  }
  const supportedModels = tp.models ?? [];
  if (supportedModels.length > 0 && !supportedModels.includes(modelId)) {
    // Non-fatal: providers like ollama/litellm accept arbitrary model ids. We only warn for native providers.
    if (recipe.tier === 'native') {
      // v0.31.12 recipe-models merge: if the user opted into this model via
      // config (cfg.chat_model, models.default, models.tier.*), skip the
      // throw. The model goes to the provider; provider 404s surface as
      // `model_not_found` via `gbrain models doctor`.
      if (extendedModels && extendedModels.has(modelId)) {
        return;
      }
      throw new AIConfigError(
        `Model "${modelId}" is not listed for ${recipe.name} ${touchpoint}.`,
        `Known models: ${supportedModels.join(', ')}. Use one of these or add it to the recipe (or add an alias).`,
      );
    }
  }
}

export function knownProviderIds(): string[] {
  return [...RECIPES.keys()];
}
