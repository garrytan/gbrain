/**
 * v0.41.16.0 — Shared LLM base for conversation-parser polish + fallback.
 *
 * Per D6: polish and fallback share ~80% of code (provider probe,
 * content-hash cache, fail-open semantics, audit). Extract once;
 * both wrappers are thin (~30 LOC each).
 *
 * Per D15: BOTH polish AND fallback are opt-IN by default (privacy
 * posture for private chat logs). The wrappers check the relevant
 * config flag (`conversation_parser.llm_polish_enabled` /
 * `conversation_parser.llm_fallback_enabled`) before calling here.
 * This base does NOT check enabled flags; the wrappers do.
 *
 * Provider/key probing follows `makeJudgeClient` from
 * `src/core/cycle/synthesize.ts:734` — construction-time
 * `resolveRecipe` + Anthropic-key probe, returns `null` on
 * unavailable provider. Per-call calls fail-open: any error
 * (timeout, parse failure, transport error, AIConfigError mid-run)
 * returns null and the caller falls through to regex-only output.
 *
 * Cache: in-process Map keyed on
 *   `${call_shape}:${model_id}:${content_sha256}`
 * with DB-persistent fallback via the `conversation_parser_llm_cache`
 * table (migration v97). DB cache is best-effort; in-process hits
 * dominate during a single dream cycle.
 *
 * Test seam: callers pass `opts.chatTransport` to bypass the gateway
 * entirely. This is the canonical pattern (see longmemeval/extract.ts
 * `LLMClient` interface).
 */

