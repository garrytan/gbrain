import type { Recipe } from '../types.ts';

/**
 * Private in-process marker header. `gateway.chat()` sets it when the caller
 * asked for prompt caching (`cacheSystem`) on an OpenRouter route that needs
 * an explicit `cache_control` (Anthropic Claude). The compat fetch shim below
 * strips it and rewrites the body; the header NEVER leaves the process.
 *
 * Why a header and not providerOptions: the AI SDK's openai-compatible
 * adapter validates providerOptions against a fixed schema and silently
 * drops anthropic-namespace fields before building the wire body (same class
 * of problem as the embedding `input_type` ALS in gateway.ts). Headers pass
 * through untouched.
 */
export const OPENROUTER_CACHE_HEADER = 'x-gbrain-anthropic-prompt-cache';

/**
 * Family-scoped prompt-cache capability (per OpenRouter docs):
 * - OpenAI chat routes cache automatically (no request mutation needed).
 * - Anthropic Claude routes cache when the request carries `cache_control`
 *   on a content block (applied by the fetch shim below).
 * Everything else is not marked cacheable — deliberately narrow rather than
 * blessing every routed model family forever.
 */
export function openrouterSupportsPromptCache(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.startsWith('openai/gpt-') || /^openai\/o\d/.test(normalized)) return true;
  if (normalized.startsWith('anthropic/claude-')) return true;
  return false;
}

/** Only Anthropic Claude routes need an explicit cache_control block. */
export function openrouterRequiresExplicitPromptCache(modelId: string): boolean {
  return modelId.trim().toLowerCase().startsWith('anthropic/claude-');
}

/**
 * Rewrite the last system message's string content into OpenRouter's
 * documented Anthropic caching shape: a content-part array carrying
 * `cache_control: { type: 'ephemeral' }` on the text block. (A top-level
 * body `cache_control` is NOT the OpenRouter format — OR forwards per-block
 * markers only.) Returns the input unchanged when it doesn't apply.
 */
function withSystemCacheControl(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const model = typeof record.model === 'string' ? record.model : '';
  if (!openrouterRequiresExplicitPromptCache(model)) return body;
  const messages = Array.isArray(record.messages) ? record.messages : undefined;
  if (!messages) return body;
  let idx = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && typeof m === 'object' && (m as Record<string, unknown>).role === 'system') idx = i;
  }
  if (idx === -1) return body;
  const sys = messages[idx] as Record<string, unknown>;
  if (typeof sys.content !== 'string' || sys.content.length === 0) return body;
  const next = messages.slice();
  next[idx] = {
    ...sys,
    content: [{ type: 'text', text: sys.content, cache_control: { type: 'ephemeral' } }],
  };
  return { ...record, messages: next };
}

/**
 * Compat fetch: honors the OPENROUTER_CACHE_HEADER marker by splicing an
 * Anthropic cache_control breakpoint onto the system block, then strips the
 * marker. Fail-open: any parse problem sends the original body unchanged.
 *
 * @internal exported for tests. Cast through `unknown` because TS's
 * `typeof fetch` includes a `preconnect` member (matches azure-openai.ts).
 */
export const openrouterCompatFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  if (!init?.headers) return fetch(input as any, init as any);
  const headers = new Headers(init.headers as any);
  if (!headers.has(OPENROUTER_CACHE_HEADER)) return fetch(input as any, init as any);
  headers.delete(OPENROUTER_CACHE_HEADER);
  let body = init.body;
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      const rewritten = withSystemCacheControl(parsed);
      if (rewritten !== parsed) {
        body = JSON.stringify(rewritten);
        headers.delete('content-length');
      }
    } catch {
      // Non-JSON body: let the provider surface the original problem.
    }
  }
  return fetch(input as any, { ...init, headers, body } as any);
}) as unknown as typeof fetch;

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
      // Family-scoped: OpenAI routes cache automatically; Anthropic routes
      // cache via the compat fetch shim's cache_control rewrite.
      supports_prompt_cache: openrouterSupportsPromptCache,
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
  compat: { fetch: openrouterCompatFetch },
};
