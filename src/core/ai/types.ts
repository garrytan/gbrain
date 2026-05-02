/**
 * AI provider types.
 *
 * Recipes are pure data. The gateway's implementation switch decides which
 * statically-imported factory to use based on `implementation`.
 *
 * Bun-compile-safe: no dynamic imports. Adding a new native provider requires
 * both a recipe AND a code change to register the factory in gateway.ts.
 */

export type TouchpointKind = 'embedding' | 'expansion' | 'chunking' | 'transcription' | 'enrichment' | 'improve';

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

export interface AuthEnvConfig {
  required: string[];
  optional?: string[];
  setup_url?: string;
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
  auth_env?: AuthEnvConfig;
  touchpoints: {
    embedding?: EmbeddingTouchpoint;
    expansion?: ExpansionTouchpoint;
  };
  /** One-line description of setup (shown in wizard + env subcommand). */
  setup_hint?: string;
}

export type AuthSourceClass = 'env' | 'openclaw-codex' | 'openclaw-openai' | 'unauthenticated' | 'missing';

export interface ProviderAuthConfig {
  /** Default env auth remains highest-priority unless this explicitly selects another source. */
  prefer?: Exclude<AuthSourceClass, 'env' | 'unauthenticated' | 'missing'>;
  /** Optional profile name for OpenClaw-backed auth. */
  profile?: string;
  /** Optional auth store override for tests or nonstandard installs. */
  openclawAuthPath?: string;
}

export interface AuthResolution {
  source: AuthSourceClass;
  credentialKey?: string;
  value?: string;
  isConfigured: boolean;
  missingReason?: string;
  meta?: Record<string, unknown>;
}

export interface AIGatewayConfig {
  /** Current embedding model as "provider:modelId" (e.g. "openai:text-embedding-3-large"). */
  embedding_model?: string;
  /** Target embedding dims. Gateway asserts returned embeddings match this. */
  embedding_dimensions?: number;
  /** Current expansion model as "provider:modelId". */
  expansion_model?: string;
  /** Optional per-provider base URL override (openai-compatible variants). */
  base_urls?: Record<string, string>;
  /** Optional provider auth source overrides keyed by recipe id. */
  provider_auth?: Record<string, ProviderAuthConfig>;
  /** Env snapshot read once at configuration time. Gateway never reads process.env at call time. */
  env: Record<string, string | undefined>;
}

export interface ParsedModelId {
  providerId: string; // e.g. "openai"
  modelId: string; // e.g. "text-embedding-3-large"
}
