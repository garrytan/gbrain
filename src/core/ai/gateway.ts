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

import { embed as aiEmbed, embedMany, generateObject, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';

import type {
  AIGatewayConfig,
  Recipe,
  TouchpointKind,
} from './types.ts';
import { resolveRecipe, assertTouchpoint } from './model-resolver.ts';
import { dimsProviderOptions } from './dims.ts';
import { AIConfigError, AITransientError, normalizeAIError } from './errors.ts';

const MAX_CHARS = 8000;
const DEFAULT_EMBEDDING_MODEL = 'openai:text-embedding-3-large';
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
const DEFAULT_EXPANSION_MODEL = 'anthropic:claude-haiku-4-5-20251001';
const DEFAULT_CHAT_MODEL = 'anthropic:claude-sonnet-4-6-20250929';

let _config: AIGatewayConfig | null = null;
const _modelCache = new Map<string, any>();

/** Configure the gateway. Called by cli.ts#connectEngine. Clears cached models. */
export function configureGateway(config: AIGatewayConfig): void {
  _config = {
    embedding_model: config.embedding_model ?? DEFAULT_EMBEDDING_MODEL,
    embedding_dimensions: config.embedding_dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
    expansion_model: config.expansion_model ?? DEFAULT_EXPANSION_MODEL,
    chat_model: config.chat_model ?? DEFAULT_CHAT_MODEL,
    chat_fallback_chain: config.chat_fallback_chain,
    base_urls: config.base_urls,
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

export function getChatModel(): string {
  return requireConfig().chat_model ?? DEFAULT_CHAT_MODEL;
}

export function getChatFallbackChain(): string[] {
  return requireConfig().chat_fallback_chain ?? [];
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
        : touchpoint === 'chat'
        ? getChatModel()
        : null;
    if (!modelStr) return false;
    const { recipe } = resolveRecipe(modelStr);

    // Recipe must actually support the requested touchpoint.
    // Anthropic declares only expansion + chat (no embedding model); requesting
    // embedding from an anthropic-configured brain is unavailable regardless of auth.
    const touchpointConfig = recipe.touchpoints[touchpoint as 'embedding' | 'expansion' | 'chat'];
    if (!touchpointConfig) return false;
    // Openai-compat recipes with empty models list (e.g. litellm template) require user-provided model
    if (Array.isArray(touchpointConfig.models) && touchpointConfig.models.length === 0 && recipe.id === 'litellm') return false;

    // For openai-compatible without auth requirements (Ollama local), treat as always-available.
    const required = recipe.auth_env?.required ?? [];
    if (required.length === 0) return true;
    return required.every(k => !!_config!.env[k]);
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

function instantiateEmbedding(recipe: Recipe, modelId: string, cfg: AIGatewayConfig): any {
  switch (recipe.implementation) {
    case 'native-openai': {
      const apiKey = cfg.env.OPENAI_API_KEY;
      if (!apiKey) throw new AIConfigError(
        `OpenAI embedding requires OPENAI_API_KEY.`,
        recipe.setup_hint,
      );
      const client = createOpenAI({ apiKey });
      // AI SDK v6: use .textEmbeddingModel() for embeddings
      return (client as any).textEmbeddingModel
        ? (client as any).textEmbeddingModel(modelId)
        : (client as any).embedding(modelId);
    }
    case 'native-google': {
      const apiKey = cfg.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) throw new AIConfigError(
        `Google embedding requires GOOGLE_GENERATIVE_AI_API_KEY.`,
        recipe.setup_hint,
      );
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
      const apiKey = recipe.auth_env?.required[0]
        ? cfg.env[recipe.auth_env.required[0]]
        : (cfg.env[`${recipe.id.toUpperCase()}_API_KEY`] ?? 'unauthenticated');
      if (recipe.auth_env?.required.length && !apiKey) {
        throw new AIConfigError(
          `${recipe.name} requires ${recipe.auth_env.required[0]}.`,
          recipe.setup_hint,
        );
      }
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
  switch (recipe.implementation) {
    case 'native-openai': {
      const apiKey = cfg.env.OPENAI_API_KEY;
      if (!apiKey) throw new AIConfigError(`OpenAI expansion requires OPENAI_API_KEY.`, recipe.setup_hint);
      return createOpenAI({ apiKey }).languageModel(modelId);
    }
    case 'native-google': {
      const apiKey = cfg.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) throw new AIConfigError(`Google expansion requires GOOGLE_GENERATIVE_AI_API_KEY.`, recipe.setup_hint);
      return createGoogleGenerativeAI({ apiKey }).languageModel(modelId);
    }
    case 'native-anthropic': {
      const apiKey = cfg.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new AIConfigError(`Anthropic expansion requires ANTHROPIC_API_KEY.`, recipe.setup_hint);
      return createAnthropic({ apiKey }).languageModel(modelId);
    }
    case 'openai-compatible': {
      const baseUrl = cfg.base_urls?.[recipe.id] ?? recipe.base_url_default;
      if (!baseUrl) throw new AIConfigError(`${recipe.name} requires a base URL.`, recipe.setup_hint);
      const apiKey = recipe.auth_env?.required[0]
        ? cfg.env[recipe.auth_env.required[0]]
        : 'unauthenticated';
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

// ---- Chat (commit 1) ----

/**
 * Provider-neutral message shape stored in subagent persistence (commit 2a).
 * Vercel AI SDK's `generateText` accepts this directly via its `messages`
 * parameter; tool-use blocks are normalized across providers.
 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: unknown; isError?: boolean };

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatBlock[];
}

export interface ChatToolDef {
  name: string;
  description: string;
  /** JSON Schema for tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ChatResult {
  /** Final text content concatenated from text blocks. */
  text: string;
  /** Raw assistant response blocks (text + tool-call entries) for persistence. */
  blocks: ChatBlock[];
  /** Reason the model stopped. Provider-neutral mapping of stop_reason / finish_reason. */
  stopReason: 'end' | 'tool_calls' | 'length' | 'refusal' | 'content_filter' | 'other';
  /** Provider-neutral usage. cache_* are present only when the active provider returned them (Anthropic). */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  };
  /** "provider:modelId" string of the model that actually answered. */
  model: string;
  /** Recipe id for the answering provider. */
  providerId: string;
  /** Raw provider metadata (Anthropic-specific cache fields, OpenAI finish_reason, etc.) for downstream callers that need it. */
  providerMetadata?: Record<string, any>;
}

export interface ChatOpts {
  /** "provider:modelId" — defaults to config.chat_model. */
  model?: string;
  /** System prompt. */
  system?: string;
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  maxTokens?: number;
  abortSignal?: AbortSignal;
  /**
   * Anthropic-specific: cache the system prompt + last tool def. Silently
   * ignored on providers without `supports_prompt_cache`.
   */
  cacheSystem?: boolean;
}

async function resolveChatProvider(modelStr: string): Promise<{ model: any; recipe: Recipe; modelId: string }> {
  const { parsed, recipe } = resolveRecipe(modelStr);
  assertTouchpoint(recipe, 'chat', parsed.modelId);
  const cfg = requireConfig();

  const cacheKey = `chat:${recipe.id}:${parsed.modelId}:${cfg.base_urls?.[recipe.id] ?? ''}`;
  const cached = _modelCache.get(cacheKey);
  if (cached) return { model: cached, recipe, modelId: parsed.modelId };

  const model = instantiateChat(recipe, parsed.modelId, cfg);
  _modelCache.set(cacheKey, model);
  return { model, recipe, modelId: parsed.modelId };
}

function instantiateChat(recipe: Recipe, modelId: string, cfg: AIGatewayConfig): any {
  switch (recipe.implementation) {
    case 'native-openai': {
      const apiKey = cfg.env.OPENAI_API_KEY;
      if (!apiKey) throw new AIConfigError(`OpenAI chat requires OPENAI_API_KEY.`, recipe.setup_hint);
      return createOpenAI({ apiKey }).languageModel(modelId);
    }
    case 'native-google': {
      const apiKey = cfg.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey) throw new AIConfigError(`Google chat requires GOOGLE_GENERATIVE_AI_API_KEY.`, recipe.setup_hint);
      return createGoogleGenerativeAI({ apiKey }).languageModel(modelId);
    }
    case 'native-anthropic': {
      const apiKey = cfg.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new AIConfigError(`Anthropic chat requires ANTHROPIC_API_KEY.`, recipe.setup_hint);
      return createAnthropic({ apiKey }).languageModel(modelId);
    }
    case 'openai-compatible': {
      const baseUrl = cfg.base_urls?.[recipe.id] ?? recipe.base_url_default;
      if (!baseUrl) throw new AIConfigError(`${recipe.name} requires a base URL.`, recipe.setup_hint);
      const required = recipe.auth_env?.required ?? [];
      const apiKey = required[0] ? cfg.env[required[0]] : 'unauthenticated';
      if (required.length > 0 && !apiKey) {
        throw new AIConfigError(`${recipe.name} requires ${required[0]}.`, recipe.setup_hint);
      }
      return createOpenAICompatible({
        name: recipe.id,
        baseURL: baseUrl,
        apiKey: apiKey ?? 'unauthenticated',
      }).languageModel(modelId);
    }
    default:
      throw new AIConfigError(`Unknown implementation: ${(recipe as any).implementation}`);
  }
}

/**
 * Map AI SDK's `finish_reason` (and provider-specific signals) to a provider-
 * neutral `stopReason`. This is the structural-signal layer that
 * `chatWithFallback` (commit 3) consults BEFORE any regex heuristic (per D8).
 */
function mapStopReason(
  finishReason: string | undefined,
  providerMetadata: Record<string, any> | undefined,
): ChatResult['stopReason'] {
  // Anthropic: `stop_reason: 'refusal'` lands in providerMetadata.anthropic.
  const anthropicStop = providerMetadata?.anthropic?.stopReason ?? providerMetadata?.anthropic?.stop_reason;
  if (anthropicStop === 'refusal') return 'refusal';
  // OpenAI: `finish_reason: 'content_filter'`.
  if (finishReason === 'content-filter' || finishReason === 'content_filter') return 'content_filter';
  if (finishReason === 'tool-calls' || finishReason === 'tool_calls') return 'tool_calls';
  if (finishReason === 'length' || finishReason === 'max-tokens') return 'length';
  if (finishReason === 'stop' || finishReason === 'end' || finishReason === 'end-turn') return 'end';
  return 'other';
}

/**
 * Run one chat completion turn. Provider-neutral wrapper over Vercel AI SDK's
 * `generateText`. Tool-use blocks are normalized; cache_control markers are
 * applied only on Anthropic when `cacheSystem: true`.
 *
 * Crash-resumable replay is the caller's responsibility (subagent.ts persists
 * blocks via the provider-neutral schema landing in commit 2a).
 */
export async function chat(opts: ChatOpts): Promise<ChatResult> {
  const modelStr = opts.model ?? getChatModel();
  const { model, recipe, modelId } = await resolveChatProvider(modelStr);

  const supportsCache = recipe.touchpoints.chat?.supports_prompt_cache === true;
  const useCache = !!opts.cacheSystem && supportsCache;

  // Build messages. Anthropic prompt-cache markers ride on system + last tool
  // via providerOptions; the AI SDK accepts the system as a string for
  // generateText, so cache markers go through providerOptions.anthropic.
  const tools = (opts.tools ?? []).reduce((acc, t) => {
    acc[t.name] = {
      description: t.description,
      inputSchema: { jsonSchema: t.inputSchema } as any,
    };
    return acc;
  }, {} as Record<string, any>);

  const providerOptions: Record<string, any> = {};
  if (useCache) {
    providerOptions.anthropic = { cacheControl: { type: 'ephemeral' } };
  }

  try {
    const result = await generateText({
      model,
      system: opts.system,
      messages: opts.messages as any,
      tools: opts.tools && opts.tools.length > 0 ? tools : undefined,
      maxOutputTokens: opts.maxTokens ?? 4096,
      abortSignal: opts.abortSignal,
      providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
    });

    // Normalize blocks. Vercel SDK gives us `result.content` (an array of typed
    // parts) for v6+; fall back to text + toolCalls for older shapes.
    const blocks: ChatBlock[] = [];
    const rawContent: any[] = (result as any).content ?? [];
    if (Array.isArray(rawContent) && rawContent.length > 0) {
      for (const part of rawContent) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
        else if (part.type === 'tool-call') {
          blocks.push({
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input ?? part.args,
          });
        }
      }
    } else {
      // Fallback shape for SDK versions exposing flat .text and .toolCalls.
      if (typeof (result as any).text === 'string' && (result as any).text.length > 0) {
        blocks.push({ type: 'text', text: (result as any).text });
      }
      for (const tc of (result as any).toolCalls ?? []) {
        blocks.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input ?? tc.args,
        });
      }
    }

    const usage = (result as any).usage ?? {};
    const providerMetadata = (result as any).providerMetadata as Record<string, any> | undefined;
    const anthropicCache = providerMetadata?.anthropic ?? {};

    return {
      text: blocks.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join(''),
      blocks,
      stopReason: mapStopReason((result as any).finishReason, providerMetadata),
      usage: {
        input_tokens: Number(usage.inputTokens ?? usage.promptTokens ?? 0),
        output_tokens: Number(usage.outputTokens ?? usage.completionTokens ?? 0),
        cache_read_tokens: Number(anthropicCache.cacheReadInputTokens ?? anthropicCache.cache_read_input_tokens ?? 0),
        cache_creation_tokens: Number(anthropicCache.cacheCreationInputTokens ?? anthropicCache.cache_creation_input_tokens ?? 0),
      },
      model: `${recipe.id}:${modelId}`,
      providerId: recipe.id,
      providerMetadata,
    };
  } catch (err) {
    throw normalizeAIError(err, `chat(${recipe.id}:${modelId})`);
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
