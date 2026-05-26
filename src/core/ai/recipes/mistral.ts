import type { Recipe } from '../types.ts';

/**
 * Mistral AI. OpenAI-compatible /embeddings endpoint at api.mistral.ai/v1.
 *
 * The flagship code embedder is `codestral-embed` (alias for the dated
 * `codestral-embed-2505`): default 1536 dims, Matryoshka-truncatable, 8192-token
 * context per input, code-optimized. Mistral's embeddings response is
 * OpenAI-shaped (`data[].embedding` as number[], `usage.prompt_tokens` present),
 * so this rides the AI SDK's standard openai-compatible adapter with NO gateway
 * fetch shim — same path as deepseek / minimax / dashscope.
 *
 * Dimension caveat (why this recipe is fixed at 1536): Mistral takes
 * `output_dimension` for non-default sizes, not OpenAI's `dimensions`. The
 * standard adapter would send `dimensions`, which Mistral ignores, so requesting
 * a non-default dim is a no-op without a translation shim. v1 ships the 1536
 * default only. Flexible dims (up to 3072) + `mistral-embed` (fixed 1024) are a
 * follow-up that adds a `mistralCompatFetch` (dimensions → output_dimension)
 * mirroring `voyageCompatFetch` in gateway.ts.
 *
 * Reference: https://docs.mistral.ai/capabilities/embeddings/code_embeddings
 */
export const mistral: Recipe = {
  id: 'mistral',
  name: 'Mistral AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.mistral.ai/v1',
  auth_env: {
    required: ['MISTRAL_API_KEY'],
    setup_url: 'https://console.mistral.ai/api-keys',
  },
  touchpoints: {
    embedding: {
      models: ['codestral-embed', 'codestral-embed-2505'],
      default_dims: 1536,
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-05-26',
      // codestral-embed caps each input at 8192 tokens. Mistral publishes no
      // hard batch-token total, so declare a conservative budget and let the
      // gateway's recursive halving catch token-limit errors at runtime.
      // chars_per_token=3 (code runs denser than prose's ~4) + safety 0.5 is
      // the dense-content hedge Voyage / ZeroEntropy use.
      max_batch_tokens: 16_384,
      chars_per_token: 3,
      safety_factor: 0.5,
      supports_multimodal: false,
    },
  },
  setup_hint:
    'Get an API key at https://console.mistral.ai/api-keys, then `export MISTRAL_API_KEY=...`',
};
