import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-2490 (G6 of GST-2476): the owner opt-in (config access.owner_reads_restricted). Derived pages (an atom, a
// synthesized concept or question, a Life Chronicle event, a derived_from page) of an origin that names readers or sits
// under a folder or page rule are hidden from every remote caller by gbrain_access_origin_restricted (v282, v283, v285),
// the brain owner included, even when the readers or the rule name the owner. With the opt-in on, an owner read uses
// gbrain_access_origin_hidden_from_owner instead: the same arms, but an origin hides its derivatives only when it is
// another member's own member page (memory/members/<id>, the owner's own excluded) or reads as nobody (pending
// coverage). The per-origin test is one function, gbrain_access_origin_closed_to_owner, so a later rule (say, "a caller
// reads a derivative when it reads every origin") swaps that test and keeps the arms. Nothing is rewritten and
// gbrain_access_origin_restricted is untouched, so every other caller reads exactly as before. No schema.sql mirror:
// like v282, v283 and v285, these exist only through migrations. Provisional number: renumbered at the merge slot.
export const v304: Migration = {
  version: 304,
  name: 'access_owner_origin',
  idempotent: true,
  sql: `
CREATE OR REPLACE FUNCTION gbrain_access_origin_closed_to_owner(o_source TEXT, o_slug TEXT, p_owner_page TEXT) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT (starts_with(o_slug, 'memory/members/') AND o_slug IS DISTINCT FROM p_owner_page) OR gbrain_access_pending_covers(o_source, o_slug)
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_origin_hidden_from_owner(p_id INTEGER, p_source_id TEXT, p_type TEXT, fm JSONB, p_owner_page TEXT) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF p_type = 'atom' THEN
    IF EXISTS (SELECT 1 FROM pages o WHERE o.source_id = p_source_id AND o.slug IN (SELECT fm->>'source_slug' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = p_source_id AND a.alias_slug = fm->>'source_slug'
          UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = p_source_id AND h.old_slug = fm->>'source_slug')
        AND gbrain_access_origin_closed_to_owner(o.source_id, o.slug, p_owner_page)) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'question' OR (p_type = 'concept' AND fm->>'synthesized_by' IS NOT NULL) THEN
    IF EXISTS (SELECT 1 FROM links l JOIN pages i ON i.id = l.to_page_id
        WHERE l.from_page_id = p_id AND l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from'
          AND (gbrain_access_origin_closed_to_owner(i.source_id, i.slug, p_owner_page)
            OR EXISTS (SELECT 1 FROM pages io WHERE io.source_id = i.source_id
              AND io.slug IN (SELECT i.frontmatter->>'source_slug' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = i.source_id AND a.alias_slug = i.frontmatter->>'source_slug'
                UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = i.source_id AND h.old_slug = i.frontmatter->>'source_slug')
              AND gbrain_access_origin_closed_to_owner(io.source_id, io.slug, p_owner_page)))) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'event' AND fm->>'captured_via' LIKE 'life-chronicle:%' THEN
    IF EXISTS (SELECT 1 FROM pages c WHERE c.source_id = p_source_id AND c.slug IN (SELECT fm->'event'->>'depth' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = p_source_id AND a.alias_slug = fm->'event'->>'depth'
          UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = p_source_id AND h.old_slug = fm->'event'->>'depth')
        AND gbrain_access_origin_closed_to_owner(c.source_id, c.slug, p_owner_page)) THEN
      RETURN true;
    END IF;
  END IF;
  IF jsonb_typeof(fm->'derived_from') IN ('array', 'string') THEN
    RETURN EXISTS (SELECT 1 FROM pages d WHERE d.source_id = p_source_id
      AND gbrain_access_origin_closed_to_owner(d.source_id, d.slug, p_owner_page)
      AND d.slug = ANY(ARRAY(WITH declared(slug) AS (SELECT regexp_replace(x, '\\.md$', '') FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(fm->'derived_from') = 'array' THEN fm->'derived_from' ELSE jsonb_build_array(fm->'derived_from') END) AS x)
        SELECT slug FROM declared UNION SELECT a.canonical_slug FROM slug_aliases a JOIN declared ON a.alias_slug = declared.slug WHERE a.source_id = p_source_id
        UNION SELECT h.new_slug FROM slug_rename_history h JOIN declared ON h.old_slug = declared.slug WHERE h.source_id = p_source_id)));
  END IF;
  RETURN false;
END
$fn$;
`,
};
