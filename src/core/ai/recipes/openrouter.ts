import type { Recipe } from '../types.ts';

/**
 * OpenRouter — single-key fan-out to OpenAI, Anthropic, Google, DeepSeek, and
 * dozens of other providers via a single OpenAI-compatible endpoint at
 * https://openrouter.ai/api/v1.
 *
 * One key, many models. Use `openrouter:<provider>/<model>` strings:
 *   openrouter:openai/gpt-5.2
 *   openrouter:anthropic/claude-sonnet-4.6
 *   openrouter:google/gemini-3-flash-preview
 *
 * Embeddings: OpenRouter exposes `/v1/embeddings` proxying OpenAI's
 * text-embedding-3-small (1536 dims) plus Matryoshka shrink via the SDK's
 * `dimensions` field. Catalog also includes text-embedding-3-large,
 * google/gemini-embedding-2-preview, qwen3-embedding-8b, and bge-m3 — users
 * opt in via `--embedding-model openrouter:<id>` (openai-compat tier accepts
 * arbitrary IDs at the gateway; recipe lists are advisory, not enforcing).
 *
 * Chat: `/v1/chat/completions` proxies every chat model OpenRouter routes,
 * with tool-calling per-model. The chat models list below is a curated entry
 * point — `supports_tools: true` reflects the OR endpoint's tool-call
 * envelope, not every individual model's capability. When in doubt about a
 * specific model, check https://openrouter.ai/models.
 *
 * Reranker: `/api/v1/rerank` proxies cross-encoder rerankers (Cohere v3.5/4-fast/4-pro
 * and NVIDIA Nemotron VL). Wire shape matches `gateway.rerank()`:
 * `{ query, documents, model }` → `{ results: [{ index, relevance_score }] }`.
 * Unlike embedding/chat, the reranker path strictly enforces the `models`
 * allowlist (no openai-compat bypass) — adding new rerank models requires a
 * recipe edit. Cohere bills per-search; the `cost_per_1m_tokens_usd` value
 * is a pseudo-rate for the budget tracker's `chars/4` heuristic.
 *
 * Attribution: OpenRouter recommends `HTTP-Referer` (required for app
 * attribution) + `X-OpenRouter-Title` (preferred; `X-Title` kept as
 * back-compat alias per OR docs). Defaults to `https://gbrain.ai` / `gbrain`;
 * forks override via `OPENROUTER_REFERER` / `OPENROUTER_TITLE` env vars so
 * downstream agent stacks (OpenClaw deployments, etc.) get their own
 * attribution on OR's leaderboard instead of polluting gbrain's.
 *
 * Subagent loops: `supports_subagent_loop: false` is INFORMATIONAL. The real
 * gate is `isAnthropicProvider()` in `src/core/model-config.ts` which
 * hard-pins gbrain's subagent infra to Anthropic-direct (stable tool_use_id
 * across crashes/replays). OR-proxied Anthropic is rejected at submit time
 * regardless of this flag — relaxing the gate is a deeper architectural
 * change tracked in TODOS.md.
 */
export const openrouter: Recipe = {
  id: 'openrouter',
  name: 'OpenRouter',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://openrouter.ai/api/v1',
  auth_env: {
    required: ['OPENROUTER_API_KEY'],
    optional: ['OPENROUTER_BASE_URL', 'OPENROUTER_REFERER', 'OPENROUTER_TITLE'],
    setup_url: 'https://openrouter.ai/settings/keys',
  },
  resolveDefaultHeaders(env) {
    const referer = env.OPENROUTER_REFERER ?? 'https://gbrain.ai';
    const title = env.OPENROUTER_TITLE ?? 'gbrain';
    return {
      // Required by OR for app-attribution. Without HTTP-Referer no leaderboard
      // entry is ever created (per https://openrouter.ai/docs/app-attribution).
      'HTTP-Referer': referer,
      // Current preferred name per OR docs (2026).
      'X-OpenRouter-Title': title,
      // Back-compat alias documented as still-supported.
      'X-Title': title,
    };
  },
  touchpoints: {
    embedding: {
      models: ['openai/text-embedding-3-small'],
      default_dims: 1536,
      // text-embedding-3-small was trained at MRL breakpoints 512/1024/1536
      // (Weaviate analysis); 768 is a practical intermediate. Users opt into
      // a smaller dim via `gbrain config set embedding_dimensions <N>`.
      dims_options: [512, 768, 1024, 1536],
      cost_per_1m_tokens_usd: 0.02,
      price_last_verified: '2026-05-20',
      // OpenAI's published per-request aggregate is ~300K tokens for embeddings
      // (per-input cap is 8192). This is the AGGREGATE budget the gateway uses
      // to pre-split batches, NOT per-input. Per-input is enforced upstream.
      max_batch_tokens: 300_000,
    },
    chat: {
      // Curated entry points (verified against OR's catalog 2026-05-20). The
      // openai-compat tier does NOT enforce this list at runtime — users can
      // pass any model ID OR routes. Refresh quarterly; see TODOS.md.
      models: [
        'openai/gpt-5.2',
        'openai/gpt-5.2-chat',
        'openai/gpt-5.5',
        'anthropic/claude-haiku-4.5',
        'anthropic/claude-sonnet-4.6',
        'anthropic/claude-opus-4.7',
        'google/gemini-3-flash-preview',
        'deepseek/deepseek-chat',
      ],
      supports_tools: true,
      // Informational only — real gate is isAnthropicProvider() upstream.
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      // No max_context_tokens: catalog spans 128K to 1M+; a single recipe-wide
      // value is either unsafe for smaller models or wasteful for larger ones.
      // Let upstream errors surface per-model.
      price_last_verified: '2026-05-20',
    },
    reranker: {
      models: [
        'cohere/rerank-v3.5',
        'cohere/rerank-4-fast',
        'cohere/rerank-4-pro',
        'nvidia/llama-nemotron-rerank-vl-1b-v2:free',
      ],
      default_model: 'cohere/rerank-v3.5',
      // Cohere bills per-search, not per-token. This is a pseudo-per-1M rate
      // for the budget tracker's heuristic (estimates tokens as chars/4).
      // At ~4K chars/search the tracker estimates ~$0.00025 — in the right
      // ballpark for the per-search bill. Patch budget-tracker.ts to honour a
      // `cost_per_search_usd` field for exact accounting.
      cost_per_1m_tokens_usd: 0.001,
      price_last_verified: '2026-06-13',
      // OpenRouter doesn't publish an explicit payload cap; 5MB matches
      // ZeroEntropy's upstream limit and the gateway's pre-flight ceiling.
      max_payload_bytes: 5_000_000,
      // OR serves /rerank under /api/v1. base_url_default already ends in /v1,
      // so gateway concatenates to …/api/v1/rerank.
      path: '/rerank',
      // OpenRouter rerank is fast (<200 ms p50); 5 s covers cold path safely.
      default_timeout_ms: 5_000,
    },
  },
  setup_hint:
    'Get an API key at https://openrouter.ai/settings/keys, then `export OPENROUTER_API_KEY=...` and use `openrouter:<provider>/<model>`. Optional overrides: OPENROUTER_BASE_URL (proxy), OPENROUTER_REFERER (attribution URL), OPENROUTER_TITLE (attribution name).',
};
