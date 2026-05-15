/**
 * AI provider types.
 *
 * Recipes are pure data. The gateway's implementation switch decides which
 * statically-imported factory to use based on `implementation`.
 *
 * Bun-compile-safe: no dynamic imports. Adding a new native provider requires
 * both a recipe AND a code change to register the factory in gateway.ts.
 */

export type TouchpointKind =
  | 'embedding'
  | 'expansion'
  | 'chat'
  | 'chunking'
  | 'transcription'
  | 'enrichment'
  | 'improve'
  | 'reranker';

export type Implementation =
  | 'native-openai'
  | 'native-google'
  | 'native-anthropic'
  | 'openai-compatible';

export interface EmbeddingTouchpoint {
  models: string[];
  default_dims: number;
  dims_options?: number[]; // for Matryoshka-aware providers
  cost_per_1m_tokens_usd?: number;
  price_last_verified?: string; // ISO date
  /**
   * Maximum tokens per batch for this provider's embedding endpoint.
   * When set, the gateway pre-splits batches at
   * `max_batch_tokens × safety_factor / chars_per_token` characters and
   * recursively halves on token-limit errors at runtime. When unset, the
   * gateway makes a single embedMany() call with no safety net (OpenAI fast
   * path).
   */
  max_batch_tokens?: number;
  /**
   * Expected character density for this provider's tokenizer (chars per
   * token). OpenAI tiktoken averages ~4 on English text; Voyage averages
   * ~1 on mixed content (code/JSON/CJK). Defaults to 4 if omitted.
   * Only consulted when `max_batch_tokens` is also set.
   */
  chars_per_token?: number;
  /**
   * Budget-utilization ceiling in (0, 1]. The gateway pre-splits at
   * `safety_factor × max_batch_tokens` to leave headroom for tokenizer
   * variance. Defaults to 0.8. Voyage-style providers with dense payloads
   * should pin this lower (e.g. 0.5). Only consulted when
   * `max_batch_tokens` is also set.
   */
  safety_factor?: number;
  /**
   * v0.27.1: when true, at least one model in this recipe accepts image
   * inputs via a multimodal embedding endpoint (e.g. Voyage's
   * /v1/multimodalembeddings). Drives gateway.embedMultimodal() routing.
   * Text-only providers leave this undefined.
   */
  supports_multimodal?: boolean;
  /**
   * v0.28.11: explicit list of models in this recipe that accept multimodal
   * input. Required when the recipe mixes text-only and multimodal models
   * under the same touchpoint (e.g. Voyage). embedMultimodal() validates
   * `parsed.modelId` against this list AFTER `supports_multimodal` is true,
   * pre-flighting the HTTP 400 a non-multimodal-capable model would otherwise
   * trigger at the endpoint. When omitted, every model in `models` is
   * treated as multimodal-capable (back-compat for providers where the whole
   * recipe is multimodal). The check fires only inside embedMultimodal();
   * text embedding paths ignore it.
   */
  multimodal_models?: string[];
  /**
   * v0.32: when true, the recipe ships without a fixed model list and users
   * MUST provide `--embedding-model provider:model` and
   * `--embedding-dimensions N` explicitly. Used by litellm-proxy and
   * llama-server (and any future "bring your own backend" recipe).
   *
   * Consumers:
   *  - `recipes-contract.test.ts` permits `models.length === 0` only when
   *    this flag is true.
   *  - `gateway.ts` skips the model-list-must-include-modelId check.
   *  - `init.ts:resolveAIOptions` refuses the implicit "first model" pick
   *    for shorthand `--model <provider>` and prints a setup hint.
   */
  user_provided_models?: true;
  /**
   * v0.32 (#779 reworked): explicit opt-out of the missing-max_batch_tokens
   * startup warning. Set to `true` for recipes whose batch capacity is
   * genuinely dynamic (Ollama: depends on user-loaded model; LiteLLM proxy:
   * depends on backend; llama.cpp: depends on `--ctx-size` at server launch).
   *
   * Without this flag, missing `max_batch_tokens` triggers a once-per-process
   * stderr warning so future recipes that forget the cap (and would
   * silently rely on recursive-halving) don't ship un-noticed. Recipes that
   * declare `no_batch_cap: true` are explicitly opting out — the warning is
   * noise for them.
   */
  no_batch_cap?: true;
}

