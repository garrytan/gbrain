/**
 * Semantic Query Cache (v0.32.x — search-lite)
 *
 * Caches hybridSearch results keyed by query embedding similarity. On
 * each lookup the cache runs an HNSW cosine-distance probe against
 * stored query embeddings. If the closest cached query is within
 * `1 - similarity_threshold` cosine distance (default similarity
 * >= 0.92, distance < 0.08), we return the stored results instantly
 * — no keyword search, no vector search, no LLM expansion, no RRF, no
 * dedup. Otherwise we report a miss and let the caller run the real
 * search.
 *
 * Storage: the `query_cache` table (migration v51) with the same
 * embedding dim as `content_chunks`. Per-row TTL (default 3600 seconds).
 * Stale rows are skipped at read time and pruned by `gbrain cache prune`.
 *
 * Multi-source isolation: cache lookups scope by `source_id` so brain
 * A's "who is widget-ceo" cannot return brain B's cached results for
 * the same query.
 *
 * Edge cases:
 *   - No embedding available (no OPENAI key, embed failure): cache is
 *     skipped silently. Caller runs the normal pipeline.
 *   - Table missing (pre-v51 brain): every read swallows the error and
 *     reports a miss. No throw.
 *   - Cache disabled by config or by caller (`useCache: false`): the
 *     cache module is never called.
 *
 * Tested in test/query-cache.test.ts.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { SearchResult, HybridSearchMeta } from '../types.ts';

/** Default cosine similarity threshold for cache hits. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.92;
/** Default TTL for cache entries, in seconds. */
export const DEFAULT_TTL_SECONDS = 3600;

export interface CacheLookupResult {
  hit: boolean;
  results?: SearchResult[];
  meta?: HybridSearchMeta;
  /** Cosine similarity of the matched cached query (0..1). Only set on hit. */
  similarity?: number;
  /** Age of the cached entry in seconds. Only set on hit. */
  ageSeconds?: number;
}

export interface CacheStats {
  total_rows: number;
  total_hits: number;
  fresh_rows: number;
  stale_rows: number;
}

export interface QueryCacheConfig {
  enabled?: boolean;
  similarityThreshold?: number;
  ttlSeconds?: number;
}

/**
 * Deterministic ID for a (query, source, knobsHash) tuple. Used as the primary
 * key so re-caching the exact same (query, mode, knobs) just bumps the row's
 * hit_count and created_at rather than inserting duplicates.
 *
 * v0.32.3 [CDX-4]: knobsHash is now part of the key to prevent cross-mode
 * cache contamination. A tokenmax write (expansion=on, limit=50) and a
 * conservative write (no expansion, limit=10) for the same query+source
 * land in distinct rows. Empty-string knobsHash is accepted (preserves
 * existing test setups) but production calls always pass the resolved hash.
 */
export function cacheRowId(queryText: string, sourceId: string, knobsHash = ''): string {
  const h = createHash('sha256');
  h.update(`${sourceId}::${queryText}::${knobsHash}`);
  return h.digest('hex').slice(0, 32);
}

/**
 * Convert a Float32Array embedding into the pgvector text literal
 * format: `[v0,v1,v2,...]`. PGLite and Postgres both accept this when
 * the parameter is cast to `vector` or `halfvec` on the server side.
 */
function embeddingToPgVector(embedding: Float32Array): string {
  // Stringify with reasonable precision. pgvector accepts plain decimals.
  // Use a typed iteration to avoid TS errors on Float32Array forEach.
  const parts: string[] = new Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    parts[i] = embedding[i].toFixed(6);
  }
  return `[${parts.join(',')}]`;
}

export class SemanticQueryCache {
  private similarityThreshold: number;
  private ttlSeconds: number;
  private enabled: boolean;

