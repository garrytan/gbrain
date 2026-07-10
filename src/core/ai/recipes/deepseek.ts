import type { Recipe } from '../types.ts';

/**
 * DeepSeek exposes an OpenAI-compatible /v1/chat/completions endpoint.
 * Useful as the second hop in a refusal-fallback chain and for cheap-
 * research delegation: 25-40x cheaper than Anthropic on equivalent
 * reasoning workloads.
 */
export const deepseek: Recipe = {
  id: 'deepseek',
  name: 'DeepSeek',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.deepseek.com/v1',
  auth_env: {
    required: ['DEEPSEEK_API_KEY'],
    setup_url: 'https://platform.deepseek.com/api_keys',
  },
  touchpoints: {
    embedding: {
      models: ['deepseek-embedding'],
      default_dims: 1536,
      dims_options: [1536],
      cost_per_1m_tokens_usd: 0.001,
      price_last_verified: '2026-06-02',
      max_batch_tokens: 8192,
    },
    expansion: {
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      cost_per_1m_tokens_usd: 0.07,
      price_last_verified: '2026-06-02',
    },
    chat: {
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 128000,
      cost_per_1m_input_usd: 0.07,
      cost_per_1m_output_usd: 0.28,
      price_last_verified: '2026-06-02',
    },
  },
  setup_hint: 'Get an API key at https://platform.deepseek.com/api_keys, then `export DEEPSEEK_API_KEY=...`',
};
