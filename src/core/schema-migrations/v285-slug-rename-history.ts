import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-218: rename history for folder-rule lineage. v283's lineage test follows
// an origin renamed since its derivative was written through slug_aliases, but
// a rename onto that old slug drops the alias (a live page owns the slug), so
// the derivative was then judged by the unrelated page that took the slug.
// slug_rename_history keeps every `old -> current` pair recordRenameAlias sees
// (rename, twin merge, phantom redirect), plus any alias a rename drops, and is
// repointed when the page moves again. Only gbrain_access_origin_restricted
// reads it; slug resolution never does. A slug a page once had keeps counting
// as that page's for lineage, so a derivative written against it stays under
// the page's rules even after another page takes the slug (it can only hide
// more). A purge removes the rows that point at the purged page.
// No schema.sql mirror: like v282 and v283, it exists only through migrations.
// Provisional number: renumbered at the merge slot.
export const v285: Migration = {
  version: 285,
  name: 'slug_rename_history',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS slug_rename_history (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  old_slug TEXT NOT NULL,
  new_slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, old_slug, new_slug)
);
CREATE INDEX IF NOT EXISTS slug_rename_history_new_idx ON slug_rename_history (source_id, new_slug);
CREATE OR REPLACE FUNCTION gbrain_access_origin_restricted(p_id INTEGER, p_source_id TEXT, p_type TEXT, fm JSONB) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF p_type = 'atom' THEN
    IF EXISTS (SELECT 1 FROM pages o WHERE o.source_id = p_source_id AND o.slug IN (SELECT fm->>'source_slug' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = p_source_id AND a.alias_slug = fm->>'source_slug'
          UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = p_source_id AND h.old_slug = fm->>'source_slug')
        AND (o.frontmatter ? 'readable_by' OR o.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(o.source_id, o.slug))) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'question' OR (p_type = 'concept' AND fm->>'synthesized_by' IS NOT NULL) THEN
    IF EXISTS (SELECT 1 FROM links l JOIN pages i ON i.id = l.to_page_id
        WHERE l.from_page_id = p_id AND l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from'
          AND (i.frontmatter ? 'readable_by' OR i.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(i.source_id, i.slug)
            OR EXISTS (SELECT 1 FROM pages io WHERE io.source_id = i.source_id
              AND io.slug IN (SELECT i.frontmatter->>'source_slug' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = i.source_id AND a.alias_slug = i.frontmatter->>'source_slug'
                UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = i.source_id AND h.old_slug = i.frontmatter->>'source_slug')
              AND (io.frontmatter ? 'readable_by' OR io.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(io.source_id, io.slug))))) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'event' AND fm->>'captured_via' LIKE 'life-chronicle:%' THEN
    IF EXISTS (SELECT 1 FROM pages c WHERE c.source_id = p_source_id AND c.slug IN (SELECT fm->'event'->>'depth' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = p_source_id AND a.alias_slug = fm->'event'->>'depth'
          UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = p_source_id AND h.old_slug = fm->'event'->>'depth')
        AND (c.frontmatter ? 'readable_by' OR c.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(c.source_id, c.slug))) THEN
      RETURN true;
    END IF;
  END IF;
  IF jsonb_typeof(fm->'derived_from') IN ('array', 'string') THEN
    RETURN EXISTS (SELECT 1 FROM pages d WHERE d.source_id = p_source_id
      AND (d.frontmatter ? 'readable_by' OR d.folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(d.source_id, d.slug))
      AND d.slug = ANY(ARRAY(WITH declared(slug) AS (SELECT regexp_replace(x, '\\.md$', '') FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(fm->'derived_from') = 'array' THEN fm->'derived_from' ELSE jsonb_build_array(fm->'derived_from') END) AS x)
        SELECT slug FROM declared UNION SELECT a.canonical_slug FROM slug_aliases a JOIN declared ON a.alias_slug = declared.slug WHERE a.source_id = p_source_id
        UNION SELECT h.new_slug FROM slug_rename_history h JOIN declared ON h.old_slug = declared.slug WHERE h.source_id = p_source_id)));
  END IF;
  RETURN false;
END
$fn$;
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE slug_rename_history ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