/**
 * v0.27.1: input shape for gateway.embedMultimodal(). Discriminated union;
 * today the only kind is image_base64 (raw bytes encoded by the caller).
 * Future kinds (image_url, video_keyframe) extend the union without
 * widening callers because the discriminator is exhaustive.
 *
 * No image_url variant: SSRF surface. Callers must read the bytes and
 * base64-encode them; the gateway never fetches external URLs.
 */
export type MultimodalInput =
  | { kind: 'image_base64'; data: string; mime: string };

export interface ExpansionTouchpoint {
  models: string[];
  cost_per_1m_tokens_usd?: number;
  price_last_verified?: string;
}

/**
 * Chat touchpoint: tool-using conversational LLMs that can drive Minions
 * subagents. `supports_tools` and `supports_subagent_loop` are intentionally
 * separate (Codex F-OV-2): some chat-capable models have flaky tool-calling or
 * unstable tool_call_id behavior across replays. supports_subagent_loop is the
 * stricter signal that subagent.ts asserts.
 */
/**
 * Reranker touchpoint (v0.33.2+): cross-encoder rerankers that take a query
 * + N documents and return a relevance-score-sorted index list. Slots into
 * `applyReranker()` in src/core/search/rerank.ts between RRF dedup and
 * token-budget enforcement.
 *
 * Reranking is NOT in the AI SDK's abstraction — `gateway.rerank()` makes a
 * native HTTP call. The recipe carries auth + base URL + model allowlist; the
 * gateway uses `recipe.auth_env.required[0]` for the Bearer token and posts to
 * `${recipe.base_url_default}/models/rerank` (or the recipe-specific path).
 *
 * `max_payload_bytes` is the upstream's per-request size cap. gateway.rerank()
 * pre-flights the body size and throws RerankError with reason
 * 'payload_too_large' when over-cap; applyReranker catches this and falls
 * back to RRF order (fail-open).
 */
export interface RerankerTouchpoint {
  models: string[];
  default_model: string;
  cost_per_1m_tokens_usd?: number;
  price_last_verified?: string;
  max_payload_bytes: number;
}

export interface ChatTouchpoint {
  models: string[];
  /** Provider returns native function/tool calling. */
  supports_tools: boolean;
  /**
   * Stable enough across crashes/replays to drive a Minions subagent loop.
   * Strictly stronger than supports_tools.
   */
  supports_subagent_loop: boolean;
  /** Anthropic-style ephemeral prompt cache markers honored. */
  supports_prompt_cache?: boolean;
  max_context_tokens?: number;
  cost_per_1m_input_usd?: number;
  cost_per_1m_output_usd?: number;
  price_last_verified?: string;
}

