import type { Migration } from './types.ts';

export const v059: Migration = {
  version: 59,
  name: 'code_traversal_cache_v0_34',
  // v0.34 W3b — memoization layer for code_blast / code_flow.
  // (Originally claimed v56; renumbered to v59 on merge with master which
  // landed query_cache_search_lite=v55, drift_watch=v56, search_telemetry=v57.)
  //
  // Recursive caller/callee walks on a dense (calls + imports + references)
  // graph can fan out to 200+ nodes per call. During a plan-mode agent
  // session that calls code_blast 5-15 times, we want hits to return
  // <200ms instead of re-walking the same graph.
  //
  // The cache is correctness-safe under concurrent sync via REPEATABLE
  // READ + xmin_max — the traversal-cache module wraps each walk in
  // `BEGIN ISOLATION LEVEL REPEATABLE READ` and captures the snapshot's
  // xmin_max alongside the response. On read, if the current snapshot
  // doesn't dominate the cached snapshot, the cache misses.
  //
  // D3 — cluster_generation: monotonically incrementing counter bumped
  // once per recompute_code_clusters phase. Cache rows carrying a stale
  // generation naturally miss on next read, so cluster-renaming-mid-cycle
  // doesn't return stale cluster names from cached blast/flow responses.
  sql: `
      CREATE TABLE IF NOT EXISTS code_traversal_cache (
        id SERIAL PRIMARY KEY,
        symbol_qualified TEXT NOT NULL,
        depth INT NOT NULL,
        source_id TEXT NOT NULL,
        response_json JSONB NOT NULL,
        max_chunk_updated_at TIMESTAMPTZ NOT NULL,
        xmin_max BIGINT NOT NULL,
        cluster_generation BIGINT NOT NULL DEFAULT 0,
        computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS code_traversal_cache_key_idx
        ON code_traversal_cache (symbol_qualified, depth, source_id);
      CREATE INDEX IF NOT EXISTS code_traversal_cache_source_idx
        ON code_traversal_cache (source_id);
    `,
};
