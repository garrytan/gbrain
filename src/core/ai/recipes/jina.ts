import type { Recipe } from '../types.ts';

/**
 * Jina Embeddings via a self-hosted text-embeddings-inference (TEI) server.
 *
 * TEI with jina-v2-base-code ONNX enforces a 2048-token per-request limit.
 * Code tokenizes at ~1 char/token; safety_factor=0.5 gives a 1024-char
 * per-text budget — well under the hard limit even with tokenizer variance.
 *
 * The model list below covers the most common Jina v2/v3 models. Because TEI
 * serves whatever model you launched it with, user_provided_models is set so
 * the gateway accepts any `jina:<id>` the user supplies.
 */
export const jina: Recipe = {
  id: 'jina',
  name: 'Jina Embeddings (self-hosted TEI)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:8080/v1',
  auth_env: {
    required: [],
    optional: ['JINA_BASE_URL', 'JINA_API_KEY'],
    setup_url: 'https://github.com/huggingface/text-embeddings-inference',
  },
  touchpoints: {
    embedding: {
      models: [
        'jina-embeddings-v2-base-code',
        'jina-embeddings-v2-base-en',
        'jina-embeddings-v2-small-en',
        'jina-embeddings-v3',
      ],
      user_provided_models: true,
      // v2 models output 768 dims. jina-embeddings-v3 outputs 1024 dims —
      // pass --embedding-dimensions 1024 explicitly when using v3.
      default_dims: 768,
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-06-17',
      max_batch_tokens: 2048,
      chars_per_token: 1,
      safety_factor: 0.5,
    },
  },
  setup_hint:
    'Run text-embeddings-inference with a Jina model. Set JINA_BASE_URL to the server URL.',
};
