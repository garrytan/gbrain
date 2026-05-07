import type { Recipe } from '../types.ts';

/**
 * Voyage AI exposes an OpenAI-compatible /embeddings endpoint.
 * Base URL: https://api.voyageai.com/v1
 *
 * Voyage 4 family (Jan 2026): shared embedding space across all v4 variants,
 * flexible dims (256/512/1024/2048), 32K context, MoE architecture (large).
 * You can index with voyage-4-large and query with voyage-4-lite — no reindex.
 *
 * voyage-multimodal-3 (v0.27.1): text + image inputs in the same 1024-dim
 * space. supports_multimodal flips routing to embedMultimodal() in the
 * gateway. Text-only Voyage models keep their existing path.
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
      models: [
        'voyage-4-large', 'voyage-4', 'voyage-4-lite', 'voyage-4-nano',
        'voyage-3.5', 'voyage-3-large', 'voyage-3', 'voyage-3-lite',
        'voyage-code-3', 'voyage-finance-2', 'voyage-law-2',
        'voyage-multimodal-3',
      ],
      default_dims: 1024,
      cost_per_1m_tokens_usd: 0.18,
      price_last_verified: '2026-05-06',
      // Voyage enforces 120K tokens per batch. Use conservative limit
      // because Voyage's tokenizer runs 3-4× denser than tiktoken.
      max_batch_tokens: 120_000,
      supports_multimodal: true,
    },
  },
  setup_hint: 'Get an API key at https://dash.voyageai.com/api-keys, then `export VOYAGE_API_KEY=...`',
};
