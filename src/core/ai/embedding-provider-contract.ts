import type { EmbeddingTouchpoint, Recipe } from './types.ts';

/**
 * Shared embedding-provider contract for recipes whose concrete embedding
 * model is supplied by user/runtime config rather than by a static recipe list.
 */
export interface EmbeddingProviderContract {
  recipeId: string;
  modelId: string;
  touchpoint: EmbeddingTouchpoint;
  userProvidedModels: boolean;
  requiresConfiguredUserModel: boolean;
}

export function embeddingProviderContract(
  recipe: Recipe,
  modelId: string,
  touchpoint: EmbeddingTouchpoint,
): EmbeddingProviderContract {
  const userProvidedModels = touchpoint.user_provided_models === true;
  return {
    recipeId: recipe.id,
    modelId,
    touchpoint,
    userProvidedModels,
    requiresConfiguredUserModel:
      userProvidedModels && Array.isArray(touchpoint.models) && touchpoint.models.length === 0,
  };
}
