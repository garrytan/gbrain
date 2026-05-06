import type { Recipe } from '../types.ts';

/**
 * Voyage AI exposes an OpenAI-compatible /embeddings endpoint.
 * Base URL: https://api.voyageai.com/v1
 */
export const voyage: Recipe = {
  id: 'voyage',
  name: 'Voyage AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.voyageai.com/v1',
  auth_env: {
    required: ['VOYAGE_API_KEY'],
    setup_url: 'https://dash.voyageai.com/api-keys',
  },
  touchpoints: {
    embedding: {
      // v0.27.1: voyage-multimodal-3 supports text + image inputs in the same
      // 1024-dim space. supports_multimodal flips routing to embedMultimodal()
      // in the gateway. Text-only Voyage models keep their existing path.
      models: ['voyage-3-large', 'voyage-3', 'voyage-3-lite', 'voyage-multimodal-3'],
      default_dims: 1024,
      cost_per_1m_tokens_usd: 0.18,
      price_last_verified: '2026-04-20',
      supports_multimodal: true,
    },
  },
  setup_hint: 'Get an API key at https://dash.voyageai.com/api-keys, then `export VOYAGE_API_KEY=...`',
};
