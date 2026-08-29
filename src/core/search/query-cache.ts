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
import { buildPageGenerationsSnapshot, CACHE_GATE_WHERE_CLAUSE } from './query-cache-gate.ts';

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

/** Bigram-Dice acceptance threshold for the lookup text guard (#1469). */
export const CACHE_TEXT_GUARD_DICE_THRESHOLD = 0.5;

/**
 * Normalize a query string for the text guard: Unicode NFKC (folds
 * full/half-width variants), lowercase, collapse whitespace runs, trim.
 */
function normalizeGuardText(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Character-bigram multiset over a normalized string, code-point safe
 * (Array.from splits surrogate pairs correctly). Bigrams spanning a
 * space are skipped so word boundaries don't manufacture overlap;
 * within CJK text there are no spaces, so every adjacent char pair
 * counts — the property that makes this guard CJK-safe without any
 * tokenizer.
 */
function charBigrams(s: string): Map<string, number> {
  const grams = new Map<string, number>();
  const chars = Array.from(s);
  for (let i = 0; i < chars.length - 1; i++) {
    if (chars[i] === ' ' || chars[i + 1] === ' ') continue;
    const g = chars[i] + chars[i + 1];
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
}

/** Sørensen–Dice coefficient over char-bigram multisets (0..1). */
function bigramDice(a: string, b: string): number {
  const ga = charBigrams(a);
  const gb = charBigrams(b);
  let sizeA = 0;
  for (const n of ga.values()) sizeA += n;
  let sizeB = 0;
  for (const n of gb.values()) sizeB += n;
  if (sizeA === 0 || sizeB === 0) return 0;
  let inter = 0;
  for (const [g, n] of ga) {
    const m = gb.get(g);
    if (m) inter += Math.min(n, m);
  }
  return (2 * inter) / (sizeA + sizeB);
}

/**
 * #1469 — text guard for cache-lookup candidates. Embedding cosine >= 0.92
 * is NOT proof two queries are the same question: distinct queries (notably
 * CJK, where some embedding providers collapse whole scripts into a narrow
 * cone of the space) can land within the threshold and serve each other's
 * cached rows. Accept a candidate only when its stored query text is
 * plausibly the same query as the incoming one:
 *
 *   - NFKC/lowercase/whitespace-normalized equality, OR
 *   - char-bigram Dice >= 0.5 (CJK-safe: bigrams need no word boundaries).
 *
 * Deliberately permissive (semantic paraphrases still hit via Dice); the
 * embedding threshold remains the primary gate — this only rejects rows
 * whose text is clearly a different question.
 */
export function cacheTextGuard(a: string, b: string): boolean {
  const na = normalizeGuardText(a);
  const nb = normalizeGuardText(b);
  if (na === nb) return true;
  return bigramDice(na, nb) >= CACHE_TEXT_GUARD_DICE_THRESHOLD;
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
   *
   * #1469: when `opts.queryText` is provided, the top candidates (by
   * embedding distance) are additionally screened by `cacheTextGuard`
   * against the stored `query_text`, and the first passing candidate
   * wins. Cosine >= 0.92 alone is not identity \u2014 embedding collapse
   * (observed on CJK queries) can put DIFFERENT questions inside the
   * threshold. Omitting `queryText` preserves the legacy
   * closest-row-wins behavior.
   */
  async lookup(
    queryEmbedding: Float32Array | null,
    opts: { sourceId?: string; knobsHash?: string; queryText?: string } = {},
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
      // v0.40.3.0: query_cache row aliased `qc` so the two-layer gate
      // fragment in CACHE_GATE_WHERE_CLAUSE can reference qc.max_generation_at_store
      // + qc.page_generations against the live pages table.
      // #1469: fetch the top 5 candidates (not just the closest) so the
      // text guard below can skip a closer-but-different query and still
      // serve a farther row whose text actually matches.
      //
      // D2 remediation: the candidate select is LIGHT (id/query_text/
      // distance/age only). Shipping five full results+meta JSONB payloads
      // per lookup just to keep one was pure transfer overhead; the winner's
      // payload is fetched by id in the second query below.
      const rows = await this.engine.executeRaw<{
        id: string;
        query_text: string;
        distance: number;
        age_seconds: number;
      }>(
        `SELECT qc.id, qc.query_text,
                qc.embedding <=> $1::vector AS distance,
                EXTRACT(EPOCH FROM (now() - qc.created_at))::int AS age_seconds
         FROM query_cache qc
         WHERE qc.source_id = $2
           AND qc.knobs_hash = $4
           AND qc.embedding IS NOT NULL
           AND qc.embedding <=> $1::vector < $3
           AND qc.created_at + (qc.ttl_seconds || ' seconds')::interval > now()
           AND ${CACHE_GATE_WHERE_CLAUSE}
         ORDER BY qc.embedding <=> $1::vector
         LIMIT 5`,
        [vec, sourceId, distanceThreshold, knobsHash],
      );

      if (rows.length === 0) return { hit: false };

      // #1469: with a queryText, accept the FIRST (closest) candidate whose
      // stored text passes the guard; none passing → miss. Without one
      // (legacy callers), closest row wins as before.
      const queryText = opts.queryText;
      const row =
        queryText == null
          ? rows[0]
          : rows.find((r) => cacheTextGuard(queryText, r.query_text ?? ''));
      if (!row) return { hit: false };

      // Second query: fetch ONLY the winner's heavy payload. A row deleted
      // between the two statements (concurrent prune/clear) is a miss — the
      // caller runs the real search, same posture as every other edge here.
      const payloadRows = await this.engine.executeRaw<{
        results: unknown;
        meta: unknown;
      }>(`SELECT results, meta FROM query_cache WHERE id = $1`, [row.id]);
      if (payloadRows.length === 0) return { hit: false };
      const payload = payloadRows[0];
      const results = Array.isArray(payload.results)
        ? (payload.results as SearchResult[])
        : safeJsonParse<SearchResult[]>(payload.results, []);
      const meta = safeJsonParse<HybridSearchMeta | undefined>(payload.meta, undefined);
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
   *
   * WP2/T3: the null-embedding no-op below is load-bearing for ENG-6 \u2014
   * a total embed outage produces no cache-lookup embedding, so degraded
   * keyword-only result sets are uncacheable by construction. Degraded
   * sets that DO have an embedding are written by hybridSearchCached with
   * `ttlSeconds: DEGRADED_CACHE_TTL_SECONDS` and a `meta.degraded` stamp
   * (D14.2), so a salvaged set never serves as clean for the full TTL.
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

    // v0.40.3.0: capture the per-page snapshot + corpus-state bookmark
    // for the two-layer cache gate. Pure helper from query-cache-gate.ts
    // handles the pre-v91 brain fallback (empty snapshot, zero bookmark
    // \u2014 legacy compat preserved).
    const pageIds = results
      .map((r) => r.page_id)
      .filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
    const snapshot = await buildPageGenerationsSnapshot(this.engine, pageIds);

    try {
      // v0.32.3 [CDX-4]: knobs_hash threaded into the row so concurrent
      // tokenmax + conservative writes for the same query+source live as
      // distinct rows. The PK is `id` (which already encodes the hash),
      // so ON CONFLICT (id) DO UPDATE just refreshes the same-mode row.
      //
      // v0.40.3.0: page_generations JSONB + max_generation_at_store BIGINT
      // stamped per D11 (cache invalidation gate). page_generations is
      // sent as a JSON.stringify and cast to JSONB inside the SQL; pre-v91
      // brains store an empty `{}` + zero bookmark (legacy compat per
      // the v0.40.3.0 IRON-RULE).
      await this.engine.executeRaw(
        `INSERT INTO query_cache (id, query_text, source_id, knobs_hash, embedding, results, meta, ttl_seconds, page_generations, max_generation_at_store, created_at)
         VALUES ($1, $2, $3, $4, $5::vector, $6::text::jsonb, $7::text::jsonb, $8, $9::text::jsonb, $10, now())
         ON CONFLICT (id) DO UPDATE SET
           query_text = EXCLUDED.query_text,
           knobs_hash = EXCLUDED.knobs_hash,
           embedding  = EXCLUDED.embedding,
           results    = EXCLUDED.results,
           meta       = EXCLUDED.meta,
           ttl_seconds = EXCLUDED.ttl_seconds,
           page_generations = EXCLUDED.page_generations,
           max_generation_at_store = EXCLUDED.max_generation_at_store,
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
          JSON.stringify(snapshot.page_generations),
          snapshot.max_generation_at_store,
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
      // Best-effort by design (parity with readSearchStats): a brain without
      // the cache table shows all-zero, not a crash. cache_stats wraps this in
      // withRelationGuard for other unexpected relation errors; the
      // missing-cache-table case stays gracefully empty.
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
