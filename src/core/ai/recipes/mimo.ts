import type { Recipe } from '../types.ts';
import { AIConfigError } from '../errors.ts';

/**
 * MIMO (小米开放平台). OpenAI-compatible API endpoint.
 * Supports chat and embedding via OpenAI-compatible format.
 */
export const mimo: Recipe = {
  id: 'mimo',
  name: 'MIMO (小米开放平台)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.xiaomimimo.com/v1',
  auth_env: {
    required: ['MIMO_API_KEY'],
    optional: ['OPENAI_API_KEY'],
    setup_url: 'https://platform.xiaomimimo.com',
  },
  resolveAuth(env) {
    const key = env.MIMO_API_KEY || env.OPENAI_API_KEY;
    if (!key) {
      throw new AIConfigError(
        'MIMO requires MIMO_API_KEY.',
        'Add `mimo_api_key` to ~/.gbrain/config.json or set MIMO_API_KEY.',
      );
    }
    return { headerName: 'Authorization', token: `Bearer ${key}` };
  },
  touchpoints: {
    embedding: {
      models: ['text-embedding-3-small', 'text-embedding-3-large'],
      default_dims: 1536,
      dims_options: [256, 512, 768, 1024, 1536, 3072],
      cost_per_1m_tokens_usd: 0.13,
      price_last_verified: '2026-06-02',
      max_batch_tokens: 100_000,
    },
    expansion: {
      models: ['mimo-v2.5-pro', 'mimo-v2.5'],
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-06-02',
    },
    chat: {
      models: ['mimo-v2.5-pro', 'mimo-v2.5'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 128000,
      cost_per_1m_input_usd: 1.25,
      cost_per_1m_output_usd: 10.0,
      price_last_verified: '2026-06-02',
    },
  },
  setup_hint: 'Get an API key at https://platform.xiaomimimo.com, then add `mimo_api_key` to ~/.gbrain/config.json or set MIMO_API_KEY.',
};
