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
  },
  setup_hint:
    'Get an API key at https://openrouter.ai/settings/keys, then `export OPENROUTER_API_KEY=...` and use `openrouter:<provider>/<model>`. Optional overrides: OPENROUTER_BASE_URL (proxy), OPENROUTER_REFERER (attribution URL), OPENROUTER_TITLE (attribution name).',
};
