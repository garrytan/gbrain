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
    chat: {
      // MiniMax text models via the OpenAI-compatible /chat/completions
      // endpoint (same base_url). Function calling is supported, which is
      // what the gateway tool loop needs. The capabilities hint in
      // src/core/ai/capabilities.ts already lists minimax among chat
      // providers — this touchpoint makes the recipe match it.
      // openai-compat tier: the models list is informational, arbitrary
      // ids are accepted at runtime (same contract as openrouter).
      models: ['MiniMax-M3', 'MiniMax-M2.5'],
      supports_tools: true,
      supports_subagent_loop: true,
      // Anthropic-style cache_control is only honored on MiniMax's
      // anthropic-compatible endpoint, not the OpenAI-compatible one.
      supports_prompt_cache: false,
      // MiniMax-M3 advertises 1M; M2.5 is 200K. Declare the conservative
      // floor — per-model context is handled by callers (e.g. dream's
      // MODEL_CONTEXT_TOKENS map).
      max_context_tokens: 200_000,
      cost_per_1m_input_usd: 0.6, // M3 list price 2026-06
      cost_per_1m_output_usd: 2.4,
      price_last_verified: '2026-06-11',
    },
  },
  setup_hint:
    'Get an API key at https://www.minimaxi.com, then `export MINIMAX_API_KEY=...`',
};
