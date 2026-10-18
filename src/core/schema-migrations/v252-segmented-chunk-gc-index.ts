import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Segmented page storage (v248), follow-up:
// - content_chunks.retired_generation (v248) stays. Nothing at this version
//   writes or reads it: the flip and the projection delete the rows they
//   retire, and a row awaiting a deferred retirement is hidden by its
//   occurrence's closed manifest range (chunkGenerationFilter). The released
//   binary's chunk readers still select it, so it is dropped only once the
//   writer floor excludes every binary that reads it
//   (test/large-pages/v252-master-reader-compat.test.ts). An earlier build of
//   this migration dropped it; v255 re-adds it on those (test) brains.
// - content_chunks_generation_idx serves segment GC's staged-chunk delete
//   (`c.body_generation IS NOT NULL AND c.body_generation > p.body_generation`,
//   engine-sql/page-body.ts sweepSegments), which the resident maintenance
//   worker runs about once a minute: without it every tick scanned the whole
//   table, inline chunks included. Partial, so inline chunks (body_generation
//   NULL) are not in it; built online (CONCURRENTLY on Postgres).
export const CONTENT_CHUNKS_GENERATION_INDEX = {
  name: 'content_chunks_generation_idx',
  table: 'content_chunks',
  sql: 'CREATE INDEX IF NOT EXISTS content_chunks_generation_idx ON content_chunks (page_id, body_generation) WHERE body_generation IS NOT NULL',
};

export const v252: Migration = {
  version: 252,
  name: 'segmented_chunk_gc_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 251, CONTENT_CHUNKS_GENERATION_INDEX, { notice: migrationNotice });
  },
};
