import type { Recipe } from '../types.ts';
import {
  MINIMAX_CHAT_MODELS,
  MINIMAX_CHAT_PRICING,
  MINIMAX_ENDPOINTS,
} from './minimax-shared.ts';

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
  base_url_default: MINIMAX_ENDPOINTS.cn_zh.openai_base_url,
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
      models: [...MINIMAX_CHAT_MODELS],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      // The registered models have different context limits, so a single
      // recipe-wide maximum would be unsafe for one model or restrictive for
      // the other. The upstream API remains the per-model source of truth.
      cost_per_1m_input_usd: MINIMAX_CHAT_PRICING.input,
      cost_per_1m_output_usd: MINIMAX_CHAT_PRICING.output,
      price_last_verified: MINIMAX_CHAT_PRICING.verified_at,
    },
  },
  setup_hint:
    'Get an API key at https://www.minimaxi.com, then `export MINIMAX_API_KEY=...`',
};
