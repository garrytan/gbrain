import type { Recipe } from '../types.ts';

/**
 * Vercel AI Gateway — unified OpenAI-compatible endpoint that routes to many
 * providers (DeepSeek, Anthropic, OpenAI, NVIDIA, Alibaba, etc.) under a
 * single API key. Use `vercel:<provider>/<model>` in gbrain.
 *
 * Examples:
 *   vercel:deepseek/deepseek-v4-flash
 *   vercel:nvidia/nemotron-nano-9b-v2
 *
 * Setup: `export AI_GATEWAY_API_KEY=...`
 * See: https://vercel.com/docs/ai-gateway
 */
export const vercel: Recipe = {
  id: 'vercel',
  name: 'Vercel AI Gateway',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://ai-gateway.vercel.sh/v1',
  auth_env: {
    required: ['AI_GATEWAY_API_KEY'],
    setup_url: 'https://vercel.com/docs/ai-gateway',
  },
  touchpoints: {
    chat: {
      models: [
        'deepseek/deepseek-v4-flash',
        'deepseek/deepseek-v4-pro',
        'deepseek/deepseek-v3.2',
        'deepseek/deepseek-v3.2-thinking',
        'deepseek/deepseek-v3.1-terminus',
        'deepseek/deepseek-r1',
        'nvidia/nemotron-nano-9b-v2',
        'nvidia/nemotron-nano-12b-v2-vl',
        'nvidia/nemotron-3-nano-30b-a3b',
        'nvidia/nemotron-3-super-120b-a12b',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 128000,
      cost_per_1m_input_usd: undefined,
      cost_per_1m_output_usd: undefined,
      price_last_verified: '2026-05-08',
    },
  },
  setup_hint: 'Get an API key at https://vercel.com/dashboard/ai/gateway, then `export AI_GATEWAY_API_KEY=...`',
};