export interface Recipe {
  /** Stable lowercase id used in `provider:model` strings. Unique across recipes. */
  id: string;
  /** Human-readable name for display. */
  name: string;
  /** Distinguishes native-package providers from openai-compatible endpoints. */
  tier: 'native' | 'openai-compat';
  /** Maps to the gateway's implementation switch. */
  implementation: Implementation;
  /** For openai-compatible tier: default base URL. May be overridden by env or wizard. */
  base_url_default?: string;
  /** Env var name(s) for auth; first is required, rest are optional. */
  auth_env?: {
    required: string[];
    optional?: string[];
    setup_url?: string;
  };
  touchpoints: {
    embedding?: EmbeddingTouchpoint;
    expansion?: ExpansionTouchpoint;
    chat?: ChatTouchpoint;
    reranker?: RerankerTouchpoint;
  };
  /**
   * Optional alias map for friendlier `provider:model` strings.
   * Resolved at parse time. For pre-4.6 models, undated forms alias to dated
   * pinned snapshots (e.g. `claude-haiku-4-5` → `claude-haiku-4-5-20251001`).
   * For Claude 4.6+, model IDs are dateless and self-pinned — no forward alias
   * needed. Reverse-direction entries can rewrite stale/broken IDs back to
   * canonical (e.g. `claude-sonnet-4-6-20250929` → `claude-sonnet-4-6`) for
   * back-compat with users who have stale config strings.
   */
  aliases?: Record<string, string>;
  /** One-line description of setup (shown in wizard + env subcommand). */
  setup_hint?: string;
  /**
   * v0.32 (D12=A): unified auth resolver across embed / expansion / chat
   * touchpoints. Returns the header name (`Authorization`, `api-key`, etc.)
   * and the full header value (for Bearer-style providers, include the
   * `Bearer ` prefix). Throws AIConfigError when required env is missing
   * with a hint pointing at the recipe's setup_url.
   *
   * When omitted, the gateway applies a default that returns
   * `{headerName: 'Authorization', token: 'Bearer ' + env[auth_env.required[0]]}`.
   * The default is the right behavior for OpenAI-compatible providers with a
   * single API key. Recipes deviating (Azure uses `api-key`; future OAuth
   * providers fetch dynamic tokens) override this.
   *
   * IMPORTANT: this runs at gateway-configure time (NOT at embed-call time)
   * so the env snapshot in `cfg.env` is consulted, never `process.env`.
   */
  resolveAuth?(env: Record<string, string | undefined>): {
    headerName: string;
    token: string;
  };
  /**
   * v0.32: templated openai-compatible config for recipes whose URL shape
   * doesn't fit a static `base_url_default`. Returns the resolved baseURL
   * and an optional fetch wrapper for cases like Azure OpenAI that need a
   * query parameter (?api-version=) injected on every request.
   *
   * Default behavior (when undefined): use `base_urls[recipe.id]` from
   * config or `recipe.base_url_default`. Throws `AIConfigError` when both
   * are missing.
   *
   * Currently only Azure OpenAI overrides this — the URL is templated
   * from `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT` and the fetch
   * wrapper splices `api-version` into every request URL.
   */
  resolveOpenAICompatConfig?(env: Record<string, string | undefined>): {
    baseURL: string;
    fetch?: typeof fetch;
  };
  /**
   * v0.32 (D13=A): optional runtime readiness check for local-server
   * recipes (ollama, llama-server, future lmstudio-recipe). Returns
   * `ready: false` when the local endpoint isn't reachable, with a `hint`
   * the wizard / doctor can surface.
   *
   * Defaults to env-only readiness (`auth_env.required` all set) when
   * absent. Consumed by `runExplain()` in `src/commands/providers.ts` and
   * by the doctor's embedding probe; both wrap the call in
   * `Promise.allSettled` with a 200ms timeout so a hung local server does
   * not block the provider matrix.
   *
   * `baseURL`: optional resolved URL the gateway will actually call (from
   * `cfg.base_urls[recipe.id]` or recipe defaults). Pass it so the probe
   * checks the same endpoint as live traffic. Without it, the probe falls
   * back to recipe defaults / env, which can disagree with config-only
   * URL overrides (codex finding #5).
   */
  probe?(baseURL?: string): Promise<{ ready: boolean; hint?: string }>;
}

export interface AIGatewayConfig {
  /** Current embedding model as "provider:modelId" (e.g. "openai:text-embedding-3-large"). */
  embedding_model?: string;
  /** Target embedding dims. Gateway asserts returned embeddings match this. */
  embedding_dimensions?: number;
  /**
   * Separate model for multimodal embeddings (e.g. "voyage:voyage-multimodal-3").
   * When set, embedMultimodal() routes to this model instead of embedding_model.
   * Allows brains using OpenAI for text to use Voyage for image embeddings.
   */
  embedding_multimodal_model?: string;
  /** Current expansion model as "provider:modelId". */
  expansion_model?: string;
  /** Default chat model for `gateway.chat()` callers (subagent default). */
  chat_model?: string;
  /**
   * v0.33.2+: default reranker model for `gateway.rerank()` callers. As
   * `'provider:model'` (e.g. `'zeroentropyai:zerank-2'`). Resolved at
   * configure time and re-resolved by reconfigureGatewayWithEngine() when
   * mode-bundle or config-key overrides change.
   */
  reranker_model?: string;
  /**
   * Optional silent-refusal fallback chain ("provider:modelId" entries).
   * Plumbed for `chatWithFallback()` (commit 3). Blocked from critic/judge/
   * synthesize flows in their respective handlers.
   */
  chat_fallback_chain?: string[];
  /** Optional per-provider base URL override (openai-compatible variants). */
  base_urls?: Record<string, string>;
  /** Env snapshot read once at configuration time. Gateway never reads process.env at call time. */
  env: Record<string, string | undefined>;
}

export interface ParsedModelId {
  providerId: string; // e.g. "openai"
  modelId: string; // e.g. "text-embedding-3-large"
}
