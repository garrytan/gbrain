/**
 * The `code_traversal_cache` table (v0.34 W3b): the memoised answers of `code_blast` and `code_flow`, read, written
 * and cleared by src/core/code-intel/traversal-cache.ts. SQL once for both engines, so a store that is not SQL
 * serves the same members (rust/docs/store/code-traversal-cache.md).
 *
 * The statements are the ones the cache module ran through `executeRaw` before: the same text, the same binds. A bind
 * the database rejects (a fractional depth, a NUL, no response) throws here as it did there; the cache module
 * decides what to swallow.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The key of a cache row; a read also asks for the generation it was computed at. */
export interface CodeTraversalCacheKey {
  symbol_qualified: string;
  depth: number;
  source_id: string;
  cluster_generation: number;
}

/** A cache row as a read returns it. `computed_at` is a Date at runtime (the driver's timestamptz), as before. */
export interface CodeTraversalCacheRow {
  response_json: unknown;
  computed_at: string;
  cluster_generation: number;
}

/** Which rows a clear removes: one source's, or every row. */
export interface CodeTraversalCacheClear {
  sourceId?: string;
  allSources?: boolean;
}

/** The row at the key whose generation is the one asked for, or null. */
export async function getCodeTraversalCache(tx: Raw, key: CodeTraversalCacheKey): Promise<CodeTraversalCacheRow | null> {
  const rows = await tx.executeRaw<{ response_json: unknown; computed_at: string; cluster_generation: number }>(
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
    response_json: row.response_json,
    computed_at: row.computed_at,
    // A bigint column: Postgres returns a BigInt, PGLite a number.
    cluster_generation: Number(row.cluster_generation),
  };
}

/** Upserts the row on `(symbol_qualified, depth, source_id)`; the response is bound as `JSON.stringify` text. */
export async function putCodeTraversalCache(
  tx: Raw, key: CodeTraversalCacheKey, response: unknown, maxChunkUpdatedAt: string, xminMax: number,
): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO code_traversal_cache
         (symbol_qualified, depth, source_id, response_json,
          max_chunk_updated_at, xmin_max, cluster_generation)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::timestamptz, $6, $7)
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
}

/** Deletes every row (`allSources`) or the rows of `sourceId`; returns how many it deleted. */
export async function clearCodeTraversalCache(tx: Raw, opts: CodeTraversalCacheClear): Promise<number> {
  if (opts.allSources) {
    const rows = await tx.executeRaw<{ count: string }>(
      `WITH deleted AS (DELETE FROM code_traversal_cache RETURNING 1)
       SELECT COUNT(*)::text AS count FROM deleted`,
      [],
    );
    return parseInt(rows[0]?.count ?? '0', 10);
  }
  const rows = await tx.executeRaw<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM code_traversal_cache WHERE source_id = $1 RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM deleted`,
    [opts.sourceId!],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}
