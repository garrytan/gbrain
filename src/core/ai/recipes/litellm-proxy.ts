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
      // v0.34.1 (#875): LiteLLM can forward to multimodal providers (OpenAI,
      // Gemini, Voyage etc.). embedMultimodal routes openai-compatible
      // recipes through embedMultimodalOpenAICompat() — same /embeddings
      // endpoint as text, with content arrays carrying image_base64
      // entries. No multimodal_models allow-list: the user knows which of
      // their proxied models support multimodal; we trust the model id and
      // surface the provider's rejection (D12 dim-validation catches
      // mismatched-dim responses pre-storage).
      supports_multimodal: true,
    },
    chat: {
      // LiteLLM's raison d'être is chat: it proxies arbitrary chat backends
      // (Bedrock, Vertex, Azure, DeepSeek, Qwen, GLM, …) behind one
      // OpenAI-compatible /chat/completions endpoint. The served model set is
      // the proxy's own config, so declare empty + user-provided (mirrors the
      // embedding touchpoint). The openai-compat tier does NOT enforce the list
      // at runtime — any model id the proxy serves is accepted. Without this
      // touchpoint, `chat_model` / `models.default = litellm:<model>` silently
      // degrade to "no LLM available" (validateModelId throws no-chat-touchpoint).
      models: [],
      user_provided_models: true,
      supports_tools: true,
      // Informational only — the real subagent-loop gate is isAnthropicProvider()
      // upstream (tool-replay needs Anthropic-style tool_use_ids). litellm can
      // still drive the gateway loop when agent.use_gateway_loop=true.
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      price_last_verified: '2026-06-07',
    },
  },
  setup_hint: 'Run LiteLLM (https://docs.litellm.ai) in front of any provider; set LITELLM_BASE_URL (+ LITELLM_API_KEY if the proxy is authenticated) and use litellm:<model> for --embedding-model, chat_model, or models.default.',
};
