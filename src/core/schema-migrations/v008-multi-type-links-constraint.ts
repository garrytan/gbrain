import type { Migration } from './types.ts';

// ── Knowledge graph layer (PR #188, originally proposed as v5/v6/v7 but
//    renumbered to v8/v9/v10 to land after the master Minions migrations).
//    Existing brains migrated against the original v5/v6/v7 names (in
//    branches that pre-dated the merge) get a no-op pass here because
//    every statement is idempotent.
export const v008: Migration = {
  version: 8,
  name: 'multi_type_links_constraint',
  // Idempotent for both upgrade and fresh-install paths.
  // Fresh installs already have links_from_to_type_unique from schema.sql; we drop it
  // (along with the legacy from-to-only constraint) before re-adding it cleanly.
  // Helper btree on the dedup columns turns the DELETE...USING self-join from O(n²)
  // into O(n log n). Without it, a brain with 80K+ duplicate link rows hits
  // Supabase Management API's 60s ceiling during upgrade.
  sql: `
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_page_id_to_page_id_key;
      ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_unique;
      CREATE INDEX IF NOT EXISTS idx_links_dedup_helper
        ON links(from_page_id, to_page_id, link_type);
      DELETE FROM links a USING links b
        WHERE a.from_page_id = b.from_page_id
          AND a.to_page_id = b.to_page_id
          AND a.link_type = b.link_type
          AND a.id > b.id;
      DROP INDEX IF EXISTS idx_links_dedup_helper;
      ALTER TABLE links ADD CONSTRAINT links_from_to_type_unique
        UNIQUE(from_page_id, to_page_id, link_type);
    `,
};
