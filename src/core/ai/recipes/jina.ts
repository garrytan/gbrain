import type { Recipe } from '../types.ts';

/**
 * Jina embeddings via the OpenAI-compatible `/v1/embeddings` API.
 *
 * Defaults to a local OpenAI-compatible Jina service such as a
 * SentenceTransformers wrapper serving `jinaai/jina-embeddings-v5-omni-small`.
 * Local services can run without auth. For hosted Jina, set
 * `JINA_BASE_URL=https://api.jina.ai/v1` plus `JINA_API_KEY`.
 *
 * Retrieval discipline: Jina v5 retrieval models are asymmetric. The gateway's
 * `embed()` / `embedQuery()` inputType seam is translated by `dimsProviderOptions`
 * into `input_type: document|query`, which local Jina-compatible services can
 * map to `encode_document()` / `encode_query()`.
 */
export const jina: Recipe = {
  id: 'jina',
  name: 'Jina embeddings (local/OpenAI-compatible)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:8081/v1',
  auth_env: {
    required: [],
    optional: ['JINA_BASE_URL', 'JINA_API_KEY'],
    setup_url: 'https://jina.ai/embeddings/',
  },
  touchpoints: {
    embedding: {
      models: [
        'jinaai/jina-embeddings-v5-omni-small',
        'jina-embeddings-v5-text-small',
      ],
      default_dims: 1024,
      dims_options: [32, 64, 128, 256, 512, 768, 1024],
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-06-06',
      // Jina v5 text supports 32K-token inputs; gbrain truncates each input
      // to 8K chars, so this aggregate pre-split is mainly a dense-content
      // safety hedge matching Voyage/ZeroEntropy instead of a hard upstream
      // batch limit.
      max_batch_tokens: 120_000,
      chars_per_token: 1,
      safety_factor: 0.5,
      supports_multimodal: false,
    },
  },
  setup_hint:
    'Run a local Jina-compatible embeddings server, set `JINA_BASE_URL=http://host:port/v1`, and use `jina:jinaai/jina-embeddings-v5-omni-small` with `embedding_dimensions 1024`. For hosted Jina, set `JINA_BASE_URL=https://api.jina.ai/v1` and `JINA_API_KEY`.',
};
