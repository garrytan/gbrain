import type { Migration } from './types.ts';

export const v058: Migration = {
  version: 58,
  name: 'edges_backfilled_at_v0_33_2',
  // v0.33.2 W0c — resumable symbol-resolution backfill watermark.
  // (Originally claimed v55; renumbered to v58 on merge with master which
  // landed query_cache_search_lite=v55, drift_watch=v56, search_telemetry=v57.)
  //
  // The within-file two-pass resolver (src/core/chunkers/symbol-resolver.ts)
  // walks every content_chunks row that has unresolved edges
  // (rows in code_edges_symbol whose to_symbol_qualified has not been
  // matched against same-file symbol_name_qualified yet) and writes the
  // resolution outcome to code_edges_symbol.edge_metadata. On a 96K-chunk
  // brain that is a 5-15 minute backfill the first time it runs.
  //
  // `edges_backfilled_at` is the resume watermark. Backfill runs in
  // 200-chunk batches; on batch success the column is set to NOW() for
  // every chunk in the batch. Resume picks up chunks where the watermark
  // is NULL or older than EDGE_EXTRACTOR_VERSION_TS (a constant bumped
  // when the extractor's shape changes). Crashes lose at most one batch.
  //
  // Composite + partial indexes for the lookup hot path (D11 from eng
  // review):
  //   - idx_code_edges_symbol_resolver (source_id, to_symbol_qualified)
  //     — every code_edges_symbol row is unresolved by construction
  //     (the table has no to_chunk_id column; that lives on code_edges_chunk).
  //     This composite index supports the resolver's per-source lookups.
  //   - idx_content_chunks_symbol_lookup (page_id, symbol_name_qualified)
  //     WHERE symbol_name_qualified IS NOT NULL — file-batched lookup
  //     used by both the resolver and the cluster recompute phase (W4-5).
  //   - idx_content_chunks_edges_backfill (edges_backfilled_at)
  //     WHERE edges_backfilled_at IS NULL — find unresumed rows quickly.
  //
  // Idempotent: IF NOT EXISTS on column + indexes. Backfill itself runs
  // separately via the resolve_symbol_edges cycle phase.
  sql: `
      ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS edges_backfilled_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_resolver
        ON code_edges_symbol (source_id, to_symbol_qualified);

      CREATE INDEX IF NOT EXISTS idx_content_chunks_symbol_lookup
        ON content_chunks (page_id, symbol_name_qualified)
        WHERE symbol_name_qualified IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_content_chunks_edges_backfill
        ON content_chunks (edges_backfilled_at)
        WHERE edges_backfilled_at IS NULL;
    `,
};
