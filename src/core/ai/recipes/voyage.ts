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
      models: ['voyage-3-large', 'voyage-3', 'voyage-3-lite'],
      default_dims: 1024,
      cost_per_1m_tokens_usd: 0.18,
      price_last_verified: '2026-04-20',
      // Voyage enforces 120K tokens per batch. Voyage's tokenizer runs
      // ~3-4× denser than OpenAI tiktoken on mixed content (code/JSON/CJK),
      // so the per-recipe pre-split uses 1 char ≈ 1 token at 0.5 utilization
      // (60K char budget). Recursive halving in the gateway is the runtime
      // safety net when dense payloads still overshoot.
      max_batch_tokens: 120_000,
      chars_per_token: 1,
      safety_factor: 0.5,
    },
  },
  setup_hint: 'Get an API key at https://dash.voyageai.com/api-keys, then `export VOYAGE_API_KEY=...`',
};
