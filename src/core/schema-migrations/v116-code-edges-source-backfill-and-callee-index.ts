import type { Migration } from './types.ts';

export const v116: Migration = {
  version: 116,
  name: 'code_edges_source_backfill_and_callee_index',
  // Repair + index pass for the call graph:
  //
  // 1. BACKFILL: importCodeFile built CodeEdgeInput rows without source_id,
  //    so every extracted edge landed NULL. getCallersOf/getCalleesOf add
  //    `AND source_id = <scoped>` whenever a worktree pin / --source is in
  //    play — NULL never matches, so scoped call-graph queries silently
  //    returned 0 rows on multi-source brains even though the edges
  //    existed. The write path now stamps `sourceId ?? 'default'`; this
  //    backfill repairs rows written before the fix by deriving each
  //    edge's source from its own from_chunk's page (pages.source_id is
  //    NOT NULL DEFAULT 'default', so COALESCE is belt-and-braces only).
  //
  // 2. INDEXES: getCalleesOf filters BOTH edge tables on
  //    from_symbol_qualified, which had no index anywhere — every callee
  //    lookup was a sequential scan, amplified per-BFS-node by the
  //    recursive code walk (one getCalleesOf per frontier node, up to
  //    maxNodes). With NULL edges repaired, scoped walks actually expand,
  //    so the latent seq-scan cost becomes real. Plain CREATE INDEX (not
  //    CONCURRENTLY): edge tables are modest (mirrors the v58 resolver
  //    index). Keep in sync with src/schema.sql.
  idempotent: true,
  sql: `
      UPDATE code_edges_symbol e
         SET source_id = COALESCE(p.source_id, 'default')
        FROM content_chunks c
        JOIN pages p ON p.id = c.page_id
       WHERE c.id = e.from_chunk_id
         AND e.source_id IS NULL;

      UPDATE code_edges_chunk e
         SET source_id = COALESCE(p.source_id, 'default')
        FROM content_chunks c
        JOIN pages p ON p.id = c.page_id
       WHERE c.id = e.from_chunk_id
         AND e.source_id IS NULL;

      CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_from_symbol
        ON code_edges_symbol (from_symbol_qualified);

      CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_from_symbol
        ON code_edges_chunk (from_symbol_qualified);
    `,
};
