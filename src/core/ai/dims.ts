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
import { AIConfigError } from './errors.ts';

// Voyage hosted models that accept `output_dimension` (values:
// 256 / 512 / 1024 / 2048). Per Voyage's API parameter docs as of 2026-05.
// voyage-4-nano is intentionally NOT in this set: it's the open-weight
// variant listed separately by Voyage as fixed 1024-dim. Adding it here
// would tell the SDK to send `dimensions: N`, which voyageCompatFetch then
// rewrites to `output_dimension: N` — and Voyage's hosted nano endpoint
// rejects the parameter. The negative regression assertion in
// test/ai/gateway.test.ts pins this contract.
const VOYAGE_OUTPUT_DIMENSION_MODELS = new Set([
  'voyage-4-large',
  'voyage-4',
  'voyage-4-lite',
  'voyage-3-large',
  'voyage-3.5',
  'voyage-3.5-lite',
  'voyage-code-3',
]);

// Voyage's flexible-dim endpoint only accepts these four discrete values.
// Per Voyage's API docs (2026-05). Out-of-range requests are rejected with
// HTTP 400 by the upstream — catching it locally produces a clearer error
// with the valid-values hint. The most common way to hit this in
// production: `embedding_model: voyage:voyage-4-large` configured without
// `embedding_dimensions`, where the gateway falls back to
// DEFAULT_EMBEDDING_DIMENSIONS=1536 (an OpenAI default, not a Voyage one).
export const VOYAGE_VALID_OUTPUT_DIMS = [256, 512, 1024, 2048] as const;

export function supportsVoyageOutputDimension(modelId: string): boolean {
  return VOYAGE_OUTPUT_DIMENSION_MODELS.has(modelId);
}

export function isValidVoyageOutputDim(dims: number): boolean {
  return (VOYAGE_VALID_OUTPUT_DIMS as readonly number[]).includes(dims);
}

// v0.35.0.0+ ZeroEntropy zembed-1 flexible-dim allowlist. zembed-1 distills
// from zerank-2 (Matryoshka-style); smaller dims trade quality for storage.
// ZE rejects any other value with HTTP 400; catching it locally produces a
// clearer error with the valid-values hint. Same failure mode as the Voyage
// case: `embedding_model: zeroentropyai:zembed-1` configured without
// `embedding_dimensions` falls back to DEFAULT_EMBEDDING_DIMENSIONS=1536
// (an OpenAI default), which ZE doesn't accept.
const ZEROENTROPY_DIM_MODELS = new Set(['zembed-1']);
export const ZEROENTROPY_VALID_DIMS = [2560, 1280, 640, 320, 160, 80, 40] as const;

export function supportsZeroEntropyDimension(modelId: string): boolean {
  return ZEROENTROPY_DIM_MODELS.has(modelId);
}

export function isValidZeroEntropyDim(dims: number): boolean {
  return (ZEROENTROPY_VALID_DIMS as readonly number[]).includes(dims);
}

// v0.36.0.0 (D13): OpenAI text-embedding-3-* accepts arbitrary truncation via
// Matryoshka — any positive integer up to the model's native size. When a
// brain is configured with `embedding_dimensions` OUTSIDE that range, OpenAI
// returns HTTP 400 at first embed. We catch it locally with a paste-ready
// fix so users don't see opaque "vector dimension mismatch" errors after
// `gbrain ze-switch --undo` lands them on OpenAI at the wrong dim.
const OPENAI_TEXT3_MAX_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
};

export function isOpenAITextEmbedding3Model(modelId: string): boolean {
  return modelId in OPENAI_TEXT3_MAX_DIMS;
}

export function maxOpenAITextEmbedding3Dim(modelId: string): number | undefined {
  return OPENAI_TEXT3_MAX_DIMS[modelId];
}

export function isValidOpenAITextEmbedding3Dim(modelId: string, dims: number): boolean {
  const max = OPENAI_TEXT3_MAX_DIMS[modelId];
  if (max === undefined) return false;
  return Number.isInteger(dims) && dims >= 1 && dims <= max;
}

