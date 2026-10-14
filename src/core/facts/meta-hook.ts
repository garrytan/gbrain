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
import type { BrainEngine } from './../engine.ts';
import { effectiveConfidence } from './decay.ts';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TOP_K = 10;

interface CacheEntry {
  engine: WeakRef<BrainEngine>;
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
  if (name === 'recall' || name === 'extract_facts' || name === 'forget_fact' || name === 'forget') return undefined;

  const sourceId = ctx.sourceId ?? 'default';
  const sessionId = (ctx as { source_session?: string }).source_session
    ?? null;
  const allowListHash = hashAllowList(ctx.takesHoldersAllowList);
  const cacheKey = `${sourceId}::${sessionId ?? '_'}::${ctx.remote === false ? 'local' : 'remote'}::${allowListHash}`;

  const ttl = Math.max(1000, opts.ttlMs ?? DEFAULT_TTL_MS);
  const topK = Math.max(1, Math.min(opts.topK ?? DEFAULT_TOP_K, 25));

  // Cache hit?
  const cached = _cache.get(cacheKey);
  if (cached && cached.engine.deref() === ctx.engine && cached.expiresAt > Date.now()) {
    const facts = (cached.payload?.brain_hot_memory as { facts?: Array<{ id: number; fact: string }> } | undefined)?.facts ?? [];
    if (!facts.length) return cached.payload;
    const current = await ctx.engine.executeRaw<{ id: number; fact: string }>(`SELECT f.id,f.fact FROM facts f JOIN sources s ON s.id=f.source_id AND NOT s.archived
      WHERE f.source_id=$1 AND f.id=ANY($2::bigint[]) AND f.expired_at IS NULL
        AND (f.valid_until IS NULL OR f.valid_until>now()) AND ($3::boolean OR f.visibility='world')`, [sourceId,facts.map(fact=>fact.id),ctx.remote===false]);
    if (current.length===facts.length && facts.every(fact=>current.some(row=>Number(row.id)===Number(fact.id)&&row.fact===fact.fact))) return cached.payload;
    _cache.delete(cacheKey);
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
    _cache.set(cacheKey, { engine: new WeakRef(ctx.engine), expiresAt: Date.now() + ttl, payload: undefined });
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
        // v0.31.2: surface notability so connected agents can filter or
        // weight HIGH-tier facts in their context budget.
        notability: r.notability,
        entity_slug: r.entity_slug,
        valid_from: r.valid_from.toISOString(),
        confidence: Number(effectiveConfidence(r, now).toFixed(3)),
      })),
    },
  };
  const expiry=Math.min(Date.now()+ttl,...rows.map(r=>r.valid_until?new Date(r.valid_until).getTime():Infinity));
  _cache.set(cacheKey, { engine: new WeakRef(ctx.engine), expiresAt: expiry, payload });
  return payload;
}

/** Invalidate the cache for a (source_id, session_id) pair after extraction. */
export function bumpHotMemoryCache(sourceId: string, sessionId?: string | null): void {
  // Walk the cache and prune any entry matching this source+session prefix
  // (regardless of allow-list hash). Visitors with different visibility
  // tiers all get fresh data on next read.
  const prefix = sessionId === undefined ? `${sourceId}::` : `${sourceId}::${sessionId ?? '_'}::`;
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
