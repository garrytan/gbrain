import type { Recipe } from '../types.ts';

/**
 * LiteLLM proxy template. Users run LiteLLM in front of any provider
 * (Bedrock, Vertex, Azure, Fireworks, Together, DeepSeek, etc.) and point
 * gbrain at it via `LITELLM_BASE_URL`. The proxy normalizes to
 * OpenAI-compatible API.
 *
 * See docs/guides/litellm-proxy.md for the setup recipe.
 */
export const litellmProxy: Recipe = {
  id: 'litellm',
  name: 'LiteLLM Proxy (universal)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:4000', // LiteLLM default
  auth_env: {
    required: [], // LITELLM_API_KEY is optional (users may run proxy unauthenticated locally)
    optional: ['LITELLM_BASE_URL', 'LITELLM_API_KEY'],
    setup_url: 'https://docs.litellm.ai/docs/proxy/quick_start',
  },
  touchpoints: {
    embedding: {
      // Models depend on the proxy's config; declare empties so wizard prompts user.
      models: [],
      user_provided_models: true, // v0.32 D8=A wire-through for the litellm hardcode
      default_dims: 0, // user must declare --embedding-dimensions explicitly
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-04-20',
      // LiteLLM's batch capacity is determined by the backend it proxies;
      // no static cap to declare here. v0.32 (#779).
      no_batch_cap: true,
    },
    chat: {
      // Models depend on the proxy's config; allow users to route any
      // OpenAI-compatible chat backend (including local proxies) through this
      // recipe via `litellm:<model>`.
      models: [],
      user_provided_models: true,
      supports_tools: true,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 128000,
      cost_per_1m_input_usd: undefined,
      cost_per_1m_output_usd: undefined,
      price_last_verified: '2026-05-13',
    },
  },
  setup_hint: 'Run LiteLLM (https://docs.litellm.ai) in front of any provider; set LITELLM_BASE_URL + pass --embedding-model litellm:<model> and --embedding-dimensions <N>.',
};
