import type { Recipe } from '../types.ts';

/**
 * Kimi / Moonshot AI. OpenAI-compatible chat completions endpoint.
 *
 * Docs: https://platform.moonshot.ai/docs/overview
 * API base: https://api.moonshot.ai/v1
 */
export const kimi: Recipe = {
  id: 'kimi',
  name: 'Kimi (Moonshot AI)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.moonshot.ai/v1',
  auth_env: {
    required: ['MOONSHOT_API_KEY'],
    setup_url: 'https://platform.moonshot.ai/',
  },
  touchpoints: {
    expansion: {
      models: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2-turbo-preview', 'kimi-k2-thinking', 'kimi-k2-thinking-turbo'],
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-05-20',
    },
    chat: {
      models: ['kimi-k2.6', 'kimi-k2.5', 'kimi-k2-turbo-preview', 'kimi-k2-thinking', 'kimi-k2-thinking-turbo'],
      supports_tools: true,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 256000,
      cost_per_1m_input_usd: undefined,
      cost_per_1m_output_usd: undefined,
      price_last_verified: '2026-05-20',
    },
  },
  setup_hint: 'Get an API key at https://platform.moonshot.ai/, then `export MOONSHOT_API_KEY=...`',
};
