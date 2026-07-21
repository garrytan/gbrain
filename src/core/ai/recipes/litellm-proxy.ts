import type { Recipe } from '../types.ts';

/**
 * LiteLLM proxy template. Users run LiteLLM in front of any provider
 * (Bedrock, Vertex, Azure, Fireworks, Together, DeepSeek, etc.) and point
 * gbrain at it via `LITELLM_BASE_URL`. The proxy normalizes to
 * OpenAI-compatible API.
 *
 * See docs/integrations/embedding-providers.md for the setup recipe.
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
      trust_custom_dims: true, // #2271: proxy-backed model dim is user-declared
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
    expansion: {
      models: [],
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-06-14',
    },
    chat: {
      models: [],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 200_000,
      cost_per_1m_input_usd: undefined,
      cost_per_1m_output_usd: undefined,
      price_last_verified: '2026-06-14',
    },
    // LiteLLM normalizes Cohere / Voyage / Jina / etc. rerank backends to the
    // same wire shape gbrain's gateway.rerank() already speaks (the
    // ZeroEntropy/llama.cpp contract):
    //   { model, query, documents, top_n } → { results: [{ index, relevance_score }] }
    // So any rerank model the user registers in their LiteLLM config is
    // reachable via `gbrain config set search.reranker.model litellm:<model>`
    // with no request/response adapter — same as embeddings ride the proxy.
    reranker: {
      models: [], // user-provided; whatever rerank models the proxy serves
      // No canonical default — the proxy defines its own model ids. The user
      // sets search.reranker.model explicitly (mirrors the embedding
      // touchpoint's user_provided_models contract).
      default_model: '',
      // The proxied backend bills (Cohere/Voyage/…); pricing-unknown is the
      // honest state — same stance as this recipe's embedding/chat
      // touchpoints and budget-tracker's deliberate litellm exclusion from
      // the free-provider sets.
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-06-27',
      max_payload_bytes: 5_000_000,
      // LEAF path only (matches llama-server-reranker's convention). LiteLLM
      // serves both `/rerank` and `/v1/rerank`, and LITELLM_BASE_URL may be
      // set with or without the `/v1` suffix (the setup_hint allows both), so
      // the leaf form yields a valid route either way:
      //   http://localhost:4000    + /rerank → /rerank        ✓
      //   http://localhost:4000/v1 + /rerank → /v1/rerank     ✓
      // Pinning '/v1/rerank' here would double to /v1/v1/rerank → 404 on
      // /v1-suffixed bases.
      path: '/rerank',
    },
  },
  setup_hint: 'Run LiteLLM (https://docs.litellm.ai) in front of any provider; set LITELLM_BASE_URL (include the /v1 suffix if your proxy serves the OpenAI route there, e.g. http://localhost:4000/v1) + pass --embedding-model litellm:<model> and --embedding-dimensions <N>. For rerank: register a rerank model in LiteLLM and set search.reranker.model litellm:<model-name>.',
};
