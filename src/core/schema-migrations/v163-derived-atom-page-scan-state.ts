import type { Migration } from './types.ts';

export const v163: Migration = {
  version: 163,
  name: 'derived_atom_page_scan_state',
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS extract_atoms_page_state (
        source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        fail_count INTEGER NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
        tombstoned BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (source_incarnation, page_id, content_hash)
      );
      CREATE INDEX IF NOT EXISTS extract_atoms_page_state_tombstoned_idx
        ON extract_atoms_page_state (source_incarnation, content_hash, page_id) WHERE tombstoned;
      CREATE INDEX IF NOT EXISTS extract_atoms_page_state_page_idx ON extract_atoms_page_state (page_id);
      CREATE OR REPLACE FUNCTION gbrain_clear_atom_page_state() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
      BEGIN
        IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
          DELETE FROM extract_atoms_page_state WHERE page_id=OLD.id;
        END IF;
        RETURN NEW;
      END $fn$;
      DROP TRIGGER IF EXISTS pages_clear_atom_scan_state ON pages;
      CREATE TRIGGER pages_clear_atom_scan_state AFTER UPDATE ON pages
        FOR EACH ROW EXECUTE FUNCTION gbrain_clear_atom_page_state();
      INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned)
        SELECT s.incarnation, p.id, p.content_hash,
          CASE WHEN p.frontmatter ? 'atoms_fail_count' THEN (p.frontmatter->>'atoms_fail_count')::integer ELSE 0 END,
          COALESCE(p.frontmatter->>'atoms_scan_hash'=substring(p.content_hash from 1 for 16), false)
        FROM pages p JOIN sources s ON s.id=p.source_id
        WHERE p.deleted_at IS NULL AND p.content_hash ~ '^[0-9a-f]{64}$'
          AND p.frontmatter ?| ARRAY['atoms_scan_hash','atoms_fail_hash','atoms_fail_count']
          AND (NOT (p.frontmatter ? 'atoms_scan_hash') OR
            (jsonb_typeof(p.frontmatter->'atoms_scan_hash')='string'
             AND p.frontmatter->>'atoms_scan_hash'=substring(p.content_hash from 1 for 16)))
          AND (NOT (p.frontmatter ?| ARRAY['atoms_fail_hash','atoms_fail_count']) OR
            (jsonb_typeof(p.frontmatter->'atoms_fail_hash')='string'
             AND p.frontmatter->>'atoms_fail_hash'=substring(p.content_hash from 1 for 16)
             AND CASE WHEN jsonb_typeof(p.frontmatter->'atoms_fail_count')='number'
               AND p.frontmatter->>'atoms_fail_count' ~ '^[1-9][0-9]{0,9}$'
               THEN (p.frontmatter->>'atoms_fail_count')::numeric <= 2147483647 ELSE false END))
        ON CONFLICT (source_incarnation, page_id, content_hash) DO NOTHING;
      DO $rls$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolbypassrls) THEN
          ALTER TABLE extract_atoms_page_state ENABLE ROW LEVEL SECURITY;
        END IF;
      END $rls$;
    `,
};
