/**
 * The model `embedMultimodal` (gateway.ts) would embed with
 * (`embedding_multimodal_model`, else `embedding_model`) when it can embed
 * multimodal input, otherwise null. It applies the same recipe and model
 * allow-list checks `embedMultimodal` raises on, without the call. Hybrid
 * search routes a query to the image column only when this is set: on a
 * text-only install (the default `voyage:voyage-4`) the image embed always
 * throws, and routing there only dropped the keyword arm and expansion.
 * An unconfigured gateway answers null.
 */
import { getEmbeddingModel, getMultimodalModel } from './gateway.ts';
import { resolveRecipe } from './model-resolver.ts';

export function multimodalEmbeddingModel(): string | null {
  try {
    const modelStr = getMultimodalModel() ?? getEmbeddingModel();
    const { parsed, recipe } = resolveRecipe(modelStr);
    const touchpoint = recipe.touchpoints.embedding;
    if (!touchpoint?.supports_multimodal) return null;
    if (touchpoint.multimodal_models && !touchpoint.multimodal_models.includes(parsed.modelId)) return null;
    return modelStr;
  } catch {
    return null;
  }
}
