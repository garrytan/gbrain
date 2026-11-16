import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-108 design 1, the labelled-only grant (operator-set, off on upgrade):
//
// access_members.labelled_only (default false). A credential bound to a member that carries it reads only pages that
// name that member: its id or one of its groups in readable_by, or a folder or page rule listing it
// (search/private-visibility.ts labelledOnlySql). It lives on the member, so every token, OAuth client and stdio binding
// of that member inherits it and no second credential can forget it.
//
// gbrain_access_origin_labelled_for(page, identity, satisfied rules) is the lineage arm: under
// access.members_read_lineage a derived page with no label of its own passes only when it has an origin and every
// origin names the caller. The origins are v305's (an atom's source page, a synthesized concept's or question's inputs,
// an input atom's own origin, a Life Chronicle event's meeting, a declared derived_from page; aliases and renames
// followed). No origin found, a declared derived_from that resolves to nothing, or one origin that names someone else
// returns false (fail closed). The ordinary lineage rule (gbrain_access_origin_hidden_for) still applies on top.
//
// Nothing is rewritten: every member keeps labelled_only false, so every read is unchanged. No schema.sql mirror: like
// v283, v285, v304 and v305, these exist only through migrations. Provisional number: renumbered at the merge slot.
const LABELLED = (o: string) => `(COALESCE(${o}.page_readers && p_identity, false) OR COALESCE(${o}.folder_rule_ids && p_satisfied, false))`;
const RESOLVED = (source: string, slug: string) => `SELECT ${slug} UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = ${source} AND a.alias_slug = ${slug}
          UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = ${source} AND h.old_slug = ${slug}`;
const DECLARED = `jsonb_array_elements_text(CASE WHEN jsonb_typeof(fm->'derived_from') = 'array' THEN fm->'derived_from' ELSE jsonb_build_array(fm->'derived_from') END)`;

export const v308: Migration = {
  version: 308,
  name: 'access_labelled_only',
  idempotent: true,
  sql: `
ALTER TABLE access_members ADD COLUMN IF NOT EXISTS labelled_only BOOLEAN NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION gbrain_access_origin_labelled_for(p_id INTEGER, p_source_id TEXT, p_type TEXT, fm JSONB,
    p_identity TEXT[], p_satisfied TEXT[]) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  found boolean := false;
BEGIN
  IF p_type = 'atom' THEN
    IF NOT EXISTS (SELECT 1 FROM pages o WHERE o.source_id = p_source_id AND o.slug IN (${RESOLVED('p_source_id', "fm->>'source_slug'")}))
      OR EXISTS (SELECT 1 FROM pages o WHERE o.source_id = p_source_id AND o.slug IN (${RESOLVED('p_source_id', "fm->>'source_slug'")}) AND NOT ${LABELLED('o')}) THEN
      RETURN false;
    END IF;
    found := true;
  ELSIF p_type = 'question' OR (p_type = 'concept' AND fm->>'synthesized_by' IS NOT NULL) THEN
    IF NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p_id AND l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from')
      OR EXISTS (SELECT 1 FROM links l JOIN pages i ON i.id = l.to_page_id
        WHERE l.from_page_id = p_id AND l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from'
          AND NOT ${LABELLED('i')}
          AND NOT (i.type = 'atom'
            AND EXISTS (SELECT 1 FROM pages io WHERE io.source_id = i.source_id AND io.slug IN (${RESOLVED('i.source_id', "i.frontmatter->>'source_slug'")}))
            AND NOT EXISTS (SELECT 1 FROM pages io WHERE io.source_id = i.source_id AND io.slug IN (${RESOLVED('i.source_id', "i.frontmatter->>'source_slug'")}) AND NOT ${LABELLED('io')}))) THEN
      RETURN false;
    END IF;
    found := true;
  ELSIF p_type = 'event' AND fm->>'captured_via' LIKE 'life-chronicle:%' THEN
    IF NOT EXISTS (SELECT 1 FROM pages c WHERE c.source_id = p_source_id AND c.slug IN (${RESOLVED('p_source_id', "fm->'event'->>'depth'")}))
      OR EXISTS (SELECT 1 FROM pages c WHERE c.source_id = p_source_id AND c.slug IN (${RESOLVED('p_source_id', "fm->'event'->>'depth'")}) AND NOT ${LABELLED('c')}) THEN
      RETURN false;
    END IF;
    found := true;
  END IF;
  IF jsonb_typeof(fm->'derived_from') IN ('array', 'string') THEN
    IF NOT EXISTS (SELECT 1 FROM ${DECLARED})
      OR EXISTS (SELECT 1 FROM (SELECT regexp_replace(x, '\\.md$', '') AS slug FROM ${DECLARED} AS x) declared
        WHERE NOT EXISTS (SELECT 1 FROM pages d WHERE d.source_id = p_source_id AND d.slug IN (${RESOLVED('p_source_id', 'declared.slug')}))
          OR EXISTS (SELECT 1 FROM pages d WHERE d.source_id = p_source_id AND d.slug IN (${RESOLVED('p_source_id', 'declared.slug')}) AND NOT ${LABELLED('d')})) THEN
      RETURN false;
    END IF;
    found := true;
  END IF;
  RETURN found;
END
$fn$;
`,
};
