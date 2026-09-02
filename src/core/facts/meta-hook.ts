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

/**
 * Hard bound on cache entries. The key folds caller-controlled
 * `_meta.session_id`, so without a bound a remote caller could grow the map
 * without limit by minting fresh session ids per call. On overflow the entry
 * with the OLDEST expiry is evicted (it dies soonest anyway; expiries are
 * near-uniform, clamped shorter only when a row's valid_until lands inside
 * the window).
 */
export const HOT_MEMORY_CACHE_MAX_ENTRIES = 1000;

interface CacheEntry {
  expiresAt: number;
  payload: Record<string, unknown> | undefined;
}

const _cache = new Map<string, CacheEntry>();

/** Bounded set: evict the oldest-expiry entry when inserting at capacity. */
function cacheSet(key: string, entry: CacheEntry): void {
  if (!_cache.has(key) && _cache.size >= HOT_MEMORY_CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestExpiry = Infinity;
    for (const [k, v] of _cache) {
      if (v.expiresAt < oldestExpiry) {
        oldestExpiry = v.expiresAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) _cache.delete(oldestKey);
  }
  _cache.set(key, entry);
}

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
  // CX2-11: session identity is the TYPED OperationContext.sessionId field,
  // set from MCP `_meta.session_id` at the dispatch boundary. The old ad-hoc
  // `source_session` read is kept as a fallback for legacy embedders, but no
  // shipped transport ever set it — without the typed field every caller
  // collapsed onto the null-session cache key.
  const sessionId = ctx.sessionId
    ?? (ctx as { source_session?: string }).source_session
    ?? null;
  const allowListHash = hashAllowList(ctx.takesHoldersAllowList);
  // v0.45.7 (ambient-recall adversarial review, P1): the visibility TIER is part
  // of the key. Without it, a trusted-local call (remote:false → all rows,
  // private included) warms the cache and a later remote/world-only call with
  // the same source+session+allowList is SERVED the private payload — a
  // cross-tier leak through the cache, not through the query.
  const tier = ctx.remote === false ? 'all' : 'world';
  // encodeCacheField (F5): source_id / session_id are caller-controlled and
  // may contain the '::' delimiter; percent-encode ':' so bumpHotMemoryCache's
  // split('::') can never mis-slice a component.
  // The ENGINE is part of the key: one process can serve multiple brains
  // (hosted multi-tenant, test shards, mounted brains), and two engines with
  // the same source id / tier / session must never share hot-memory payloads
  // — a cached entry from brain A served to brain B's caller is a cross-brain
  // fact leak through the cache, not through any query.
  const cacheKey = `${engineCacheField(ctx.engine)}::${encodeCacheField(sourceId)}::${tier}::${encodeCacheField(sessionId ?? '_')}::${allowListHash}`;

  const ttl = Math.max(1000, opts.ttlMs ?? DEFAULT_TTL_MS);
  const topK = Math.max(1, Math.min(opts.topK ?? DEFAULT_TOP_K, 25));

  // Cache hit?
  const cached = _cache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.payload;
    // Expired: evict BEFORE the rebuild. If the rebuild below throws (the
    // caller's try/catch absorbs it), the dead entry must not linger — with
    // remote-influencable keys, lingering corpses defeat the size bound.
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
    cacheSet(cacheKey, { expiresAt: Date.now() + ttl, payload: undefined });
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
        // v0.45.7 ambient recall: recording time, so delta's "new facts since my
        // last wake" filters on WHEN the fact was learned, not its semantic
        // validity date (a fact recorded today about last month is NEW).
        created_at: r.created_at.toISOString(),
        // #4206: provenance context (e.g. the source_slug extract_facts threaded
        // in) rides the pack/delta projections instead of being recall-only.
        context: r.context ?? null,
        confidence: Number(effectiveConfidence(r, now).toFixed(3)),
      })),
    },
  };
  // Read-time TTL honesty (adversarial review, this wave): a row whose
  // valid_until lands INSIDE the cache window would otherwise keep riding
  // the ambient channel for up to `ttl` past its expiry even though the
  // underlying reads now filter it — clamp this entry's cache deadline to
  // the earliest retained valid_until so the next call re-reads on time.
  let expiresAt = Date.now() + ttl;
  for (const r of rows) {
    const vu = r.valid_until?.getTime();
    if (vu !== undefined && Number.isFinite(vu) && vu < expiresAt) expiresAt = vu;
  }
  cacheSet(cacheKey, { expiresAt, payload });
  return payload;
}

/** Invalidate the cache for a (source_id, session_id) pair after extraction. */
export function bumpHotMemoryCache(sourceId: string, sessionId: string | null): void {
  // Walk the cache and prune any entry matching this source+session
  // regardless of visibility tier, allow-list hash, OR engine — key layout is
  // engine::encField(source)::tier::encField(session)::allowHash. Pruning
  // across engines is deliberate over-invalidation: a bump is a freshness
  // signal and a stale-drop on a sibling engine costs one rebuild, never a
  // leak. Components are ':'-encoded, so split('::') slices cleanly even
  // when the source/session id itself contains '::' (F5).
  const encSource = encodeCacheField(sourceId);
  const encSession = encodeCacheField(sessionId ?? '_');
  for (const k of _cache.keys()) {
    const parts = k.split('::');
    if (parts[1] === encSource && parts[3] === encSession) _cache.delete(k);
  }
}

// Engine identity for the cache key: a WeakMap-issued serial, so the key
// stays a flat string (the bounded Map + prefix pruning keep working) and a
// disconnected engine can be garbage-collected.
const ENGINE_KEYS = new WeakMap<object, string>();
let engineKeySeq = 0;
function engineCacheField(engine: object): string {
  let k = ENGINE_KEYS.get(engine);
  if (!k) {
    k = `e${++engineKeySeq}`;
    ENGINE_KEYS.set(engine, k);
  }
  return k;
}

/** Percent-encode ':' so a caller-controlled id can't inject the '::' key
 * delimiter (F5). Cheap, reversible, and keeps keys human-readable. */
function encodeCacheField(v: string): string {
  return v.replace(/:/g, '%3A');
}

/** Test helper: clear the cache. */
export function __resetHotMemoryCacheForTests(): void {
  _cache.clear();
}

/** Test helper: direct cache access (expiry mutation + size/eviction pins). */
export function __hotMemoryCacheForTests(): Map<string, { expiresAt: number; payload: Record<string, unknown> | undefined }> {
  return _cache;
}

/**
 * Stable hash of the (sorted) allow-list. Mirrors the auth contract.
 *
 * The allow-list affects cache IDENTITY only — the payload itself is filtered
 * by fact visibility (see the `visibility` tier above), never by the takes
 * allow-list. Keeping `[]` (explicit deny-all grant) distinct from undefined
 * (no grant) is insurance so a future allowlist-dependent payload is born
 * safe, not a claim that `[]` suppresses hot memory today.
 *
 * Encoding is collision-free: undefined maps to a token no JSON array can
 * produce, and every concrete list serializes via JSON.stringify. A bare
 * `sorted.join('|')` would have collided `['a|b']` with `['a','b']`, and bare
 * sentinels would have collided `['(empty)']` with `[]` — so a holder value
 * that happened to equal a sentinel could not share a cache bucket it
 * shouldn't.
 */
function hashAllowList(list: string[] | undefined): string {
  if (!list) return 'none';
  return JSON.stringify([...list].sort());
}
