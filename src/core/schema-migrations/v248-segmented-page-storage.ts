import type { Migration } from './types.ts';
import { PAGE_BODY_SCHEMA_SQL, PAGE_GENERATION_BUMP_FN_SQL } from '../page-body/schema.ts';
import { PAGE_SEARCH_VECTOR_TRIGGER_SQL } from '../page-state/projection-schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Wave B segmented page storage (src/core/page-body/): a page body over 1 MiB
// is stored as content-addressed segment texts plus a manifest versioned by
// generation range, behind `pages.segmented_storage` (default off, so no row
// changes class until it is turned on). Nothing to backfill: every existing
// page reads `body_storage = 'inline'`.
//
// - pages: body class, size, generation and bounded leads; compiled_truth and
//   timeline become nullable (still DEFAULT ''), and pages_body_storage_chk
//   makes them NULL exactly for segmented pages, so an older binary's
//   whole-body write to a segmented page fails instead of truncating it.
// - content_chunks: segment identity, stored span and generation range (NULL
//   for every inline chunk); page_versions: a segmented snapshot references a
//   generation instead of copying the body.
// - The new tables and the occurrence id sequence (also in both blobs).
// - bump_page_generation_fn is re-created so a fresh install (where v91
//   re-created it after the blob) ends with the blob's text, and
//   trg_pages_search_vector so it also fires on timeline_lead (the blob's
//   statement adds that column whenever pages has it).
//
// The pages, content_chunks and page_versions columns are migration-only (not
// in schema.sql's CREATE TABLEs), so fresh and upgraded brains share column
// ordinals; blob triggers read them only on a row whose body columns are NULL.
// CHECKs are added NOT VALID and validated in their own statements, and the
// chunk occurrence index is built online (CONCURRENTLY on Postgres), so no
// whole-table scan runs under an exclusive lock. Segment text storage: lz4 on
// Postgres (EXTERNAL when the server lacks lz4), EXTERNAL on PGLite, whose
// WASM pglz makes deep window reads about 4x slower.
const COMMON_SQL = `
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS body_storage TEXT NOT NULL DEFAULT 'inline';
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS body_bytes BIGINT;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS truth_bytes BIGINT;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS body_lines BIGINT;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS body_generation BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS segment_count INTEGER;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS segmenter_version INTEGER;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS body_flags JSONB;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS truth_lead TEXT;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS timeline_lead TEXT;
    ALTER TABLE pages ALTER COLUMN compiled_truth DROP NOT NULL;
    ALTER TABLE pages ALTER COLUMN timeline DROP NOT NULL;
    DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_body_storage_chk' AND conrelid = 'pages'::regclass) THEN
        ALTER TABLE pages ADD CONSTRAINT pages_body_storage_chk CHECK (
          (body_storage = 'inline' AND compiled_truth IS NOT NULL AND timeline IS NOT NULL AND truth_lead IS NULL)
          OR (body_storage = 'segmented' AND compiled_truth IS NULL AND timeline IS NULL AND body_bytes IS NOT NULL)
        ) NOT VALID;
      END IF;
    END $do$;
    ${PAGE_BODY_SCHEMA_SQL}
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS occurrence_id BIGINT;
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS local_ordinal INTEGER;
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS raw_byte_start BIGINT;
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS raw_byte_end BIGINT;
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS body_generation BIGINT;
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS retired_generation BIGINT;
    ALTER TABLE page_versions ALTER COLUMN compiled_truth DROP NOT NULL;
    ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS body_storage TEXT NOT NULL DEFAULT 'inline';
    ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS body_generation BIGINT;
    ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS body_bytes BIGINT;
    ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS content_hash TEXT;
    DO $do$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_versions_body_chk' AND conrelid = 'page_versions'::regclass) THEN
        ALTER TABLE page_versions ADD CONSTRAINT page_versions_body_chk CHECK (
          (body_storage = 'inline' AND compiled_truth IS NOT NULL)
          OR (body_storage = 'segmented' AND compiled_truth IS NULL AND timeline IS NULL AND body_generation IS NOT NULL)
        ) NOT VALID;
      END IF;
    END $do$;
    ${PAGE_GENERATION_BUMP_FN_SQL}
    DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages;
    ${PAGE_SEARCH_VECTOR_TRIGGER_SQL};
`;

const CONTENT_CHUNKS_OCCURRENCE_INDEX = {
  name: 'content_chunks_occurrence_idx',
  table: 'content_chunks',
  sql: 'CREATE INDEX IF NOT EXISTS content_chunks_occurrence_idx ON content_chunks (page_id, occurrence_id) WHERE occurrence_id IS NOT NULL',
};

export const v248: Migration = {
  version: 248,
  name: 'segmented_page_storage',
  idempotent: true,
  transaction: false,
  sql: '',
  sqlFor: {
    postgres: `${COMMON_SQL}
    DO $do$ BEGIN
      EXECUTE 'ALTER TABLE page_segment_texts ALTER COLUMN body SET COMPRESSION lz4';
    EXCEPTION WHEN feature_not_supported OR syntax_error OR invalid_parameter_value THEN
      ALTER TABLE page_segment_texts ALTER COLUMN body SET STORAGE EXTERNAL;
    END $do$;
  `,
    pglite: `${COMMON_SQL}
    ALTER TABLE page_segment_texts ALTER COLUMN body SET STORAGE EXTERNAL;
  `,
  },
  handler: async engine => {
    await engine.runMigration(248, 'ALTER TABLE pages VALIDATE CONSTRAINT pages_body_storage_chk;');
    await engine.runMigration(248, 'ALTER TABLE page_versions VALIDATE CONSTRAINT page_versions_body_chk;');
    await buildIndexOnline(engine, 248, CONTENT_CHUNKS_OCCURRENCE_INDEX, { notice: migrationNotice });
    // Search's visibility predicate reads the generation columns; without their statistics Postgres prices it at 0.5%
    // and vector search sorts every candidate instead of walking its HNSW index (projection-statistics.ts).
    if (engine.kind === 'postgres') {
      await engine.runMigration(248, 'ANALYZE pages(body_generation); ANALYZE content_chunks(body_generation, retired_generation);');
    }
  },
};
