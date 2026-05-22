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
  | 'improve';

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
}

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
  };
  /**
   * Optional alias map for friendlier `provider:model` strings (Codex F-OV-5).
   * Resolved at parse time so users can write `anthropic:claude-sonnet-4-6`
   * instead of `anthropic:claude-sonnet-4-6-20250929`. Keys are aliases,
   * values are canonical (declared) model ids.
   */
  aliases?: Record<string, string>;
  /** One-line description of setup (shown in wizard + env subcommand). */
  setup_hint?: string;
}

export interface AIGatewayConfig {
  /** Current embedding model as "provider:modelId" (e.g. "openai:text-embedding-3-large"). */
  embedding_model?: string;
  /** Target embedding dims. Gateway asserts returned embeddings match this. */
  embedding_dimensions?: number;
  /** Current expansion model as "provider:modelId". */
  expansion_model?: string;
  /** Default chat model for `gateway.chat()` callers (subagent default). */
  chat_model?: string;
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
