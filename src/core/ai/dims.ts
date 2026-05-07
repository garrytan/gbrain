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
      return undefined;
  }
}
