/**
 * Embedding service configuration.
 *
 * Historically GBrain hardcoded:
 *   - model        = 'text-embedding-3-large'
 *   - dimensions   = 1536
 *   - cost/1k      = $0.00013 (OpenAI 2026 pricing)
 *   - baseURL      = OpenAI default
 *   - API key      = OPENAI_API_KEY
 *   - batch size   = 100
 *
 * That worked when "embedding" meant "OpenAI". Today users want local
 * inference (Ollama, LM Studio, vLLM, Together, Fireworks) — different
 * models, different dimensions, different (or zero) cost. This module
 * centralizes every knob behind GBRAIN_EMBED_* env vars with backward-
 * compatible defaults.
 *
 * Validation: every value is read once, validated, cached. Invalid values
 * fall back to the historical default with a one-time warning so a typo
 * doesn't silently corrupt the brain.
 *
 * Important constraint: changing GBRAIN_EMBED_DIMENSIONS on an existing
 * brain is a schema change (the `embedding` column is `vector(N)` and
 * Postgres won't auto-cast between dims). The migration story for that
 * is out of scope for this module — see docs/guides/local-models.md.
 */

export interface EmbeddingConfig {
  /** Model identifier sent to the embeddings API (e.g. 'text-embedding-3-large', 'nomic-embed-text', 'mxbai-embed-large'). */
  model: string;
  /** Output vector dimensions. Must match the model's actual dimension. */
  dimensions: number;
  /** USD cost per 1k tokens. Set to 0 for local models. */
  costPer1kTokens: number;
  /** Optional baseURL override for OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, etc.). */
  baseUrl: string | undefined;
  /** Optional API key override. Falls back to OPENAI_API_KEY when undefined. */
  apiKey: string | undefined;
  /** Batch size for bulk embedding requests. */
  batchSize: number;
  /** Maximum input character length before truncation. */
  maxChars: number;
}

const DEFAULTS: EmbeddingConfig = {
  model: 'text-embedding-3-large',
  dimensions: 1536,
  costPer1kTokens: 0.00013,
  baseUrl: undefined,
  apiKey: undefined,
  batchSize: 100,
  maxChars: 8000,
};

let cached: EmbeddingConfig | null = null;

/** Hard limits that prevent obviously-invalid configs from reaching Postgres. */
const MIN_DIM = 1;
const MAX_DIM = 16384; // pgvector hard limit for hnsw indexes
const MIN_BATCH = 1;
const MAX_BATCH = 2048;

function readInt(envKey: string, fallback: number, min: number, max: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.warn(`[gbrain] Invalid ${envKey}='${raw}' (not an integer). Falling back to ${fallback}.`);
    return fallback;
  }

  if (parsed < min || parsed > max) {
    console.warn(`[gbrain] ${envKey}=${parsed} out of range [${min}, ${max}]. Falling back to ${fallback}.`);
    return fallback;
  }

  return parsed;
}

function readFloat(envKey: string, fallback: number, min: number, max: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[gbrain] Invalid ${envKey}='${raw}' (not a number). Falling back to ${fallback}.`);
    return fallback;
  }

  if (parsed < min || parsed > max) {
    console.warn(`[gbrain] ${envKey}=${parsed} out of range [${min}, ${max}]. Falling back to ${fallback}.`);
    return fallback;
  }

  return parsed;
}

function readModel(envKey: string, fallback: string): string {
  const raw = process.env[envKey]?.trim();
  if (!raw) return fallback;

  // Model identifiers can contain letters, digits, hyphens, underscores,
  // colons (Ollama uses 'model:tag'), dots (versioned models), and slashes
  // (HuggingFace-style 'org/model'). Reject anything else as a guard
  // against accidental shell expansion or whitespace.
  if (!/^[a-zA-Z0-9._:\-/]+$/.test(raw)) {
    console.warn(`[gbrain] Invalid ${envKey}='${raw}' (contains forbidden characters). Falling back to '${fallback}'.`);
    return fallback;
  }

  return raw;
}

function readUrl(envKey: string): string | undefined {
  const raw = process.env[envKey]?.trim();
  if (!raw) return undefined;

  // Defensive parse — if it doesn't look like a URL, ignore it so the
  // OpenAI client falls back to its default endpoint.
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      console.warn(`[gbrain] Invalid ${envKey}='${raw}' (must be http:// or https://). Ignoring.`);
      return undefined;
    }
    return raw;
  } catch {
    console.warn(`[gbrain] Invalid ${envKey}='${raw}' (not a valid URL). Ignoring.`);
    return undefined;
  }
}

/**
 * Returns the active embedding configuration, reading from env once and
 * caching the result. Subsequent calls return the same object.
 */
export function getEmbeddingConfig(): EmbeddingConfig {
  if (cached !== null) return cached;

  cached = {
    model: readModel('GBRAIN_EMBED_MODEL', DEFAULTS.model),
    dimensions: readInt('GBRAIN_EMBED_DIMENSIONS', DEFAULTS.dimensions, MIN_DIM, MAX_DIM),
    costPer1kTokens: readFloat('GBRAIN_EMBED_COST_PER_1K', DEFAULTS.costPer1kTokens, 0, 1000),
    baseUrl: readUrl('GBRAIN_EMBED_URL'),
    apiKey: process.env.GBRAIN_EMBED_KEY?.trim() || undefined,
    batchSize: readInt('GBRAIN_EMBED_BATCH', DEFAULTS.batchSize, MIN_BATCH, MAX_BATCH),
    maxChars: readInt('GBRAIN_EMBED_MAX_CHARS', DEFAULTS.maxChars, 100, 100_000),
  };

  return cached;
}

/**
 * Resets the cached config. Tests only — don't use in production code.
 */
export function resetEmbeddingConfigCache(): void {
  cached = null;
}

/**
 * The static defaults, exposed so tests and migration code can compare
 * against the historical baseline without re-reading env.
 */
export const EMBEDDING_DEFAULTS: Readonly<EmbeddingConfig> = Object.freeze(DEFAULTS);
