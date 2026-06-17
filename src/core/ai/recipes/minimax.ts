import type { Recipe } from '../types.ts';

/**
 * MiniMax (海螺AI). OpenAI-compatible /embeddings endpoint at
 * api.minimax.chat. The flagship embedding model is `embo-01` (1536 dims).
 *
 * MiniMax's API takes an extra `type: 'db' | 'query'` field for asymmetric
 * retrieval. gbrain currently has no notion of "this is a document vs a
 * query" at the embed-call site (embed() takes only texts), so we default
 * to `type: 'db'` for the indexing path. Queries also embed with `type:
 * 'db'`, making retrieval symmetric. This sacrifices some retrieval
 * quality vs. a true asymmetric setup but works correctly. A follow-up
 * TODO will thread query/document context through the embed seam for
 * full asymmetric support.
 *
 * Reference: https://www.minimaxi.com/document/guides/embeddings
 */
export const minimax: Recipe = {
  id: 'minimax',
  name: 'MiniMax (海螺AI)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.minimaxi.com/v1',
  auth_env: {
    required: ['MINIMAX_API_KEY'],
    optional: ['MINIMAX_GROUP_ID'],
    setup_url: 'https://www.minimaxi.com/document/guides/embeddings',
  },
  touchpoints: {
    embedding: {
      models: ['embo-01'],
      default_dims: 1536,
      cost_per_1m_tokens_usd: 0.07,
      price_last_verified: '2026-05-09',
      // MiniMax docs don't publish a hard batch-token cap; declare a
      // conservative 4096-token budget so the gateway pre-splits before
      // hitting whatever undocumented server-side limit exists. Recursive
      // halving in the gateway catches token-limit errors at runtime.
      max_batch_tokens: 4096,
    },
  },
  setup_hint:
    'Get an API key at https://www.minimaxi.com, then `export MINIMAX_API_KEY=...`',
};
