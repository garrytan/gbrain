/**
 * AI Gateway — unified seam for every AI call gbrain makes.
 *
 * v0.14 exports:
 *   - configureGateway(config) — called once by cli.ts connectEngine()
 *   - embed(texts)              — embedding for put_page + import
 *   - embedOne(text)            — convenience wrapper
 *   - expand(query)             — query expansion for hybrid search
 *   - isAvailable(touchpoint)   — replaces scattered OPENAI_API_KEY checks
 *   - getEmbeddingDimensions()  — for schema setup
 *   - getEmbeddingModel()       — for schema metadata
 *
 * Future stubs: chunk, transcribe, enrich, improve (throw NotMigratedYet until migrated).
 *
 * DESIGN RULES:
 *   - Gateway reads config from a single configureGateway() call.
 *   - NEVER reads process.env at call time (Codex C3).
 *   - AI SDK error instances are normalized to AIConfigError / AITransientError.
 *   - Explicit dimensions passthrough preserves existing 1536 brains (Codex C1).
 *   - Per-provider model cache keyed by (provider, modelId, baseUrl) so env
 *     rotation (via configureGateway()) invalidates stale entries.
 */

import { embed as aiEmbed, embedMany, generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';

import type {
  AIGatewayConfig,
  AuthResolution,
  Recipe,
  TouchpointKind,
} from './types.ts';
import { resolveProviderAuth } from './auth.ts';
import { resolveRecipe, assertTouchpoint } from './model-resolver.ts';
import { dimsProviderOptions } from './dims.ts';
import { AIConfigError, AITransientError, normalizeAIError } from './errors.ts';

const MAX_CHARS = 8000;
const DEFAULT_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_EXPANSION_MODEL = 'anthropic:claude-haiku-4-5-20251001';

let _config: AIGatewayConfig | null = null;
const _modelCache = new Map<string, any>();

/** Configure the gateway. Called by cli.ts#connectEngine. Clears cached models. */
export function configureGateway(config: AIGatewayConfig): void {
  _config = {
    embedding_model: config.embedding_model ?? DEFAULT_EMBEDDING_MODEL,
    embedding_dimensions: config.embedding_dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
    expansion_model: config.expansion_model ?? DEFAULT_EXPANSION_MODEL,
    base_urls: config.base_urls,
    provider_auth: config.provider_auth,
    env: config.env,
  };
  _modelCache.clear();
}

/** Reset (for tests). */
export function resetGateway(): void {
  _config = null;
  _modelCache.clear();
}

function requireConfig(): AIGatewayConfig {
  if (!_config) {
    throw new AIConfigError(
      'AI gateway is not configured. Call configureGateway() during engine connect.',
      'This is a gbrain bug — file an issue at https://github.com/garrytan/gbrain/issues',
    );
  }
  return _config;
}

/** Public config accessors (for schema setup, doctor, etc.). */
export function getEmbeddingModel(): string {
  return requireConfig().embedding_model ?? DEFAULT_EMBEDDING_MODEL;
}

export function getEmbeddingDimensions(): number {
  return requireConfig().embedding_dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
}

export function getExpansionModel(): string {
  return requireConfig().expansion_model ?? DEFAULT_EXPANSION_MODEL;
}

/**
 * Check whether a touchpoint can be served given the current config.
 * Replaces scattered `!process.env.OPENAI_API_KEY` checks (Codex C3).
 */
export function isAvailable(touchpoint: TouchpointKind): boolean {
  if (!_config) return false;
  try {
    const modelStr =
      touchpoint === 'embedding'
        ? getEmbeddingModel()
        : touchpoint === 'expansion'
        ? getExpansionModel()
        : null;
    if (!modelStr) return false;
    const { recipe } = resolveRecipe(modelStr);

    // Recipe must actually support the requested touchpoint.
    // Anthropic declares only expansion (no embedding model); requesting embedding
    // from an anthropic-configured brain is unavailable regardless of auth.
    const touchpointConfig = recipe.touchpoints[touchpoint as 'embedding' | 'expansion'];
    if (!touchpointConfig) return false;
    // Openai-compat recipes with empty models list (e.g. litellm template) require user-provided model
    if (Array.isArray(touchpointConfig.models) && touchpointConfig.models.length === 0 && recipe.id === 'litellm') return false;

    // For openai-compatible without auth requirements (Ollama local), treat as always-available.
    const resolution = resolveProviderAuth(recipe, _config!);
    return resolution.isConfigured;
  } catch {
    return false;
  }
}

// ---- Embedding ----

async function resolveEmbeddingProvider(modelStr: string): Promise<{ model: any; recipe: Recipe; modelId: string }> {
  const { parsed, recipe } = resolveRecipe(modelStr);
  assertTouchpoint(recipe, 'embedding', parsed.modelId);
  const cfg = requireConfig();

  const cacheKey = `emb:${recipe.id}:${parsed.modelId}:${cfg.base_urls?.[recipe.id] ?? ''}`;
  const cached = _modelCache.get(cacheKey);
  if (cached) return { model: cached, recipe, modelId: parsed.modelId };

  const model = instantiateEmbedding(recipe, parsed.modelId, cfg);
  _modelCache.set(cacheKey, model);
  return { model, recipe, modelId: parsed.modelId };
}

function requireAuth(resolution: AuthResolution, recipe: Recipe, action: string): string {
  if (!resolution.isConfigured || !resolution.value) {
    throw new AIConfigError(
      `${recipe.name} ${action} requires ${resolution.credentialKey ?? 'credentials'}.`,
      recipe.setup_hint,
    );
  }
  return resolution.value;
}

function instantiateEmbedding(recipe: Recipe, modelId: string, cfg: AIGatewayConfig): any {
  const auth = resolveProviderAuth(recipe, cfg);
  switch (recipe.implementation) {
    case 'native-openai': {
      const apiKey = requireAuth(auth, recipe, 'embedding');
      const client = createOpenAI({ apiKey });
      // AI SDK v6: use .textEmbeddingModel() for embeddings
      return (client as any).textEmbeddingModel
        ? (client as any).textEmbeddingModel(modelId)
        : (client as any).embedding(modelId);
    }
    case 'native-google': {
      const apiKey = requireAuth(auth, recipe, 'embedding');
      const client = createGoogleGenerativeAI({ apiKey });
      return (client as any).textEmbeddingModel
        ? (client as any).textEmbeddingModel(modelId)
        : (client as any).embedding(modelId);
    }
    case 'native-anthropic':
      throw new AIConfigError(
        `Anthropic has no embedding model. Use openai or google for embeddings.`,
      );
    case 'openai-compatible': {
      const baseUrl = cfg.base_urls?.[recipe.id] ?? recipe.base_url_default;
      if (!baseUrl) throw new AIConfigError(
        `${recipe.name} requires a base URL.`,
        recipe.setup_hint,
      );
      // For openai-compatible, auth is optional (ollama local) but pass a dummy key if unauthenticated.
      const apiKey = auth.source === 'unauthenticated'
        ? 'unauthenticated'
        : requireAuth(auth, recipe, 'embedding');
      const client = createOpenAICompatible({
        name: recipe.id,
        baseURL: baseUrl,
        apiKey: apiKey ?? 'unauthenticated',
      });
      return client.textEmbeddingModel(modelId);
    }
    default:
      throw new AIConfigError(`Unknown implementation: ${(recipe as any).implementation}`);
  }
}

/** Embed many texts. Truncates to 8000 chars. Throws AIConfigError or AITransientError. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!texts || texts.length === 0) return [];

  const cfg = requireConfig();
  const { model, recipe, modelId } = await resolveEmbeddingProvider(getEmbeddingModel());
  const truncated = texts.map(t => (t ?? '').slice(0, MAX_CHARS));

  try {
    const result = await embedMany({
      model,
      values: truncated,
      providerOptions: dimsProviderOptions(recipe.implementation, modelId, cfg.embedding_dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS),
    });

    // Verify dims match expectation; mismatch = likely misconfigured provider options.
    const expected = cfg.embedding_dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    const first = result.embeddings?.[0];
    if (first && Array.isArray(first) && first.length !== expected) {
      throw new AIConfigError(
        `Embedding dim mismatch: model ${modelId} returned ${first.length} but schema expects ${expected}.`,
        `Run \`gbrain migrate --embedding-model ${getEmbeddingModel()} --embedding-dimensions ${first.length}\` or change models.`,
      );
    }

    return result.embeddings.map((e: number[]) => new Float32Array(e));
  } catch (err) {
    throw normalizeAIError(err, `embed(${recipe.id}:${modelId})`);
  }
}

/** Embed one text (convenience wrapper). */
export async function embedOne(text: string): Promise<Float32Array> {
  const [v] = await embed([text]);
  return v;
}

// ---- Expansion ----

async function resolveExpansionProvider(modelStr: string): Promise<{ model: any; recipe: Recipe; modelId: string }> {
  const { parsed, recipe } = resolveRecipe(modelStr);
  assertTouchpoint(recipe, 'expansion', parsed.modelId);
  const cfg = requireConfig();

  const cacheKey = `exp:${recipe.id}:${parsed.modelId}:${cfg.base_urls?.[recipe.id] ?? ''}`;
  const cached = _modelCache.get(cacheKey);
  if (cached) return { model: cached, recipe, modelId: parsed.modelId };

  const model = instantiateExpansion(recipe, parsed.modelId, cfg);
  _modelCache.set(cacheKey, model);
  return { model, recipe, modelId: parsed.modelId };
}

function instantiateExpansion(recipe: Recipe, modelId: string, cfg: AIGatewayConfig): any {
  const auth = resolveProviderAuth(recipe, cfg);
  switch (recipe.implementation) {
    case 'native-openai': {
      const apiKey = requireAuth(auth, recipe, 'expansion');
      return createOpenAI({ apiKey }).languageModel(modelId);
    }
    case 'native-google': {
      const apiKey = requireAuth(auth, recipe, 'expansion');
      return createGoogleGenerativeAI({ apiKey }).languageModel(modelId);
    }
    case 'native-anthropic': {
      const apiKey = requireAuth(auth, recipe, 'expansion');
      return createAnthropic({ apiKey }).languageModel(modelId);
    }
    case 'openai-compatible': {
      const baseUrl = cfg.base_urls?.[recipe.id] ?? recipe.base_url_default;
      if (!baseUrl) throw new AIConfigError(`${recipe.name} requires a base URL.`, recipe.setup_hint);
      const apiKey = auth.source === 'unauthenticated'
        ? 'unauthenticated'
        : requireAuth(auth, recipe, 'expansion');
      return createOpenAICompatible({
        name: recipe.id,
        baseURL: baseUrl,
        apiKey: apiKey ?? 'unauthenticated',
      }).languageModel(modelId);
    }
  }
}

const ExpansionSchema = z.object({
  queries: z.array(z.string()).min(1).max(5),
});

/**
 * Expand a search query into up to 4 related queries.
 * Returns the original query PLUS expansions. On failure, returns just the original.
 * Caller is responsible for sanitizing the query (prompt-injection boundary stays in expansion.ts).
 */
export async function expand(query: string): Promise<string[]> {
  if (!query || !query.trim()) return [query];
  if (!isAvailable('expansion')) return [query];

  try {
    const { model, recipe, modelId } = await resolveExpansionProvider(getExpansionModel());
    const result = await generateObject({
      model,
      schema: ExpansionSchema,
      prompt: [
        'Rewrite the search query below into 3-4 different, related queries that would help find relevant documents.',
        'Return ONLY the JSON object. Do NOT include the original query in the result.',
        'Each rewrite should emphasize different aspects, synonyms, or framings.',
        '',
        `Query: ${query}`,
      ].join('\n'),
    });

    const expansions = result.object?.queries ?? [];
    // Deduplicate + include the original query
    const seen = new Set<string>();
    const all = [query, ...expansions].filter(q => {
      const k = q.toLowerCase().trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return !!q.trim();
    });
    return all;
  } catch (err) {
    // Expansion is best-effort: on failure, fall back to the original query alone.
    const normalized = normalizeAIError(err, 'expand');
    if (normalized instanceof AIConfigError) {
      console.warn(`[ai.gateway] expansion disabled: ${normalized.message}`);
    }
    return [query];
  }
}

// ---- Future touchpoint stubs ----

class NotMigratedYet extends AIConfigError {
  constructor(touchpoint: string) {
    super(`${touchpoint} has not been migrated to the gateway yet.`);
    this.name = 'NotMigratedYet';
  }
}

export async function chunk(): Promise<never> { throw new NotMigratedYet('chunking'); }
export async function transcribe(): Promise<never> { throw new NotMigratedYet('transcription'); }
export async function enrich(): Promise<never> { throw new NotMigratedYet('enrichment'); }
export async function improve(): Promise<never> { throw new NotMigratedYet('improve'); }