/**
 * Build the providerOptions blob for embedMany() that pins output dimensions.
 *
 * Matryoshka providers (OpenAI text-embedding-3, Gemini embedding-001) can be
 * asked to return reduced-dim vectors. Anthropic does not take a dimension
 * parameter. Most openai-compatible providers do not either. Voyage's
 * endpoint accepts `output_dimension`, but the AI SDK openai-compatible
 * adapter only forwards `dimensions`; gateway.ts translates that field to
 * Voyage's wire name in voyageCompatFetch.
 *
 * v0.35.0.0+ 4th param `inputType`: 'query' | 'document' for asymmetric
 * providers (ZE zembed-1, Voyage v3+, MiniMax embo-01). When omitted, the
 * existing document-encoding behavior is preserved (no `input_type` field
 * emitted for symmetric providers; legacy hardcoded `type:'db'` for
 * embo-01). gateway.embedQuery() threads `'query'`; gateway.embed() threads
 * `'document'`. Per-model filtering happens INSIDE the switch — the field
 * is NEVER emitted for providers that don't accept it (OpenAI text-3,
 * DashScope, Zhipu) so the request body stays clean for those endpoints.
 *
 * `trustCustomDims` — recipes that declare `trust_custom_dims: true`
 * (ollama, llama-server) promise every listed embedding model accepts
 * OpenAI-shaped `dimensions` truncation (Ollama's `/v1/embeddings` honors
 * it; llama-server serves whatever model the user launched, so the user
 * is asserting it does too). Before this flag was wired here, it only
 * relaxed the schema-width validation in embedding-dim-check.ts — a brain
 * could be configured for a truncated width, but the gateway silently
 * requested the model's native (larger) output, producing a dim mismatch
 * that only surfaced at first embed (or in `gbrain doctor`'s live probe).
 * This is the generic fallback for any openai-compatible recipe that
 * opts in, so it covers ollama, llama-server, and future local-model
 * recipes uniformly instead of a per-model allowlist entry each time.
 */
