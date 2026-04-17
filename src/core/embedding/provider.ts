/**
 * EmbeddingProvider — the contract every embedding backend implements.
 *
 * Provider quirks (Matryoshka dim param, error shapes, auth) live behind this interface
 * so callers (service, init, embed command) never branch on provider name.
 *
 * All providers MUST return vectors of exactly `dimensions` length per call.
 * If a provider's model returns a different size, the provider implementation
 * must reject (not silently truncate/pad).
 */

export interface EmbeddingProvider {
  readonly name: string;          // 'openai' | 'ollama' | future
  readonly model: string;         // 'text-embedding-3-large' | 'nomic-embed-text' | ...
  readonly dimensions: number;    // fixed for the lifetime of this instance
  readonly maxInputChars: number; // truncation budget per text

  embed(texts: string[]): Promise<Float32Array[]>;

  /** Lightweight liveness check — used by `gbrain doctor` and init. */
  healthCheck(): Promise<HealthCheckResult>;
}

export interface HealthCheckResult {
  ok: boolean;
  reason?: string;
  // Optional metadata for `gbrain doctor --json`
  latencyMs?: number;
  detectedDimensions?: number;
}

export interface ProviderConfig {
  /** Provider name. Currently 'openai' or 'ollama'. */
  provider: string;
  /** Model identifier. Required for non-default providers; optional for openai (defaults to text-embedding-3-large). */
  model?: string;
  /** Output dimension. Required if it cannot be inferred from (provider, model). */
  dimensions?: number;
  /** Override base URL (for self-hosted vLLM, LiteLLM proxy, custom Ollama port). */
  baseUrl?: string;
  /** API key. Optional for local providers; required for OpenAI proper. */
  apiKey?: string;
}
