import type { Recipe } from '../types.ts';

/**
 * NVIDIA NIM / API Catalog exposes OpenAI-compatible /v1/chat/completions
 * and /v1/embeddings APIs.
 *
 * Retrieval models use asymmetric encoding. The gateway maps gbrain's
 * document/query distinction to NVIDIA's wire values:
 *   document -> input_type: passage
 *   query    -> input_type: query
 *
 * The model ids below intentionally keep NVIDIA's full catalog ids because
 * the hosted endpoint expects values like `nvidia/nv-embedqa-e5-v5` in the
 * request body. Short aliases are provided for CLI ergonomics.
 */
export const nvidia: Recipe = {
  id: 'nvidia',
  name: 'NVIDIA NIM',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://integrate.api.nvidia.com/v1',
  auth_env: {
    required: ['NVIDIA_API_KEY'],
    setup_url: 'https://build.nvidia.com',
  },
  aliases: {
    'nv-embedqa-e5-v5': 'nvidia/nv-embedqa-e5-v5',
    'llama-nemotron-embed-1b-v2': 'nvidia/llama-nemotron-embed-1b-v2',
    'nemotron-3-super': 'nvidia/nemotron-3-super-120b-a12b',
    'nemotron-3-super-120b-a12b': 'nvidia/nemotron-3-super-120b-a12b',
    'nv-embed-v1': 'nvidia/nv-embed-v1',
    'nv-embedcode-7b-v1': 'nvidia/nv-embedcode-7b-v1',
  },
  // No resolveAuth override: NVIDIA is plain `Authorization: Bearer <key>`,
  // which defaultResolveAuth derives from auth_env.required. IRON RULE
  // (test/ai/recipes-existing-regression.test.ts): only Azure overrides
  // resolveAuth.
  touchpoints: {
    chat: {
      models: [
        'nvidia/nemotron-3-super-120b-a12b',
      ],
      supports_tools: false,
      supports_subagent_loop: false,
      // Do not treat Nemotron as a Minions subagent driver until tool-calling
      // and replay stability are proven through a separate adapter test.
      max_context_tokens: 128000,
      price_last_verified: '2026-05-24',
    },
    embedding: {
      models: [
        'nvidia/nv-embedqa-e5-v5',
        'nvidia/llama-nemotron-embed-1b-v2',
        'nvidia/nv-embed-v1',
        'nvidia/nv-embedcode-7b-v1',
      ],
      // Default to the lightest tested hosted model. Larger NVIDIA models are
      // supported via explicit embedding_dimensions (2048 or 4096).
      default_dims: 1024,
      dims_options: [1024, 2048, 4096],
      // Conservative split; hosted NVIDIA embedding endpoints require
      // input_type and may reject large payloads before tokenizing.
      max_batch_tokens: 8192,
      chars_per_token: 4,
      safety_factor: 0.75,
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-05-24',
    },
  },
  setup_hint: 'Get an API key at https://build.nvidia.com, then `export NVIDIA_API_KEY=...`.',
};
