import type { Migration } from './types.ts';

export const v011: Migration = {
  version: 11,
  name: 'links_provenance_columns',
  // v0.13: adds provenance columns so frontmatter-derived edges can be
  // distinguished from markdown/manual edges. Reconciliation on put_page
  // scopes by (link_source='frontmatter' AND origin_page_id = written_page)
  // so edges from other pages never get mis-deleted.
  //
  // Unique constraint swaps: old (from, to, type) blocks coexistence of
  // markdown + frontmatter + manual edges with the same tuple. New tuple
  // includes link_source + origin_page_id.
  //
  // Existing rows keep link_source IS NULL (legacy marker) — they are NOT
  // backfilled to 'markdown' because existing rows may be manual/imported
  // /inferred; mislabeling them as markdown would corrupt provenance.
  //
  // Idempotent via IF NOT EXISTS / DROP IF EXISTS.
  sql: `
      -- Postgres version gate: UNIQUE NULLS NOT DISTINCT requires PG15+.
      -- PGLite ships PG17.5, current Supabase is PG15+. Old Supabase projects
      -- on PG14 hit an explicit error rather than half-applying (drop old
      -- constraint but fail to add new one → brain loses uniqueness guarantee).
      DO $$ BEGIN
        IF current_setting('server_version_num')::int < 150000 THEN
          RAISE EXCEPTION
            'v0.13 migration requires Postgres 15+. Current: %. '
            'Upgrade your Postgres (Supabase: migrate project to a newer PG major). '
            'This migration intentionally stops before touching the schema to preserve data integrity.',
            current_setting('server_version');
        END IF;
      END $$;

      ALTER TABLE links ADD COLUMN IF NOT EXISTS link_source TEXT;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'links_link_source_check'
        ) THEN
          ALTER TABLE links ADD CONSTRAINT links_link_source_check
            CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual'));
        END IF;
      END $$;
      ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_page_id INTEGER
        REFERENCES pages(id) ON DELETE SET NULL;
      ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_field TEXT;
      -- Backfill NULL link_source → 'markdown' for existing rows. Codex review
      -- caught that without this, pre-v0.13 legacy rows coexist with new
      -- 'markdown' writes under NULLS NOT DISTINCT (NULL ≠ 'markdown'),
      -- causing duplicate edges to accumulate. Treating legacy as markdown
      -- is the accurate best-guess: pre-v0.13 auto-link only emitted markdown
      -- edges. User-created 'manual' edges are a v0.13+ concept anyway.
      UPDATE links SET link_source = 'markdown' WHERE link_source IS NULL;
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_unique;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'links_from_to_type_source_origin_unique'
        ) THEN
          ALTER TABLE links ADD CONSTRAINT links_from_to_type_source_origin_unique
            UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id);
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_links_source ON links(link_source);
      CREATE INDEX IF NOT EXISTS idx_links_origin ON links(origin_page_id);
    `,
};
