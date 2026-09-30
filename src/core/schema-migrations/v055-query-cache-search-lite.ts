import type { Migration } from './types.ts';
import type { BrainEngine } from '../engine.ts';
import { hnswMaxDimsForType, readExistingEmbeddingShape } from '../vector-index.ts';

export const v055: Migration = {
  version: 55,
  name: 'query_cache_search_lite',
  // v0.32.x (search-lite, originally claimed v52 in PR #897; renumbered
  // to v55 on merge with master to sit after eval_contradictions_cache (v52),
  // eval_contradictions_runs (v53), cjk_wave (v54)).
  //
  // Semantic query cache. Cache search results keyed by query embedding
  // similarity so a near-duplicate query reuses the previous result set
  // instead of re-running keyword + vector + RRF + dedup. Cache lookup:
  // `embedding <=> $1 < 0.08` (cosine distance, similarity >= 0.92) using HNSW.
  //
  // Schema:
  //   id            — SHA-256(query_text + source_id) for diagnostics.
  //   query_text    — the raw query for debug + cache-stats output.
  //   source_id     — scope by source so multi-source brains don't bleed.
  //   embedding     — the query embedding. Same dim as content_chunks.
  //   results       — JSONB array of SearchResult rows.
  //   meta          — JSONB; what hybridSearch actually did (intent,
  //                   vector_enabled, etc.) so cached responses can
  //                   surface the same debug info as fresh ones.
  //   ttl_seconds   — per-row TTL. Default 3600. Stale rows are skipped
  //                   at read time and pruned by `gbrain cache prune`.
  //   created_at    — TTL anchor.
  //   hit_count     — instrumentation; bumped on each lookup-hit.
  //   last_hit_at   — instrumentation.
  //
  // Schema is engine-agnostic: HALFVEC when available (matches the facts
  // table from v45 for consistency), otherwise VECTOR. Embedding dim is
  // resolved from `config.embedding_dimensions` at migration time so
  // non-OpenAI brains work — same approach as v45.
  sql: '',
  handler: async (engine: BrainEngine) => {
    // Step 1: resolve embedding dim from config table (same pattern as v45).
    let embeddingDim = 1536;
    try {
      const dimRows = await engine.executeRaw<{ value: string }>(
        `SELECT value FROM config WHERE key = 'embedding_dimensions'`,
      );
      if (dimRows.length > 0) {
        const parsed = parseInt(dimRows[0].value, 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 4096) {
          embeddingDim = parsed;
        }
      }
    } catch {
      // No config row yet — fall back to default.
    }

    // Step 2: pgvector version probe for HALFVEC. Same logic as v45.
    // We deliberately mirror v45's facts table approach for consistency.
    let useHalfvec = false;
    if (engine.kind === 'postgres') {
      try {
        const vrows = await engine.executeRaw<{ extversion: string }>(
          `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
        );
        if (vrows.length > 0) {
          const v = vrows[0].extversion;
          const parts = v.split('.');
          const major = parseInt(parts[0] ?? '0', 10);
          const minor = parseInt(parts[1] ?? '0', 10);
          if (major > 0 || (major === 0 && minor >= 7)) {
            useHalfvec = true;
          }
        }
      } catch {
        // Probe failed — fall back to VECTOR.
      }
    } else {
      useHalfvec = true;
    }

    const existingShape = await readExistingEmbeddingShape(engine, 'query_cache');
    const columnType = existingShape?.type ?? (useHalfvec ? 'halfvec' : 'vector');
    const vecType = columnType.toUpperCase();
    const opclass = columnType === 'halfvec' ? 'halfvec_cosine_ops' : 'vector_cosine_ops';
    const hnswMaxDims = hnswMaxDimsForType(columnType);
    const queryCacheEmbeddingIndexSql = (existingShape?.dimensions ?? embeddingDim) <= hnswMaxDims
      ? `CREATE INDEX IF NOT EXISTS idx_query_cache_embedding_hnsw
          ON query_cache USING hnsw (embedding ${opclass})
          WHERE embedding IS NOT NULL;`
      : `-- idx_query_cache_embedding_hnsw skipped: pgvector HNSW ${columnType} indexes support
        -- at most ${hnswMaxDims} dimensions; exact vector scans remain available.`;

    const ddl = `
        CREATE TABLE IF NOT EXISTS query_cache (
          id            TEXT        PRIMARY KEY,
          query_text    TEXT        NOT NULL,
          source_id     TEXT        NOT NULL DEFAULT 'default',
          embedding     ${vecType}(${embeddingDim}),
          results       JSONB       NOT NULL DEFAULT '[]'::jsonb,
          meta          JSONB       NOT NULL DEFAULT '{}'::jsonb,
          ttl_seconds   INTEGER     NOT NULL DEFAULT 3600,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          hit_count     INTEGER     NOT NULL DEFAULT 0,
          last_hit_at   TIMESTAMPTZ
        );

        CREATE INDEX IF NOT EXISTS idx_query_cache_source_created
          ON query_cache(source_id, created_at DESC);

        ${queryCacheEmbeddingIndexSql}
      `;

    await engine.runMigration(55, ddl);
  },
};
