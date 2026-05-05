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

/** Assert the resolved recipe actually offers the requested touchpoint. */
export function assertTouchpoint(recipe: Recipe, touchpoint: TouchpointKind, modelId: string): void {
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
