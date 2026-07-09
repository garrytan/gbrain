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
    // LiteLLM exposes a rerank endpoint at /v1/rerank that normalizes Cohere /
    // Voyage / Jina / etc. to the same wire shape gbrain's gateway.rerank()
    // already speaks (the ZeroEntropy/llama.cpp contract):
    //   { model, query, documents, top_n } → { results: [{ index, relevance_score }] }
    // So any rerank model the user registers in their LiteLLM config is reachable
    // via `gbrain config set search.reranker.model litellm:<model-name>` with no
    // request/response adapter — same as embeddings ride the proxy today.
    reranker: {
      models: [], // user-provided; whatever rerank models the proxy serves
      // No canonical default — the proxy defines its own model ids. The user
      // sets search.reranker.model explicitly (mirrors the embedding touchpoint's
      // user_provided_models contract).
      default_model: '',
      // The proxied backend bills (Cohere/Voyage/…); gbrain can't know the rate
      // from here. Declare 0 so `--max-cost` callers don't hard-fail at the
      // recipe layer — real cost is tracked by the proxy / upstream provider.
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-06-27',
      max_payload_bytes: 5_000_000,
      // Leaf path. base_url_default is 'http://localhost:4000' (no /v1 suffix),
      // so the gateway concatenates to 'http://localhost:4000/v1/rerank' —
      // LiteLLM's OpenAI-style rerank route.
      path: '/v1/rerank',
    },
  },
  setup_hint: 'Run LiteLLM (https://docs.litellm.ai) in front of any provider; set LITELLM_BASE_URL + pass --embedding-model litellm:<model> and --embedding-dimensions <N>. For rerank: register a rerank model in LiteLLM and set search.reranker.model litellm:<model-name>.',
};
