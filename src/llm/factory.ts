/**
 * Provider Factory
 *
 * Resolves the correct adapter from `GBrainConfig`. Handles:
 *   - Mapping `provider` string to adapter class
 *   - Injecting API keys from config or predictable env vars
 *   - Injecting `base_url` overrides
 *   - Instantiating the model tier resolver
 *
 * Adding a new provider means adding one line in the factory map,
 * not touching consumers.
 */

import { loadConfig, type GBrainConfig } from '../core/config.ts';
import { AnthropicAdapter } from './adapters/anthropic.ts';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible.ts';
import type { AIProvider } from './provider.ts';
import { resolveModel } from './tiers.ts';

/**
 * Build an LLM provider from config.
 *
 * Priority:
 *   1. New multi-provider path (`llm_provider` set)
 *   2. Legacy path (`anthropic_api_key` or `ANTHROPIC_API_KEY` env var)
 *   3. No provider configured → returns `null`
 */
export function getLlmProvider(config?: GBrainConfig): AIProvider | null {
  const cfg = config ?? loadConfig();
  if (!cfg) return null;

  // ── New multi-provider path ───────────────────────────────
  if (cfg.llm_provider) {
    const apiKey =
      cfg.llm_api_key ??
      (cfg.llm_provider === 'anthropic'
        ? cfg.anthropic_api_key ?? process.env.ANTHROPIC_API_KEY
        : cfg.llm_provider === 'deepseek'
          ? process.env.DEEPSEEK_API_KEY
          : cfg.openai_api_key ?? process.env.OPENAI_API_KEY) ??
      process.env.LLM_API_KEY;
    if (!apiKey) return null;

    const model = resolveModel(cfg.llm_provider, 'smart', cfg);

    if (cfg.llm_provider === 'anthropic') {
      return new AnthropicAdapter({ apiKey, baseURL: cfg.llm_base_url });
    }

    // All other providers speak OpenAI-compatible Chat Completions
    return new OpenAICompatibleAdapter({
      apiKey,
      baseURL: cfg.llm_base_url,
      model,
    });
  }

  // ── Legacy path: Anthropic for LLM ────────────────────────
  const legacyKey = cfg.anthropic_api_key ?? process.env.ANTHROPIC_API_KEY;
  if (legacyKey) {
    return new AnthropicAdapter({ apiKey: legacyKey });
  }

  return null;
}

/**
 * Build an embedding provider from config.
 *
 * Priority:
 *   1. New multi-provider path (`embedding_provider` set)
 *   2. Legacy path (`openai_api_key` or `OPENAI_API_KEY` env var)
 *   3. No provider configured → returns `null`
 */
export function getEmbeddingProvider(config?: GBrainConfig): AIProvider | null {
  const cfg = config ?? loadConfig();
  if (!cfg) return null;

  // ── New multi-provider path ───────────────────────────────
  if (cfg.embedding_provider) {
    const apiKey =
      cfg.embedding_api_key ??
      cfg.llm_api_key ??
      cfg.openai_api_key ??
      process.env.OPENAI_API_KEY ??
      process.env.EMBEDDING_API_KEY ??
      process.env.LLM_API_KEY;
    if (!apiKey) return null;

    const model = resolveModel(cfg.embedding_provider, 'embedding', cfg);
    const dimensions =
      cfg.embedding_provider === 'openai' && model === 'text-embedding-3-large'
        ? 1536
        : undefined;

    return new OpenAICompatibleAdapter({
      apiKey,
      baseURL: cfg.embedding_base_url,
      model,
      dimensions,
    });
  }

  // ── Legacy path: OpenAI for embeddings ────────────────────
  const legacyKey = cfg.openai_api_key ?? process.env.OPENAI_API_KEY;
  if (legacyKey) {
    return new OpenAICompatibleAdapter({
      apiKey: legacyKey,
      model: 'text-embedding-3-large',
      dimensions: 1536,
    });
  }

  return null;
}
