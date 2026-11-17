import type { Migration } from './types.ts';

export const v021: Migration = {
  version: 21,
  name: 'pages_source_id_composite_unique',
  // v0.18.0 Step 2 (Lane B) — adds pages.source_id. Engine-split after
  // codex caught the pre-v23 integrity window:
  //
  //   Original v21 dropped files_page_slug_fkey and swapped
  //   UNIQUE(slug) → UNIQUE(source_id, slug) in one go. Between v21
  //   committing and v23 (which adds the replacement files.page_id
  //   path), a process-death left files WITHOUT any FK to pages
  //   while file_upload / `gbrain files` kept accepting writes.
  //
  // On Postgres: additive-only here. The FK drop + UNIQUE swap move
  // into v23's handler (wrapped in engine.transaction) so they commit
  // atomically with the files.page_id addition + backfill. See v23.
  //
  // On PGLite: no concurrent writers, no pool, no partial-state risk.
  // Do the full add + swap here so PGLite brains reach the composite
  // unique immediately (PGLite has no files table, so no FK drop
  // needed).
  //
  // DEFAULT 'default' on source_id is load-bearing: closes the race
  // where an INSERT between ADD COLUMN and SET NOT NULL could leave
  // source_id NULL. The default already references a valid sources
  // row (seeded in v16), so new INSERTs immediately get a valid FK.
  sql: '',
  sqlFor: {
    postgres: `
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_id TEXT
          NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;

        CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
      `,
    pglite: `
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_id TEXT
          NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;

        CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);

        ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_slug_key;
        -- #550: guard by index SHAPE, not constraint NAME (see v23 twin).
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
      `,
  },
};
