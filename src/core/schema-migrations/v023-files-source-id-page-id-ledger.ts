import type { Migration } from './types.ts';

export const v023: Migration = {
  version: 23,
  name: 'files_source_id_page_id_ledger',
  // v0.18.0 Step 7 (Lane E) — additive only: adds files.source_id and
  // files.page_id columns + creates the file_migration_ledger that
  // drives phase-B storage object rewrites. Does NOT drop page_slug
  // yet (kept for backward compat; a later release cleans up once the
  // page_id FK is proven). PGLite has no files table, so this
  // migration is Postgres-only via a handler gate.
  //
  // Ledger PK is file_id (not storage_path_old) — two sources CAN
  // share an old path during migration, so a composite would be
  // wrong. Codex second-pass review caught this.
  //
  // State machine per row:
  //   pending → copy_done → db_updated → complete
  //   any state → failed (with error detail)
  //
  // Phase B in the v0_18_0 orchestrator processes `status != complete`
  // rows. Re-runnable: resumes from whichever state it stopped in.
  sql: '',
  handler: async (engine) => {
    if (engine.kind === 'pglite') return;

    // Atomic: FK drop + UNIQUE swap + files.page_id addition +
    // backfill + ledger, all in one transaction. Closes the
    // pre-v23 integrity window where files_page_slug_fkey was
    // dropped in v21 but the replacement files.page_id didn't
    // exist until v23 ran — process death in between left files
    // unconstrained while file_upload kept writing (codex finding).
    //
    // Rollback scenarios:
    //   - Die mid-transaction → Postgres rolls back, files_page_slug_fkey
    //     still exists, config.version stays at 22. Retry restarts cleanly.
    //   - Die after commit but before setConfig(version=23) → all DDL
    //     committed, config.version still 22, retry re-runs everything
    //     with IF NOT EXISTS / NOT EXISTS guards idempotently.
    await engine.transaction(async (tx) => {
      // 0a. Drop files_page_slug_fkey (deferred from v21 to keep
      //     the FK intact across v21/v22 and remove it inside the
      //     same txn that adds the replacement page_id path).
      //     Guard against PGLite just in case (already returned above).
      await tx.runMigration(23, `
          DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'files') THEN
              ALTER TABLE files DROP CONSTRAINT IF EXISTS files_page_slug_fkey;
            END IF;
          END $$;
        `);

      // 0b. Swap pages.UNIQUE(slug) → UNIQUE(source_id, slug).
      //     Deferred from v21 so PR #356 closes the integrity
      //     window. PGLite already did this swap in its v21 path.
      //     #550: guard by index SHAPE (any non-partial unique index on
      //     exactly {source_id, slug}), not by constraint NAME — a
      //     name-only guard skips the ADD when the name is squatted by a
      //     misshapen constraint, leaving every putPage ON CONFLICT broken.
      await tx.runMigration(23, `
          ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_slug_key;
          DO $$ BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_index i
               WHERE i.indrelid = 'pages'::regclass
                 AND i.indisunique
                 AND i.indpred IS NULL
                 AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                        FROM pg_attribute a
                       WHERE a.attrelid = i.indrelid
                         AND a.attnum = ANY (i.indkey::int2[])) = ARRAY['slug','source_id']
            ) THEN
              ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
              ALTER TABLE pages ADD CONSTRAINT pages_source_slug_key
                UNIQUE (source_id, slug);
            END IF;
          END $$;
        `);

      // 1a. source_id with DEFAULT 'default' (idempotent)
      await tx.runMigration(23, `
          ALTER TABLE files ADD COLUMN IF NOT EXISTS source_id TEXT
            NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;
          CREATE INDEX IF NOT EXISTS idx_files_source_id ON files(source_id);

          -- 1a'. Defensive FK repair. ALTER TABLE ADD COLUMN IF NOT EXISTS is a
          --      no-op when the column already exists, so the inline FK never
          --      re-adds. Some test paths (notably postgres-bootstrap.test.ts)
          --      drop the sources table CASCADE which removes
          --      files_source_id_fkey while leaving files.source_id intact.
          --      Without this block the FK would never come back on upgrade,
          --      and CASCADE-on-source-delete silently stops working.
          DO $$ BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'files_source_id_fkey'
                AND conrelid = 'files'::regclass
            ) THEN
              ALTER TABLE files
                ADD CONSTRAINT files_source_id_fkey
                FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE;
            END IF;
          END $$;

          -- 1b. page_id (nullable; pre-v0.17 files pointed at page_slug
          --     which was ON DELETE SET NULL, so we keep the same nullable
          --     semantic — orphaned files are legal).
          ALTER TABLE files ADD COLUMN IF NOT EXISTS page_id INTEGER
            REFERENCES pages(id) ON DELETE SET NULL;
          CREATE INDEX IF NOT EXISTS idx_files_page_id ON files(page_id);
        `);

      // 1c. Backfill page_id from existing page_slug. Scoped to
      //     source_id='default' because pre-v0.17 pages ALL lived in
      //     the default source. Without this scope, after new sources
      //     get added mid-migration, the JOIN could hit the wrong
      //     page (different source, same slug).
      await tx.runMigration(23, `
          UPDATE files f
             SET page_id = p.id
            FROM pages p
           WHERE f.page_slug = p.slug
             AND p.source_id = 'default'
             AND f.page_id IS NULL;
        `);

      // 2. file_migration_ledger — drives the storage object rewrite
      //    in the v0_18_0 orchestrator's phase B. Seeded from current
      //    files rows; re-seed is idempotent via NOT EXISTS guard.
      await tx.runMigration(23, `
          CREATE TABLE IF NOT EXISTS file_migration_ledger (
            file_id           INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
            storage_path_old  TEXT   NOT NULL,
            storage_path_new  TEXT   NOT NULL,
            status            TEXT   NOT NULL DEFAULT 'pending',
            error             TEXT,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT chk_ledger_status CHECK (status IN ('pending','copy_done','db_updated','complete','failed'))
          );
          CREATE INDEX IF NOT EXISTS idx_file_migration_ledger_status
            ON file_migration_ledger(status) WHERE status != 'complete';

          -- Seed the ledger with every existing file. New path prefixes
          -- source_id so multi-source can land assets under their own
          -- bucket path without collision.
          INSERT INTO file_migration_ledger (file_id, storage_path_old, storage_path_new, status)
          SELECT
            f.id,
            f.storage_path,
            COALESCE(f.source_id, 'default') || '/' || f.storage_path,
            'pending'
          FROM files f
          WHERE NOT EXISTS (
            SELECT 1 FROM file_migration_ledger l WHERE l.file_id = f.id
          );
        `);
    });
  },
};