  constructor(
    private engine: BrainEngine,
    config?: QueryCacheConfig,
  ) {
    this.enabled = config?.enabled ?? true;
    this.similarityThreshold = clampThreshold(config?.similarityThreshold);
    this.ttlSeconds = clampTtl(config?.ttlSeconds);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Look up a cached result set by query embedding similarity. Returns a
   * miss (hit=false) when:
   *   - cache is disabled,
   *   - embedding is null/empty,
   *   - the table doesn't exist (pre-v51 brain),
   *   - no row is within the similarity threshold,
   *   - the matching row is past its TTL.
   *
   * All errors are swallowed and converted to a miss \u2014 the cache must
   * never break the search hot path.
   */
  async lookup(
    queryEmbedding: Float32Array | null,
    opts: { sourceId?: string; knobsHash?: string } = {},
  ): Promise<CacheLookupResult> {
    if (!this.enabled || !queryEmbedding || queryEmbedding.length === 0) {
      return { hit: false };
    }
    const sourceId = opts.sourceId ?? 'default';
    const knobsHash = opts.knobsHash ?? '';
    const distanceThreshold = 1 - this.similarityThreshold;
    const vec = embeddingToPgVector(queryEmbedding);

    try {
      // Find the closest cached query within the distance threshold and
      // freshness window. The TTL check is done in-query (created_at +
      // ttl_seconds > now) so we never return a stale row.
      //
      // v0.32.3 [CDX-4]: knobs_hash filter prevents cross-mode contamination.
      // A tokenmax write (expansion=on, limit=50) and a conservative read
      // (no expansion, limit=10) have distinct knobs hashes and miss each
      // other. Rows with NULL knobs_hash (pre-v0.32.3) are excluded.
      const rows = await this.engine.executeRaw<{
        id: string;
        results: unknown;
        meta: unknown;
        distance: number;
        age_seconds: number;
      }>(
        `SELECT id, results, meta,
                embedding <=> $1::vector AS distance,
                EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
         FROM query_cache
         WHERE source_id = $2
           AND knobs_hash = $4
           AND embedding IS NOT NULL
           AND embedding <=> $1::vector < $3
           AND created_at + (ttl_seconds || ' seconds')::interval > now()
         ORDER BY embedding <=> $1::vector
         LIMIT 1`,
        [vec, sourceId, distanceThreshold, knobsHash],
      );

      if (rows.length === 0) return { hit: false };

      const row = rows[0];
      const results = Array.isArray(row.results)
        ? (row.results as SearchResult[])
        : safeJsonParse<SearchResult[]>(row.results, []);
      const meta = safeJsonParse<HybridSearchMeta | undefined>(row.meta, undefined);
      const similarity = 1 - row.distance;

      // Bump hit_count / last_hit_at \u2014 best-effort.
      void this.bumpHit(row.id).catch(() => { /* swallow */ });

      return {
        hit: true,
        results,
        meta,
        similarity,
        ageSeconds: row.age_seconds,
      };
    } catch {
      // Table missing, vector column missing, or any other failure: miss.
      return { hit: false };
    }
  }

  /**
   * Persist a fresh search result set into the cache. Idempotent on
   * (query_text + source_id) \u2014 re-writes the row with a fresh
   * created_at. Best-effort: errors are swallowed.
   */
  async store(
    queryText: string,
    queryEmbedding: Float32Array | null,
    results: SearchResult[],
    meta: HybridSearchMeta,
    opts: { sourceId?: string; ttlSeconds?: number; knobsHash?: string } = {},
  ): Promise<void> {
    if (!this.enabled || !queryEmbedding || queryEmbedding.length === 0) return;
    const sourceId = opts.sourceId ?? 'default';
    const knobsHash = opts.knobsHash ?? '';
    const ttl = clampTtl(opts.ttlSeconds ?? this.ttlSeconds);
    const id = cacheRowId(queryText, sourceId, knobsHash);
    const vec = embeddingToPgVector(queryEmbedding);

    try {
      // v0.32.3 [CDX-4]: knobs_hash threaded into the row so concurrent
      // tokenmax + conservative writes for the same query+source live as
      // distinct rows. The PK is `id` (which already encodes the hash),
      // so ON CONFLICT (id) DO UPDATE just refreshes the same-mode row.
      await this.engine.executeRaw(
        `INSERT INTO query_cache (id, query_text, source_id, knobs_hash, embedding, results, meta, ttl_seconds, created_at)
         VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb, $7::jsonb, $8, now())
         ON CONFLICT (id) DO UPDATE SET
           query_text = EXCLUDED.query_text,
           knobs_hash = EXCLUDED.knobs_hash,
           embedding  = EXCLUDED.embedding,
           results    = EXCLUDED.results,
           meta       = EXCLUDED.meta,
           ttl_seconds = EXCLUDED.ttl_seconds,
           created_at  = now()`,
        [
          id,
          queryText,
          sourceId,
          knobsHash,
          vec,
          JSON.stringify(results),
          JSON.stringify(meta),
          ttl,
        ],
      );
    } catch {
      // swallow \u2014 cache write must never break the search hot path.
    }
  }

  /** Clear ALL cache rows (optionally scoped by source). Returns rows deleted. */
  async clear(opts: { sourceId?: string } = {}): Promise<number> {
    try {
      if (opts.sourceId) {
        const rows = await this.engine.executeRaw<{ n: number }>(
          `WITH deleted AS (DELETE FROM query_cache WHERE source_id = $1 RETURNING 1)
           SELECT COUNT(*)::int AS n FROM deleted`,
          [opts.sourceId],
        );
        return rows[0]?.n ?? 0;
      }
      const rows = await this.engine.executeRaw<{ n: number }>(
        `WITH deleted AS (DELETE FROM query_cache RETURNING 1)
         SELECT COUNT(*)::int AS n FROM deleted`,
      );
      return rows[0]?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Delete only stale (past-TTL) rows. Returns rows deleted. */
  async prune(): Promise<number> {
    try {
      const rows = await this.engine.executeRaw<{ n: number }>(
        `WITH deleted AS (
           DELETE FROM query_cache
           WHERE created_at + (ttl_seconds || ' seconds')::interval <= now()
           RETURNING 1
         )
         SELECT COUNT(*)::int AS n FROM deleted`,
      );
      return rows[0]?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Summary stats for `gbrain cache stats`. */
  async stats(): Promise<CacheStats> {
    try {
      const rows = await this.engine.executeRaw<{
        total_rows: number;
        total_hits: number;
        fresh_rows: number;
        stale_rows: number;
      }>(
        `SELECT
           COUNT(*)::int AS total_rows,
           COALESCE(SUM(hit_count), 0)::int AS total_hits,
           COUNT(*) FILTER (WHERE created_at + (ttl_seconds || ' seconds')::interval > now())::int AS fresh_rows,
           COUNT(*) FILTER (WHERE created_at + (ttl_seconds || ' seconds')::interval <= now())::int AS stale_rows
         FROM query_cache`,
      );
      return rows[0] ?? { total_rows: 0, total_hits: 0, fresh_rows: 0, stale_rows: 0 };
    } catch {
      return { total_rows: 0, total_hits: 0, fresh_rows: 0, stale_rows: 0 };
    }
  }

  private async bumpHit(id: string): Promise<void> {
    await this.engine.executeRaw(
      `UPDATE query_cache
         SET hit_count = hit_count + 1, last_hit_at = now()
       WHERE id = $1`,
      [id],
    );
  }
}

function clampThreshold(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SIMILARITY_THRESHOLD;
  return Math.max(0.5, Math.min(0.999, v));
}

function clampTtl(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_TTL_SECONDS;
  // Cap at 30 days to avoid runaway TTLs.
  return Math.min(60 * 60 * 24 * 30, Math.floor(v));
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * Resolve cache config from the engine's `config` table. Mirrors how
 * other modules read runtime config (e.g. embedding_dimensions). All
 * three keys have sensible defaults; missing rows fall back to those.
 */
export async function loadCacheConfig(engine: BrainEngine): Promise<QueryCacheConfig> {
  const keys = [
    'search.cache.enabled',
    'search.cache.similarity_threshold',
    'search.cache.ttl_seconds',
  ];
  const config: QueryCacheConfig = {
    enabled: true,
    similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    ttlSeconds: DEFAULT_TTL_SECONDS,
  };
  try {
    const rows = await engine.executeRaw<{ key: string; value: string }>(
      `SELECT key, value FROM config WHERE key = ANY($1)`,
      [keys],
    );
    for (const row of rows) {
      if (row.key === 'search.cache.enabled') {
        config.enabled = row.value === '1' || row.value.toLowerCase() === 'true';
      } else if (row.key === 'search.cache.similarity_threshold') {
        const v = parseFloat(row.value);
        if (Number.isFinite(v)) config.similarityThreshold = clampThreshold(v);
      } else if (row.key === 'search.cache.ttl_seconds') {
        const v = parseInt(row.value, 10);
        if (Number.isFinite(v)) config.ttlSeconds = clampTtl(v);
      }
    }
  } catch {
    // Use defaults.
  }
  return config;
}
