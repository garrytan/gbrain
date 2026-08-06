import type { Recipe } from '../types.ts';

/**
 * OrcaRouter — single-key fan-out to OpenAI, Anthropic, Google, DeepSeek and
 * ~180 other models through one OpenAI-compatible endpoint at
 * https://api.orcarouter.ai/v1.
 *
 * Same nested-id convention as OpenRouter, so `model-resolver.ts` needs no
 * change — use `orcarouter:<provider>/<model>` strings:
 *   orcarouter:openai/gpt-5.5
 *   orcarouter:anthropic/claude-sonnet-4.6
 *   orcarouter:google/gemini-3-flash-preview
 *
 * Every field below was verified against the live API on 2026-08-01. The
 * notes record what was MEASURED, including the negative results — this is a
 * plain `openai-compatible` recipe precisely because none of the special
 * cases the other gateway recipes carry turned out to apply.
 *
 * NO COMPAT FETCH, unlike openrouter.ts. That shim exists to splice an
 * Anthropic `cache_control` breakpoint onto the system block. Prompt caching
 * does not currently engage through this gateway on either family, so there
 * is nothing for a shim to do — see `supports_prompt_cache` below.
 *
 * NO dims.ts CHANGE. The `openai-compatible` branch of dimsProviderOptions()
 * already strips a `provider/` prefix before matching `text-embedding-3*`, so
 * `openai/text-embedding-3-small` emits `{dimensions: N}` unmodified. Verified
 * end to end: 512 and 1024 both come back at the requested width, and the
 * default is the model's native 1536.
 *
 * NO reranker touchpoint. The gateway routes no cross-encoder rerank models —
 * `POST /rerank` with `cohere/rerank-v3.5` returns HTTP 503 `model_not_found`
 * ("No available channel for model ... under group default"), and no id in the
 * catalog matches /rerank/. This is the one place the OpenRouter recipe's
 * shape does NOT carry over; do not copy its `reranker` block across.
 *
 * Attribution: the gateway defines no `HTTP-Referer` / `X-Title` convention,
 * so unlike openrouter.ts there is no `resolveDefaultHeaders`. Requests carry
 * the Bearer key only.
 *
 * Subagent loops: `supports_subagent_loop: false` is INFORMATIONAL, matching
 * every non-Anthropic-direct recipe. The real gate is `isAnthropicProvider()`
 * in `src/core/model-config.ts`, which pins subagent infra to Anthropic-direct
 * for stable tool_use_id across crashes/replays.
 */
export const orcarouter: Recipe = {
  id: 'orcarouter',
  name: 'OrcaRouter',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.orcarouter.ai/v1',
  auth_env: {
    required: ['ORCAROUTER_API_KEY'],
    optional: ['ORCAROUTER_BASE_URL'],
    setup_url: 'https://www.orcarouter.ai',
  },
  touchpoints: {
    embedding: {
      // Only the 1536-dim model is listed. `openai/text-embedding-3-large`
      // (3072) and `google/gemini-embedding-001` (3072) are both routable and
      // were verified working, but a touchpoint carries ONE `default_dims`;
      // mixing widths under a 1536 declaration is the footgun
      // embedding-dim-check.ts exists to catch (same call as the codestral
      // models in mistral.ts). The openai-compat tier accepts arbitrary ids,
      // so a user who wants 3072 can still opt in explicitly via
      // `--embedding-model orcarouter:openai/text-embedding-3-large` plus a
      // matching `embedding_dimensions`.
      models: ['openai/text-embedding-3-small'],
      default_dims: 1536,
      // Matryoshka truncation verified live: `dimensions: 512` returned a
      // 512-wide vector, `dimensions: 1024` a 1024-wide one, and omitting the
      // field returned the native 1536.
      dims_options: [512, 768, 1024, 1536],
      // Published by the gateway itself: /v1/models reports
      // `pricing.prompt_per_million: "0.020000"` for this model.
      cost_per_1m_tokens_usd: 0.02,
      price_last_verified: '2026-08-01',
      // MEASURED, not inherited from the OpenAI default: a 300K-token batch
      // is accepted and a larger one is rejected with an explicit
      //   400 max_tokens_per_request
      //   "Requested 400000 tokens, max 300000 tokens per request"
      // This is the AGGREGATE per-request budget the gateway uses to pre-split
      // batches, NOT a per-input cap.
      max_batch_tokens: 300_000,
    },
    // Expansion rides the same routed chat endpoint. Small cheap/fast advisory
    // set; the openai-compat tier still accepts any routable id.
    expansion: {
      models: [
        'anthropic/claude-haiku-4.5',
        'google/gemini-3-flash-preview',
        'deepseek/deepseek-chat',
      ],
      price_last_verified: '2026-08-01',
    },
    chat: {
      // Curated entry points. Every id below was called against the live
      // endpoint with a function tool attached and returned HTTP 200.
      models: [
        'openai/gpt-5.2',
        'openai/gpt-5.4',
        'openai/gpt-5.5',
        'anthropic/claude-haiku-4.5',
        'anthropic/claude-sonnet-4.6',
        'google/gemini-3-flash-preview',
        'deepseek/deepseek-chat',
        'deepseek/deepseek-v4-pro',
      ],
      // Verified per-model, not assumed: each listed id emitted a well-formed
      // tool_calls envelope for a single-function request.
      supports_tools: true,
      // Informational only — real gate is isAnthropicProvider() upstream.
      supports_subagent_loop: false,
      // FALSE on measurement, not on omission. Both families were probed with
      // a >4K-token prefix sent twice in a row:
      //   - Anthropic route with OpenRouter's documented per-block
      //     `cache_control: {type: 'ephemeral'}` reported
      //     `claude_cache_creation_5_m_tokens: 0` and `cached_tokens: 0` on
      //     both calls — no cache entry was created.
      //   - OpenAI route (which caches automatically upstream) reported
      //     `cached_tokens: 0` on the repeat call.
      // The usage envelope carries the cache counters, so this is readable
      // again cheaply: if the gateway starts honouring cache breakpoints,
      // flip this to a family-scoped predicate and add a compat fetch
      // mirroring openrouter.ts. Claiming caching that does not happen would
      // make gateway.ts set a marker header for a rewrite that buys nothing.
      supports_prompt_cache: false,
      // No max_context_tokens: the catalog spans 128K to 1M+, so a single
      // recipe-wide value is either unsafe for the smaller models or wasteful
      // for the larger ones. Let upstream errors surface per-model.
      price_last_verified: '2026-08-01',
    },
  },
  setup_hint:
    'Get an API key at https://www.orcarouter.ai, then `export ORCAROUTER_API_KEY=...` and use `orcarouter:<provider>/<model>` (e.g. orcarouter:openai/gpt-5.5, or orcarouter:openai/text-embedding-3-small for embeddings). Optional override: ORCAROUTER_BASE_URL (proxy). Note there is no `orcarouter_api_key` config.json slot — like mistral/perplexity/nvidia, this recipe reads the env var only.',
};
