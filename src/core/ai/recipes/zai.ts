import type { Recipe } from '../types.ts';

/**
 * Z.AI GLM Coding / Open Platform. The general API is OpenAI-compatible at
 * api.z.ai/api/paas/v4; Coding Plan users can override the base URL to the
 * dedicated coding endpoint with:
 *
 *   gbrain config set provider_base_urls.zai https://api.z.ai/api/coding/paas/v4
 *
 * References:
 * - https://docs.z.ai/guides/overview/quick-start
 * - https://docs.z.ai/devpack/quick-start
 * - https://docs.z.ai/guides/overview/pricing
 */
export const zai: Recipe = {
  id: 'zai',
  name: 'Z.AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.z.ai/api/paas/v4',
  auth_env: {
    required: ['ZAI_API_KEY'],
    setup_url: 'https://docs.z.ai/guides/overview/quick-start',
  },
  touchpoints: {
    chat: {
      models: ['glm-5.2'],
      supports_tools: true,
      supports_subagent_loop: true,
      // Z.AI exposes implicit caching plus cached-token usage telemetry.
      // There is no Anthropic-style request marker; the provider reuses
      // repeated prefixes automatically.
      supports_prompt_cache: true,
      prompt_cache_mode: 'implicit',
      max_context_tokens: 1_000_000,
      cost_per_1m_input_usd: 1.4,
      cost_per_1m_output_usd: 4.4,
      price_last_verified: '2026-06-23',
    },
  },
  setup_hint:
    'Get a Z.AI API key, export ZAI_API_KEY=..., and use zai:glm-5.2. Coding Plan users should set provider_base_urls.zai to https://api.z.ai/api/coding/paas/v4.',
};
