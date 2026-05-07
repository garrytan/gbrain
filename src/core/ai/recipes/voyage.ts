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
      price_last_verified: '2026-04-20',
      // Voyage enforces 120K tokens per batch. Voyage's tokenizer runs
      // ~3-4× denser than OpenAI tiktoken on mixed content (code/JSON/CJK),
      // so the per-recipe pre-split uses 1 char ≈ 1 token at 0.5 utilization
      // (60K char budget). Recursive halving in the gateway is the runtime
      // safety net when dense payloads still overshoot.
      max_batch_tokens: 120_000,
      chars_per_token: 1,
      safety_factor: 0.5,
      supports_multimodal: true,
      // v0.28.11: only voyage-multimodal-3 is valid at /multimodalembeddings.
      // The 11 text-only Voyage models above share supports_multimodal: true
      // at the recipe level (Codex F1 from PR #719 review). Without this
      // explicit list, embedMultimodal() would let `voyage:voyage-3-large`
      // through local validation and Voyage would reject it with HTTP 400 —
      // which gateway.ts:626 misclassifies as transient (TODO: reclassify
      // 4xx).
      multimodal_models: ['voyage-multimodal-3'],
    },
  },
  setup_hint: 'Get an API key at https://dash.voyageai.com/api-keys, then `export VOYAGE_API_KEY=...`',
};
