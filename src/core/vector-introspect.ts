/**
 * Live introspection of pgvector column widths via `pg_attribute.atttypmod` +
 * `format_type()`. Used at `initSchema` time to detect when the gateway-
 * resolved embedding dimension disagrees with the actual on-disk column —
 * the failure mode behind upstream gbrain #1141 and #1189.
 *
 * Closes the bug class where `gbrain init --migrate-only` (Phase A of
 * `gbrain upgrade`) starts before the gateway has been configured from
 * `~/.gbrain/config.json`. The gateway falls back to
 * `DEFAULT_EMBEDDING_DIMENSIONS` (currently 1536); the live column for a
 * brain previously switched to a high-dim embedder (ZeroEntropy zembed-1
 * 2560d, Qwen3-Embedding-4B 2560d, etc.) is `vector(N>2000)`; the schema-
 * replay emits the unconditional `idx_chunks_embedding` HNSW; pgvector
 * rejects with `column cannot have more than 2000 dimensions for hnsw
 * index`; Phase A aborts; `schema_version` never advances.
 *
 * The helper is engine-agnostic: it takes a `QueryRunner` callback so both
 * `PostgresEngine` and `PGLiteEngine` can call it with their own driver.
 * Best-effort by design — any probe failure returns `null` and the caller
 * falls through to its existing gateway-resolved value.
 */

export const PGVECTOR_HNSW_VECTOR_MAX_DIMS = 2000;

/**
 * Minimal query interface: takes SQL + positional params, returns rows.
 * Both engines can adapt to this shape with a 1-line lambda.
 */
export type VectorIntrospectQuery = (
  sql: string,
  params?: ReadonlyArray<unknown>,
) => Promise<ReadonlyArray<Record<string, unknown>>>;

/**
 * Look up the declared width of a pgvector column on a live database.
 *
 * Returns the dimension (a positive integer) when the column exists AND
 * its type is `vector(N)`. Returns `null` when:
 *   - the table or column doesn't exist (fresh install)
 *   - the column is not a `vector(...)` type
 *   - the probe query throws for any reason
 *
 * Implementation note: `format_type(atttypid, atttypmod)` returns the
 * canonical textual rendering of the type — e.g. `'vector(2560)'`. We
 * parse the parenthesized count rather than reaching into pgvector's
 * `atttypmod` bit-packing convention, which has changed across releases.
 * Postgres' built-in `format_type` is stable.
 *
 * @param query  driver-specific query runner
 * @param table  unqualified table name (must be a-z 0-9 _ — refuses anything else)
 * @param column unqualified column name (same shape gate)
 */
export async function getLiveVectorColumnDims(
  query: VectorIntrospectQuery,
  table: string,
  column: string,
): Promise<number | null> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table) || !/^[a-z_][a-z0-9_]*$/.test(column)) {
    return null;
  }
  try {
    const rows = await query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS column_type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = $1
          AND a.attname = $2
          AND NOT a.attisdropped`,
      [table, column],
    );
    if (rows.length === 0) return null;
    const raw = rows[0]?.column_type;
    if (typeof raw !== 'string') return null;
    const match = raw.match(/^vector\((\d+)\)$/i);
    if (!match) return null;
    const dim = Number(match[1]);
    if (!Number.isInteger(dim) || dim <= 0) return null;
    return dim;
  } catch {
    return null;
  }
}

/**
 * Engine-agnostic "do we need to override the gateway dim?" decision.
 *
 * Returns the dim that `getPostgresSchema` / `getPGLiteSchema` should be
 * called with. Prefers the live column dim when it disagrees with the
 * gateway-resolved value AND the live value would change the HNSW-policy
 * outcome (either side of `PGVECTOR_HNSW_VECTOR_MAX_DIMS`). Otherwise
 * falls through to the gateway value untouched.
 *
 * The narrow override condition (only when the HNSW boundary is in play)
 * is intentional: silently overriding the gateway on every initSchema
 * would mask genuine misconfigurations. The boundary is exactly where
 * the cap-2000 bug bites.
 *
 * @param gatewayDims dim resolved by the gateway (or default fallback)
 * @param liveDims    dim probed from the live DB, or null if column absent
 * @returns           dim to pass to the schema templater
 */
export function resolveSchemaDims(
  gatewayDims: number,
  liveDims: number | null,
): { dims: number; overridden: boolean; reason?: string } {
  if (liveDims === null) {
    return { dims: gatewayDims, overridden: false };
  }
  if (liveDims === gatewayDims) {
    return { dims: gatewayDims, overridden: false };
  }
  const gatewayWouldEmitHnsw = gatewayDims <= PGVECTOR_HNSW_VECTOR_MAX_DIMS;
  const liveWouldEmitHnsw = liveDims <= PGVECTOR_HNSW_VECTOR_MAX_DIMS;
  if (gatewayWouldEmitHnsw === liveWouldEmitHnsw) {
    return { dims: gatewayDims, overridden: false };
  }
  return {
    dims: liveDims,
    overridden: true,
    reason: `content_chunks.embedding is vector(${liveDims}) on disk but the gateway resolved ${gatewayDims}; using live dim so the HNSW-2000-cap policy fires correctly`,
  };
}
