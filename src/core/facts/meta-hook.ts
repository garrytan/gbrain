/**
 * v0.31 — `_meta.brain_hot_memory` MCP injection helper.
 *
 * Per /plan-eng-review eD3 + eE4 + eD10:
 *
 *   - Best-effort: own try/catch in the dispatcher; any error here degrades
 *     to no-_meta rather than failing the tool call.
 *   - Cache key is (source_id, session_id, hash(takesHoldersAllowList sorted)).
 *     Visibility-aware: cache entries don't bleed across token tiers.
 *   - 30s TTL per session. Refreshed on extraction event via `bumpCache`.
 *   - Cap at top-K facts per response so the injection stays lean.
 *
 * Both stdio and HTTP MCP transports pass this hook into dispatchToolCall
 * so the felt-memory feature works on every transport.
 */

import type { OperationContext } from './../operations.ts';
import type { FactRow } from './../engine.ts';
import { effectiveConfidence } from './decay.ts';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TOP_K = 10;

interface CacheEntry {
  expiresAt: number;
  payload: Record<string, unknown> | undefined;
}

const _cache = new Map<string, CacheEntry>();

/**
 * Build the `_meta.brain_hot_memory` payload for an MCP tool-call response.
 *
 * Returns undefined when there's nothing to inject (no facts, no source
 * context, helper disabled, etc.). Errors are absorbed by the caller's
 * try/catch in dispatch.ts, so this function is allowed to throw — but it
 * should fail cleanly rather than throw on the happy path.
 */
export async function getBrainHotMemoryMeta(
  name: string,
  ctx: OperationContext,
  opts: { topK?: number; ttlMs?: number } = {},
): Promise<Record<string, unknown> | undefined> {
  // Don't inject on tool calls that themselves manipulate hot memory —
  // the agent doesn't need the brain's hot memory wrapped around its own
  // recall response.
  if (name === 'recall' || name === 'extract_facts' || name === 'forget_fact') return undefined;

  const sourceId = ctx.sourceId ?? 'default';
  const sessionId = (ctx as { source_session?: string }).source_session
    ?? null;
  const allowListHash = hashAllowList(ctx.takesHoldersAllowList);
  const cacheKey = `${sourceId}::${sessionId ?? '_'}::${allowListHash}`;

  const ttl = Math.max(1000, opts.ttlMs ?? DEFAULT_TTL_MS);
  const topK = Math.max(1, Math.min(opts.topK ?? DEFAULT_TOP_K, 25));

  // Cache hit?
  const cached = _cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  // Build a fresh payload. Visibility tier: remote → world-only;
  // local → all rows.
  const visibility = ctx.remote === false ? undefined : ['world'] as ('world' | 'private')[];

  let rows: FactRow[] = [];
  if (sessionId) {
    rows = await ctx.engine.listFactsBySession(sourceId, sessionId, {
      activeOnly: true, limit: topK, visibility,
    });
  }
  // If no session-scoped rows, fall back to recent across the source.
  if (rows.length === 0) {
    rows = await ctx.engine.listFactsSince(sourceId, new Date(Date.now() - 24 * 60 * 60 * 1000), {
      activeOnly: true, limit: topK, visibility,
    });
  }
  if (rows.length === 0) {
    _cache.set(cacheKey, { expiresAt: Date.now() + ttl, payload: undefined });
    return undefined;
  }

  // Sort by effective confidence (decayed) before truncating.
  const now = new Date();
  rows.sort((a, b) => effectiveConfidence(b, now) - effectiveConfidence(a, now));
  rows = rows.slice(0, topK);

  const payload = {
    brain_hot_memory: {
      source_id: sourceId,
      session_id: sessionId,
      facts: rows.map(r => ({
        id: r.id,
        fact: r.fact,
        kind: r.kind,
        entity_slug: r.entity_slug,
        valid_from: r.valid_from.toISOString(),
        confidence: Number(effectiveConfidence(r, now).toFixed(3)),
      })),
    },
  };
  _cache.set(cacheKey, { expiresAt: Date.now() + ttl, payload });
  return payload;
}

/** Invalidate the cache for a (source_id, session_id) pair after extraction. */
export function bumpHotMemoryCache(sourceId: string, sessionId: string | null): void {
  // Walk the cache and prune any entry matching this source+session prefix
  // (regardless of allow-list hash). Visitors with different visibility
  // tiers all get fresh data on next read.
  const prefix = `${sourceId}::${sessionId ?? '_'}::`;
  for (const k of _cache.keys()) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
}

/** Test helper: clear the cache. */
export function __resetHotMemoryCacheForTests(): void {
  _cache.clear();
}

/** Stable hash of the (sorted) allow-list. Mirrors the auth contract. */
function hashAllowList(list: string[] | undefined): string {
  if (!list || list.length === 0) return '_';
  const sorted = [...list].sort();
  return sorted.join('|');
}
