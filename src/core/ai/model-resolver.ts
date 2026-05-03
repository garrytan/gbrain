/**
 * Parse and validate `provider:model` strings against the recipe registry.
 */

import type { ParsedModelId, Recipe, TouchpointKind } from './types.ts';
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

/** Resolve a `provider:model` string to a Recipe. Throws AIConfigError if unknown. */
export function resolveRecipe(modelId: string): { parsed: ParsedModelId; recipe: Recipe } {
  const parsed = parseModelId(modelId);
  const recipe = getRecipe(parsed.providerId);
  if (!recipe) {
    throw new AIConfigError(
      `Unknown provider: "${parsed.providerId}"`,
      `Known providers: ${[...knownProviderIds()].join(', ')}. Add a new recipe at src/core/ai/recipes/.`,
    );
  }
  return { parsed, recipe };
}

/** Assert the resolved recipe actually offers the requested touchpoint. */
export function assertTouchpoint(recipe: Recipe, touchpoint: TouchpointKind, modelId: string): void {
  if (!recipe.touchpoints[touchpoint as 'embedding' | 'expansion']) {
    throw new AIConfigError(
      `Provider "${recipe.id}" does not support touchpoint "${touchpoint}".`,
      touchpoint === 'embedding' && recipe.id === 'anthropic'
        ? 'Anthropic has no embedding model. Use openai or google for embeddings.'
        : undefined,
    );
  }
  const supportedModels = recipe.touchpoints[touchpoint as 'embedding' | 'expansion']?.models ?? [];
  if (supportedModels.length > 0 && !supportedModels.includes(modelId)) {
    // Non-fatal: providers like ollama/litellm accept arbitrary model ids. We only warn for native providers.
    if (recipe.tier === 'native') {
      throw new AIConfigError(
        `Model "${modelId}" is not listed for ${recipe.name} ${touchpoint}.`,
        `Known models: ${supportedModels.join(', ')}. Use one of these or add it to the recipe.`,
      );
    }
  }
}

export function knownProviderIds(): string[] {
  return [...RECIPES.keys()];
}
