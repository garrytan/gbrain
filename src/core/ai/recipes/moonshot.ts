import type { Recipe } from '../types.ts';

/**
 * Moonshot AI (月之暗面). OpenAI-compatible /v1/chat/completions endpoint.
 * Hosts the Kimi K2.6 model — a native multimodal agentic model with 256K
 * context, strong coding and reasoning, and Tool Calling support.
 *
 * Reference: https://platform.kimi.ai/
 */
export const moonshot: Recipe = {
  id: 'moonshot',
  name: 'Moonshot AI (Kimi 月之暗面)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.moonshot.cn/v1',
  auth_env: {
    required: ['MOONSHOT_API_KEY'],
    setup_url: 'https://platform.kimi.ai/api_keys',
  },
  touchpoints: {
    chat: {
      models: ['kimi-k2.6'],
      supports_tools: true,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 256000,
      cost_per_1m_input_usd: 0.55,
      cost_per_1m_output_usd: 2.65,
      price_last_verified: '2026-06-25',
    },
  },
  setup_hint:
    'Get an API key at https://platform.kimi.ai/api_keys, then `export MOONSHOT_API_KEY=...`',
};
