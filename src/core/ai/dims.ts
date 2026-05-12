/**
 * Per-provider dimension parameter resolver.
 *
 * Critical: OpenAI text-embedding-3-* defaults to 3072 dims on the API side.
 * Without explicit dimensions passthrough, existing 1536-dim brains break.
 * Similarly, Gemini gemini-embedding-001 defaults to 3072.
 *
 * This module centralizes the knowledge of "which provider needs which
 * providerOptions shape to produce vector(N)".
 */

import type { Implementation } from './types.ts';

const VOYAGE_OUTPUT_DIMENSION_MODELS = new Set([
  'voyage-4-large',
  'voyage-4',
  'voyage-4-lite',
  'voyage-3-large',
  'voyage-3.5',
  'voyage-3.5-lite',
  'voyage-code-3',
]);

/**
 * Build the providerOptions blob for embedMany() that pins output dimensions.
 *
 * Matryoshka providers (OpenAI text-embedding-3, Gemini embedding-001) can be
 * asked to return reduced-dim vectors. Anthropic does not take a dimension
 * parameter. Most openai-compatible providers do not either, but Voyage's
 * OpenAI-compatible embeddings endpoint accepts `output_dimension`.
 */
export function dimsProviderOptions(
  implementation: Implementation,
  modelId: string,
  dims: number,
): Record<string, any> | undefined {
  switch (implementation) {
    case 'native-openai': {
      // text-embedding-3-* supports dimensions; text-embedding-ada-002 does not.
      if (modelId.startsWith('text-embedding-3')) {
        return { openai: { dimensions: dims } };
      }
      return undefined;
    }
    case 'native-google': {
      if (modelId.startsWith('gemini-embedding') || modelId === 'text-embedding-004') {
        return { google: { outputDimensionality: dims } };
      }
      return undefined;
    }
    case 'native-anthropic':
      // Anthropic has no embedding model.
      return undefined;
    case 'openai-compatible':
      // Most openai-compatible providers (Ollama, LM Studio, vLLM, LiteLLM)
      // do not expose a standard dimensions knob. Voyage's compat endpoint is
      // the exception: it accepts output_dimension and defaults to 1024 dims.
      if (VOYAGE_OUTPUT_DIMENSION_MODELS.has(modelId)) {
        return { openaiCompatible: { output_dimension: dims } };
      }
      // OpenAI text-embedding-3 family on the openai-compatible adapter
      // (Azure OpenAI hosts these via its OpenAI-compatible /embeddings
      // endpoint). The provider defaults to the model's native size (3072
      // for `-large`, 1536 for `-small`); without `dimensions`, brains
      // configured for a smaller width (e.g. 1536) hard-fail at first embed.
      if (modelId.startsWith('text-embedding-3')) {
        return { openaiCompatible: { dimensions: dims } };
      }
      // DashScope text-embedding-v3 (Matryoshka 64-1024) and Zhipu
      // embedding-3 (Matryoshka 256-2048) both accept `dimensions` on the
      // OpenAI-compat path. Without this, user-selected non-default dims are
      // silently ignored and the provider returns its default size.
      if (modelId === 'text-embedding-v3' || modelId === 'embedding-3') {
        return { openaiCompatible: { dimensions: dims } };
      }
      // MiniMax embo-01 takes a `type: 'db' | 'query'` field for asymmetric
      // retrieval. Default to 'db' (the indexing path) so embed() works for
      // import. Queries also embed with type:'db', making retrieval
      // symmetric. Asymmetric query support is a follow-up TODO that needs
      // a query/document signal threaded through the embed seam.
      if (modelId === 'embo-01') {
        return { openaiCompatible: { type: 'db' } };
      }
      return undefined;
  }
}
