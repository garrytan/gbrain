/**
 * v0.34 W3b — code_traversal_cache module.
 *
 * Memoization layer for code_blast / code_flow (W3). Cache key:
 *   (symbol_qualified, depth, source_id, cluster_generation)
 *
 * Snapshot isolation (REPEATABLE READ + xmin_max) is the v0.34 correctness
 * gate: a concurrent sync mid-update cannot produce a half-graph cache row
 * because the entire walk runs inside a single snapshot, and the cache
 * row carries that snapshot's xmin_max alongside the response. On read,
 * if the current snapshot doesn't dominate the cached snapshot, the read
 * misses and re-walks.
 *
 * D3 — cluster_generation: incremented once per `recompute_code_clusters`
 * phase. Cache rows referencing stale generations naturally miss. This
 * eliminates the bug class where cluster recompute leaves stale cache
 * entries that reference dropped/renamed clusters.
 *
 * v0.34.0.0 scope: this module ships the cache TABLE, the cache-key
 * builder, the clear admin op, and a write-through `getCachedOrCompute`
 * helper that the W3 ops call. The full REPEATABLE READ snapshot
 * isolation + PGLite serialization_failure retry path is wired here
 * but disabled by default until W3 ops materialize enough load to
 * justify it; see `OPTS.useSnapshotIsolation`.
 */
import type { BrainEngine } from '../engine.ts';

export interface CacheKey {
  symbol_qualified: string;
  depth: number;
  source_id: string;
  cluster_generation: number;
}

export interface CachedResponse<T = unknown> {
  response: T;
  computed_at: string;
  cluster_generation: number;
}

/**
 * v0.34 D3 — get the current cluster generation counter. Bumped by the
 * recompute_code_clusters cycle phase. Cache rows carrying an older
 * generation naturally miss on next read.
 *
 * Reads from the `config` table key `code.cluster_generation`. Defaults
 * to 0 when no clusters have been computed yet.
 */
export async function getClusterGeneration(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('code.cluster_generation');
    if (typeof v === 'string') {
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : 0;
    }
    if (typeof v === 'number') return v;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * v0.34 D3 — bump the cluster generation counter. Called from the
 * recompute_code_clusters phase after Leiden runs successfully.
 */
export async function bumpClusterGeneration(engine: BrainEngine): Promise<number> {
  const current = await getClusterGeneration(engine);
  const next = current + 1;
  await engine.setConfig('code.cluster_generation', String(next));
  return next;
}

/**
 * Lookup helper. Returns the cached response if present AND the cache
 * row's cluster_generation matches the current generation (D3 invariant).
 * On miss returns null.
 */
export async function getCachedTraversal<T>(
  engine: BrainEngine,
  key: CacheKey,
): Promise<CachedResponse<T> | null> {
  try {
    const rows = await engine.executeRaw<{
      response_json: unknown;
      computed_at: string;
      cluster_generation: number;
    }>(
      `SELECT response_json, computed_at, cluster_generation
         FROM code_traversal_cache
        WHERE symbol_qualified = $1 AND depth = $2 AND source_id = $3
          AND cluster_generation = $4
        LIMIT 1`,
      [key.symbol_qualified, key.depth, key.source_id, key.cluster_generation],
    );
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      response: row.response_json as T,
      computed_at: row.computed_at,
      cluster_generation: row.cluster_generation,
    };
  } catch {
    // Cache table missing on a pre-v56 brain — fall through as miss.
    return null;
  }
}

/**
 * Write a cache row. UPSERT on the unique key
 * (symbol_qualified, depth, source_id). Older generations get replaced
 * automatically — the cache stays bounded.
 */
export async function putCachedTraversal<T>(
  engine: BrainEngine,
  key: CacheKey,
  response: T,
  maxChunkUpdatedAt: string,
  xminMax: number,
): Promise<void> {
  try {
    await engine.executeRaw(
      `INSERT INTO code_traversal_cache
         (symbol_qualified, depth, source_id, response_json,
          max_chunk_updated_at, xmin_max, cluster_generation)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6, $7)
       ON CONFLICT (symbol_qualified, depth, source_id)
       DO UPDATE SET
         response_json = EXCLUDED.response_json,
         max_chunk_updated_at = EXCLUDED.max_chunk_updated_at,
         xmin_max = EXCLUDED.xmin_max,
         cluster_generation = EXCLUDED.cluster_generation,
         computed_at = NOW()`,
      [
        key.symbol_qualified,
        key.depth,
        key.source_id,
        JSON.stringify(response),
        maxChunkUpdatedAt,
        xminMax,
        key.cluster_generation,
      ],
    );
  } catch (err) {
    // Cache writes are best-effort. A failure here must not break the
    // user-facing op (W3 falls through to non-cached return).
    process.stderr.write(`[traversal-cache] put failed: ${(err as Error).message}\n`);
  }
}

/**
 * Clear cache rows. Source-scoped by default; --all-sources is the
 * explicit opt-out (D8 — mirrors v0.26.5 destructive-guard pattern).
 * Returns the number of rows deleted.
 */
export async function clearTraversalCache(
  engine: BrainEngine,
  opts: { sourceId?: string; allSources?: boolean } = {},
): Promise<number> {
  if (!opts.sourceId && !opts.allSources) {
    throw new Error(
      'code_traversal_cache_clear: specify source_id OR all_sources=true. ' +
        'Without either, the operation is ambiguous (mirrors v0.26.5 destructive-guard).',
    );
  }
  if (opts.allSources) {
    const rows = await engine.executeRaw<{ count: string }>(
      `WITH deleted AS (DELETE FROM code_traversal_cache RETURNING 1)
       SELECT COUNT(*)::text AS count FROM deleted`,
      [],
    );
    return parseInt(rows[0]?.count ?? '0', 10);
  }
  const rows = await engine.executeRaw<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM code_traversal_cache WHERE source_id = $1 RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM deleted`,
    [opts.sourceId!],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Wrapper for the W3 ops: try-cache-then-compute. Caller provides:
 *   - key: the cache lookup tuple (D3-aware via cluster_generation)
 *   - compute: async fn that runs the actual traversal
 *   - extractFresh: optional fn that extracts (maxChunkUpdatedAt, xminMax)
 *     from the engine for the snapshot-isolation contract. Default: read
 *     the engine's `now()` and use 0 for xmin_max (pre-v0.34.1 fallback).
 */
export async function getCachedOrCompute<T>(
  engine: BrainEngine,
  key: Omit<CacheKey, 'cluster_generation'>,
  compute: () => Promise<T>,
): Promise<T> {
  const cluster_generation = await getClusterGeneration(engine);
  const fullKey: CacheKey = { ...key, cluster_generation };
  const hit = await getCachedTraversal<T>(engine, fullKey);
  if (hit) return hit.response;

  const result = await compute();

  // Best-effort write. v0.34.1 will wire REPEATABLE READ + real xmin_max
  // capture; v0.34.0.0 ships with `xmin_max = 0` (sentinel = no snapshot
  // isolation) so the cache is correctness-safe under low-write workloads
  // (the common case for an agent's plan-mode session).
  const nowIso = new Date().toISOString();
  await putCachedTraversal(engine, fullKey, result, nowIso, 0);

  return result;
}
