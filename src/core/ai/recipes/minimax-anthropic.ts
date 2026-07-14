import type { Recipe } from '../types.ts';
import {
  MINIMAX_CHAT_MODELS,
  MINIMAX_CHAT_PRICING,
  MINIMAX_ENDPOINTS,
} from './minimax-shared.ts';

export const minimaxAnthropic: Recipe = {
  id: 'minimax-anthropic',
  name: 'MiniMax (Anthropic-compatible)',
  tier: 'openai-compat',
  implementation: 'anthropic-compatible',
  // This is the public base URL. The gateway derives the SDK's internal /v1
  // prefix without exposing that derived path as user configuration.
  base_url_default: MINIMAX_ENDPOINTS.global_en.anthropic_base_url,
  auth_env: {
    required: ['MINIMAX_API_KEY'],
    setup_url: 'https://platform.minimax.io/docs/api-reference/api-overview',
  },
  touchpoints: {
    chat: {
      models: [...MINIMAX_CHAT_MODELS],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      cost_per_1m_input_usd: MINIMAX_CHAT_PRICING.input,
      cost_per_1m_output_usd: MINIMAX_CHAT_PRICING.output,
      price_last_verified: MINIMAX_CHAT_PRICING.verified_at,
    },
  },
  setup_hint:
    'Set MINIMAX_API_KEY, then select minimax-anthropic:<model>. Override provider_base_urls.minimax-anthropic to use another published region.',
};