import { createHash } from 'node:crypto';
import { chat as gatewayChat, type ChatOpts, type ChatResult } from '../ai/gateway.ts';
import { resolveRecipe } from '../ai/model-resolver.ts';
import { AIConfigError } from '../ai/errors.ts';
import { loadConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';

/**
 * Test-seam transport. Real callers pass undefined → `gatewayChat`.
 * Tests pass an in-memory stub.
 */
export type ChatTransport = (opts: ChatOpts) => Promise<ChatResult>;

export type CallShape = 'polish' | 'fallback';

/**
 * Per-process LLM result cache. Key:
 *   `${shape}:${model}:${sha256(content)}`
 *
 * Module-scope: lives across calls within ONE process. Cleared via
 * `_resetLlmCacheForTests` in tests.
 */
const llmCache: Map<string, unknown> = new Map();
let cacheHits = 0;
let cacheMisses = 0;

export interface LlmCacheStats {
  hits: number;
  misses: number;
  size: number;
}

export function getLlmCacheStats(): LlmCacheStats {
  return { hits: cacheHits, misses: cacheMisses, size: llmCache.size };
}

/** Test seam: clear cache + counters. Real code never calls this. */
export function _resetLlmCacheForTests(): void {
  llmCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/** Content-hash cache key. */
function cacheKey(shape: CallShape, modelId: string, content: string): string {
  const hash = createHash('sha256').update(content).digest('hex');
  return `${shape}:${modelId}:${hash}`;
}

/**
 * Anthropic-only key probe. Mirrors `hasAnthropicKey` in
 * `src/core/cycle/synthesize.ts:811` + `src/core/think/index.ts`.
 * Other providers' key checks happen lazily at `gatewayChat` time and
 * surface as AIConfigError, which the caller's try/catch absorbs.
 */
function hasAnthropicKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  try {
    const cfg = loadConfig();
    if (cfg?.anthropic_api_key) return true;
  } catch {
    // loadConfig may throw on first-run; treat as no key.
  }
  return false;
}

/**
 * Construction-time provider probe. Mirrors `makeJudgeClient`'s
 * "return null on unavailable" semantics. Caller short-circuits on
 * null without spending any tokens.
 *
 * Returns a normalized model id (`provider:model`) when available, or
 * null when:
 *   - Unknown provider id (resolveRecipe throws AIConfigError).
 *   - Anthropic provider with no key (env or config).
 */
export function probeLlmAvailability(modelStr: string): string | null {
  const normalized = modelStr.includes(':') ? modelStr : `anthropic:${modelStr}`;
  let providerId: string;
  try {
    const { parsed } = resolveRecipe(normalized);
    providerId = parsed.providerId;
  } catch (e) {
    if (e instanceof AIConfigError) return null;
    throw e;
  }
  if (providerId === 'anthropic' && !hasAnthropicKey()) return null;
  return normalized;
}

/**
 * Run an LLM call with content-hash caching + fail-open semantics.
 *
 * Generic over caller's expected output type. Caller passes a `parse`
 * function that decodes the LLM's text output into the typed shape.
 * If `parse` throws, we treat as fail-open and return null (NOT cache
 * the error — next call retries).
 *
 * Cache semantics:
 *   - In-process Map keyed on (shape, model, content_sha).
 *   - DB cache (table conversation_parser_llm_cache) checked when
 *     engine is provided and in-process misses. DB hits warm the
 *     in-process cache.
 *   - On parse success, value is cached BOTH in-process AND in DB.
 *
 * Fail-open paths (return null):
 *   - Provider unavailable (probeLlmAvailability returned null).
 *   - Transport throws (network, timeout, AIConfigError mid-run).
 *   - Parse throws or returns null.
 *
 * NEVER throws.
 */
export interface RunLlmCallOpts<TOutput> {
  shape: CallShape;
  modelStr: string;
  /**
   * The content the LLM will see. Used for cache key AND for the
   * prompt (caller composes the system + user messages from this).
   */
  content: string;
  /** System prompt for the LLM. */
  system: string;
  /** Per-call abort signal (optional). */
  signal?: AbortSignal;
  /** Max output tokens. Default 4000. */
  maxTokens?: number;
  /** Parse the LLM's text output into the typed shape. */
  parse: (text: string) => TOutput | null;
  /** Engine for DB cache (optional; in-process always works). */
  engine?: BrainEngine;
  /** Test seam: override the chat transport. */
  chatTransport?: ChatTransport;
}

export async function runLlmCall<TOutput>(
  opts: RunLlmCallOpts<TOutput>,
): Promise<TOutput | null> {
  const modelStr = probeLlmAvailability(opts.modelStr);
  if (modelStr === null) {
    // Once-per-process warn: future calls in this process won't pay
    // the probe cost again because each call's probe is cheap, but
    // the warn is annoying. We don't gate it here; the wrapper
    // callers may emit their own warn.
    return null;
  }

  const key = cacheKey(opts.shape, modelStr, opts.content);

  // Layer 1: in-process cache.
  if (llmCache.has(key)) {
    cacheHits++;
    return llmCache.get(key) as TOutput;
  }

  // Layer 2: DB cache.
  if (opts.engine) {
    try {
      const dbHit = await readDbCache<TOutput>(opts.engine, key);
      if (dbHit !== null) {
        cacheHits++;
        llmCache.set(key, dbHit);
        return dbHit;
      }
    } catch {
      // DB cache failures are silently fall-through; in-process work
      // still happens.
    }
  }

  cacheMisses++;

  // Make the call.
  const transport = opts.chatTransport ?? gatewayChat;
  let result: ChatResult;
  try {
    result = await transport({
      model: modelStr,
      system: opts.system,
      messages: [{ role: 'user', content: opts.content }],
      maxTokens: opts.maxTokens ?? 4000,
      abortSignal: opts.signal,
    });
  } catch {
    // Transport failure: fail-open.
    return null;
  }

  // Parse output.
  let parsed: TOutput | null = null;
  try {
    parsed = opts.parse(result.text);
  } catch {
    parsed = null;
  }
  if (parsed === null) return null;

  // Cache success in both layers.
  llmCache.set(key, parsed);
  if (opts.engine) {
    try {
      await writeDbCache(opts.engine, key, opts.shape, modelStr, parsed);
    } catch {
      // Best-effort.
    }
  }

  return parsed;
}

// ----------------------------------------------------------------
// DB cache (best-effort, table created in migration v97).
// ----------------------------------------------------------------

async function readDbCache<T>(engine: BrainEngine, key: string): Promise<T | null> {
  // Key is `${shape}:${model}:${content_sha}`; decompose for the
  // table's composite primary key.
  const [shape, model, contentSha] = splitCacheKey(key);
  if (!shape || !model || !contentSha) return null;
  const rows = await engine.executeRaw(
    `SELECT value_json FROM conversation_parser_llm_cache
       WHERE content_sha256 = $1 AND model_id = $2 AND call_shape = $3
       LIMIT 1`,
    [contentSha, model, shape],
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0] as { value_json: unknown };
  // Postgres returns JSONB as parsed object; PGLite returns same.
  // Defensively handle string-shaped rows from older DB writes (the
  // v0.12.0 double-encode bug class).
  if (typeof row.value_json === 'string') {
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }
  return row.value_json as T;
}

async function writeDbCache<T>(
  engine: BrainEngine,
  key: string,
  shape: CallShape,
  modelStr: string,
  value: T,
): Promise<void> {
  const [, , contentSha] = splitCacheKey(key);
  if (!contentSha) return;
  // executeRaw with positional binding for JSONB. Per the sql-query.ts
  // contract: object values passed via positional params reach the
  // wire as proper jsonb when cast.
  await engine.executeRaw(
    `INSERT INTO conversation_parser_llm_cache
       (content_sha256, model_id, call_shape, value_json)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (content_sha256, model_id, call_shape) DO NOTHING`,
    [contentSha, modelStr, shape, JSON.stringify(value)],
  );
}

function splitCacheKey(key: string): [string?, string?, string?] {
  // shape:model:sha — model can contain `:` (e.g. anthropic:claude-haiku),
  // so split at the FIRST and LAST colon.
  const firstColon = key.indexOf(':');
  const lastColon = key.lastIndexOf(':');
  if (firstColon < 0 || lastColon <= firstColon) return [];
  const shape = key.slice(0, firstColon);
  const model = key.slice(firstColon + 1, lastColon);
  const sha = key.slice(lastColon + 1);
  return [shape, model, sha];
}

/**
 * 4-strategy JSON repair (lifted from `eval/longmemeval/extract.ts:50`
 * for object-shaped output; the original was array-shaped). Caller's
 * `parse` function uses this for tolerant LLM-output decoding.
 *
 * Strategies:
 *   1. Strip ```json...``` fences if present, then JSON.parse.
 *   2. Direct JSON.parse.
 *   3. Find first {...} substring (or [...] if array=true) and parse.
 *   4. Return null.
 *
 * Adversarial input throws caught by caller's try/catch (parse returns
 * null upstream).
 */
export function parseLlmJson<T>(raw: string, opts: { array?: boolean } = {}): T | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  const cleaned = (fenceMatch ? fenceMatch[1] : raw).trim();
  try {
    const direct = JSON.parse(cleaned);
    if (opts.array && Array.isArray(direct)) return direct as T;
    if (!opts.array && direct !== null && typeof direct === 'object') return direct as T;
  } catch {
    // fall through
  }
  const pattern = opts.array ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = cleaned.match(pattern);
  if (match) {
    try {
      const second = JSON.parse(match[0]);
      if (opts.array && Array.isArray(second)) return second as T;
      if (!opts.array && second !== null && typeof second === 'object') return second as T;
    } catch {
      // fall through
    }
  }
  return null;
}
