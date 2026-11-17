import type { Migration } from './types.ts';
import type { BrainEngine } from '../engine.ts';

export const v039: Migration = {
  version: 39,
  name: 'multimodal_dual_column_v0_27_1',
  // v0.27.1 multimodal ingestion. Three changes that travel together:
  //
  // 1. content_chunks gains `modality TEXT NOT NULL DEFAULT 'text'` so image
  //    chunks declare themselves at the row level. Search filters use it to
  //    keep image OCR text out of text-page keyword search by default.
  //
  // 2. content_chunks gains `embedding_image vector(1024)` for Voyage
  //    multimodal embeddings. NULL on every text row; sparse on the column.
  //    Partial HNSW index ignores NULL rows so the index footprint stays
  //    proportional to image chunk count, not table size. Mixed-provider
  //    brains (e.g. OpenAI 1536 text + Voyage 1024 images) can keep both
  //    columns populated with distinct dim spaces.
  //
  // 3. PGLite gains the `files` table (mirroring the Postgres v0.18 shape)
  //    so the multimodal ingest pipeline can persist binary-asset metadata
  //    on the default engine. Image bytes never enter the DB; storage_path
  //    references a path inside the brain repo. The v0.18 "PGLite has no
  //    files table" omission was specific to blob storage — for path-
  //    referenced metadata PGLite hosts it fine.
  //
  // Eng-3C: a preflight handler refuses if pgvector < 0.5, BEFORE any DDL
  // fires, so the user gets a clear upgrade hint instead of a half-migrated
  // brain mid-DDL. Postgres-only — PGLite ships pgvector built in.
  // Handler-driven migration. The preflight pgvector check (Eng-3C) MUST
  // run BEFORE any DDL fires; if we used `sqlFor` the runner would DDL
  // before calling the handler. So we keep `sql` empty and let the handler
  // run preflight + DDL in the right order.
  sql: '',
  handler: async (engine: BrainEngine) => {
    // Eng-3C: refuse loudly if pgvector < 0.5 BEFORE any DDL fires.
    // Partial HNSW indexes need HNSW (pgvector 0.5.0+). PGLite ships a
    // recent pgvector inside its WASM bundle so this gate is Postgres-only.
    if (engine.kind === 'postgres') {
      const rows = await engine.executeRaw<{ extversion: string }>(
        `SELECT extversion FROM pg_extension WHERE extname = 'vector'`
      );
      if (rows.length === 0) {
        throw new Error(
          `Migration v39 requires the pgvector extension. Install it via\n` +
          `  CREATE EXTENSION vector;\n` +
          `then re-run \`gbrain apply-migrations --yes\`.`
        );
      }
      const version = rows[0].extversion;
      const [maj, minStr] = version.split('.');
      const min = parseInt(minStr ?? '0', 10);
      const major = parseInt(maj ?? '0', 10);
      if (major === 0 && min < 5) {
        throw new Error(
          `Migration v39 requires pgvector >= 0.5.0 (HNSW partial indexes).\n` +
          `Found pgvector ${version}.\n\n` +
          `Fix: ALTER EXTENSION vector UPDATE; then re-run \`gbrain apply-migrations --yes\`.\n` +
          `If your Postgres provider doesn't ship pgvector >= 0.5, request\n` +
          `an upgrade or migrate to PGLite for v0.27.1 multimodal support.`
        );
      }
    }

    // Step 1: schema delta on content_chunks + widen pages.page_kind CHECK
    // to admit 'image'. Runs through engine.runMigration so multi-statement
    // DDL works on PGLite (db.exec) and Postgres (sql.unsafe).
    await engine.runMigration(39, `
        ALTER TABLE content_chunks
          ADD COLUMN IF NOT EXISTS modality TEXT NOT NULL DEFAULT 'text',
          ADD COLUMN IF NOT EXISTS embedding_image vector(1024);

        CREATE INDEX IF NOT EXISTS idx_chunks_embedding_image
          ON content_chunks USING hnsw (embedding_image vector_cosine_ops)
          WHERE embedding_image IS NOT NULL;

        -- Widen pages.page_kind CHECK to admit 'image'. The constraint name
        -- is auto-assigned by Postgres; locate + drop + recreate with the
        -- new value list. PGLite + Postgres share the same constraint shape.
        ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_page_kind_check;
        ALTER TABLE pages ADD CONSTRAINT pages_page_kind_check
          CHECK (page_kind IN ('markdown','code','image'));
      `);

    // Step 2: PGLite-only — add the files table that v0.18 deliberately
    // omitted. Postgres has had it since v0.18; this is parity catch-up.
    if (engine.kind === 'pglite') {
      await engine.runMigration(39, `
          CREATE TABLE IF NOT EXISTS files (
            id           SERIAL PRIMARY KEY,
            source_id    TEXT   NOT NULL DEFAULT 'default'
                         REFERENCES sources(id) ON DELETE CASCADE,
            page_slug    TEXT,
            page_id      INTEGER REFERENCES pages(id) ON DELETE SET NULL,
            filename     TEXT   NOT NULL,
            storage_path TEXT   NOT NULL,
            mime_type    TEXT,
            size_bytes   BIGINT,
            content_hash TEXT   NOT NULL,
            metadata     JSONB  NOT NULL DEFAULT '{}',
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE(storage_path)
          );

          CREATE INDEX IF NOT EXISTS idx_files_page ON files(page_slug);
          CREATE INDEX IF NOT EXISTS idx_files_page_id ON files(page_id);
          CREATE INDEX IF NOT EXISTS idx_files_source_id ON files(source_id);
          CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
        `);
    }
  },
};