export function dimsProviderOptions(
  implementation: Implementation,
  modelId: string,
  dims: number,
  inputType?: 'query' | 'document',
  trustCustomDims?: boolean,
): Record<string, any> | undefined {
  switch (implementation) {
    case 'native-openai': {
      // text-embedding-3-* supports dimensions; text-embedding-ada-002 does not.
      // OpenAI embeddings are symmetric — inputType ignored.
      if (modelId.startsWith('text-embedding-3')) {
        // v0.36.0.0 (D13): fail-loud when configured dim is outside the
        // model's Matryoshka range. OpenAI returns HTTP 400 otherwise with
        // a generic message that misroutes as a network blip.
        if (isOpenAITextEmbedding3Model(modelId) && !isValidOpenAITextEmbedding3Dim(modelId, dims)) {
          const max = maxOpenAITextEmbedding3Dim(modelId)!;
          throw new AIConfigError(
            `OpenAI model "${modelId}" supports embedding_dimensions in 1..${max}, got ${dims}.`,
            `Set \`embedding_dimensions\` to a value between 1 and ${max} ` +
            `(\`gbrain config set embedding_dimensions ${Math.min(1024, max)}\` is a common default).`,
          );
        }
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
      // ZE zembed-1 — flexible Matryoshka dims + asymmetric input_type.
      // Lives BEFORE the generic openai-compatible fall-through to avoid
      // sending input_type to providers (Azure/DashScope/Zhipu) that
      // would reject it.
      if (supportsZeroEntropyDimension(modelId)) {
        if (!isValidZeroEntropyDim(dims)) {
          throw new AIConfigError(
            `ZeroEntropy model "${modelId}" supports dimensions only in ` +
            `{${ZEROENTROPY_VALID_DIMS.join(', ')}}, got ${dims}.`,
            `Set \`embedding_dimensions\` to one of ` +
            `${ZEROENTROPY_VALID_DIMS.join('/')} in your gbrain config.`,
          );
        }
        return {
          openaiCompatible: {
            dimensions: dims,
            input_type: inputType ?? 'document',
          },
        };
      }
      // Voyage hosted flexible-dim models — accept `output_dimension`
      // (translated by voyageCompatFetch) AND `input_type: query|document`
      // for asymmetric retrieval. inputType is opt-in: when undefined,
      // emit no field (preserves pre-v0.35.0.0 callers + existing tests).
      // When threaded explicitly by embedQuery()/embed(), it reaches Voyage.
      if (supportsVoyageOutputDimension(modelId)) {
        // Fail-loud at the embed boundary if the user configured a dim
        // Voyage doesn't accept. The most common path here: a brain with
        // `embedding_model: voyage:voyage-4-large` but no explicit
        // `embedding_dimensions`, where the gateway falls back to the
        // module default (1536). Without this guard, Voyage's HTTP 400 is
        // the only signal — usually mis-attributed as a transient network
        // error.
        if (!isValidVoyageOutputDim(dims)) {
          throw new AIConfigError(
            `Voyage model "${modelId}" supports output_dimension only in ` +
            `{${VOYAGE_VALID_OUTPUT_DIMS.join(', ')}}, got ${dims}.`,
            `Set \`embedding_dimensions\` to one of ` +
            `${VOYAGE_VALID_OUTPUT_DIMS.join('/')} in your gbrain config, or ` +
            `switch to a fixed-dim Voyage model (e.g. voyage-3, voyage-3-lite).`,
          );
        }
        return {
          openaiCompatible: {
            dimensions: dims,
            ...(inputType ? { input_type: inputType } : {}),
          },
        };
      }
      // OpenAI text-embedding-3 family on the openai-compatible adapter
      // (Azure OpenAI hosts these via its OpenAI-compatible /embeddings
      // endpoint). The provider defaults to the model's native size (3072
      // for `-large`, 1536 for `-small`); without `dimensions`, brains
      // configured for a smaller width (e.g. 1536) hard-fail at first embed.
      // Azure/OpenAI-compat embeddings are symmetric — inputType ignored.
      // v0.36.0.0 (D13): same range validation as native-openai path.
      if (modelId.startsWith('text-embedding-3')) {
        if (isOpenAITextEmbedding3Model(modelId) && !isValidOpenAITextEmbedding3Dim(modelId, dims)) {
          const max = maxOpenAITextEmbedding3Dim(modelId)!;
          throw new AIConfigError(
            `OpenAI model "${modelId}" supports embedding_dimensions in 1..${max}, got ${dims}.`,
            `Set \`embedding_dimensions\` to a value between 1 and ${max} ` +
            `(\`gbrain config set embedding_dimensions ${Math.min(1024, max)}\` is a common default).`,
          );
        }
        return { openaiCompatible: { dimensions: dims } };
      }
      // DashScope text-embedding-v3 (Matryoshka 64-1024) and Zhipu
      // embedding-3 (Matryoshka 256-2048) both accept `dimensions` on the
      // OpenAI-compat path. Without this, user-selected non-default dims are
      // silently ignored and the provider returns its default size.
      // Symmetric retrieval — inputType ignored.
      if (modelId === 'text-embedding-v3' || modelId === 'embedding-3') {
        return { openaiCompatible: { dimensions: dims } };
      }
      // MiniMax embo-01 takes a `type: 'db' | 'query'` field for asymmetric
      // retrieval. Today still hardcoded to 'db' for back-compat — opting
      // into the new inputType seam is a follow-up (see plan's deferred
      // section "Fix MiniMax embo-01 asymmetry"). When fixed: map
      // inputType==='query' → type:'query', else 'db'.
      if (modelId === 'embo-01') {
        return { openaiCompatible: { type: 'db' } };
      }
      // Generic trust_custom_dims fallback (ollama, llama-server, and any
      // future local-model recipe that opts in). These recipes serve
      // arbitrary user-launched/pulled models, so there's no fixed model-id
      // allowlist to match against — the recipe's own `trust_custom_dims`
      // flag is the signal that its OpenAI-compatible endpoint honors
      // `dimensions` truncation. Symmetric retrieval assumed — inputType
      // ignored, matching the DashScope/Zhipu/text-3 branches above.
      if (trustCustomDims) {
        return { openaiCompatible: { dimensions: dims } };
      }
      return undefined;
  }
}
