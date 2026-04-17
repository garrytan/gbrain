/**
 * Provider factory — resolves a ProviderConfig to a concrete EmbeddingProvider.
 *
 * Resolution order (most specific wins):
 *   1. Explicit ProviderConfig argument (from CLI flags or `.gbrain.config.json`)
 *   2. Env vars: EMBEDDING_PROVIDER, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_BASE_URL
 *   3. Defaults: OpenAI text-embedding-3-large at 1536 dimensions
 *
 * Callers should pass an explicit config when they have one. Env-var fallback exists for
 * scripts and tests that don't go through `gbrain init`.
 */

import type { EmbeddingProvider, ProviderConfig } from './provider.ts';
import { OpenAIProvider } from './providers/openai.ts';
import { OllamaProvider } from './providers/ollama.ts';

const REGISTRY: Record<string, new (config: ProviderConfig) => EmbeddingProvider> = {
  openai: OpenAIProvider,
  ollama: OllamaProvider,
};

export function createProvider(config?: Partial<ProviderConfig>): EmbeddingProvider {
  const resolved = resolveConfig(config);
  const ProviderClass = REGISTRY[resolved.provider];
  if (!ProviderClass) {
    const known = Object.keys(REGISTRY).join(', ');
    throw new Error(`Unknown embedding provider '${resolved.provider}'. Known: ${known}.`);
  }
  return new ProviderClass(resolved);
}

export function resolveConfig(override?: Partial<ProviderConfig>): ProviderConfig {
  const fromEnv: Partial<ProviderConfig> = {
    provider: process.env.EMBEDDING_PROVIDER,
    model: process.env.EMBEDDING_MODEL,
    dimensions: process.env.EMBEDDING_DIMENSIONS
      ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10)
      : undefined,
    baseUrl: process.env.EMBEDDING_BASE_URL ?? process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
  };

  // Override > env > defaults (defaults filled per-provider in the constructor)
  const provider = override?.provider ?? fromEnv.provider ?? 'openai';
  return {
    provider,
    model: override?.model ?? fromEnv.model,
    dimensions: override?.dimensions ?? fromEnv.dimensions,
    baseUrl: override?.baseUrl ?? fromEnv.baseUrl,
    apiKey: override?.apiKey ?? fromEnv.apiKey,
  };
}

export function listProviders(): string[] {
  return Object.keys(REGISTRY);
}
