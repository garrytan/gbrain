import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Three operator-set access designs (GBRA-108), all off on upgrade:
//
// Raw-only rules. access_rules.covers_derived (default true) is false for a folder or page rule whose pages are raw
// material (transcripts): the rule still keeps the pages it covers to its readers, but no longer closes the lineage of
// the pages and facts derived from them. gbrain_access_lineage_rules(source, rule ids) is the part of an origin's
// folder_rule_ids that closes lineage: every id except one naming a rule stored with covers_derived false, so a stamped
// id whose rule is gone keeps counting (fail closed); NULL when none is left. gbrain_access_origin_restricted (every
// caller; v285's arms and escaping) and gbrain_access_origin_closed_for (owner and member lineage; v304's) count only
// those ids. An origin's own readable_by and pending coverage close lineage as before.
//
// Audience members. access_members.kind ('person' by default, or 'audience': a group chat, a shared assistant). An
// owner read treats an audience member's own member page (memory/members/<id>) as if its readers named the owner, and
// the opt-in's member-page arm passes it, so gbrain_access_origin_closed_for and gbrain_access_origin_hidden_for take
// p_audience_pages (those page slugs; empty for every other caller). The v304 signatures stay as wrappers that pass
// none, so an older binary sharing the database keeps reading as before.
//
// Nothing is rewritten: every rule keeps covers_derived true and every member kind person, so every read is
// unchanged. No schema.sql mirror: like v283, v285 and v304, these exist only through migrations. Provisional number:
// renumbered at the merge slot.
const CLOSED = (o: string) => `gbrain_access_origin_closed_for(${o}.source_id, ${o}.slug, ${o}.frontmatter, ${o}.page_readers, ${o}.folder_rule_ids, p_identity, p_satisfied, p_open, p_own_page, p_audience_pages)`;
const RESTRICTED = (o: string) => `(${o}.frontmatter ? 'readable_by' OR gbrain_access_lineage_rules(${o}.source_id, ${o}.folder_rule_ids) IS NOT NULL OR gbrain_access_pending_covers(${o}.source_id, ${o}.slug))`;

export const v305: Migration = {
  version: 305,
  name: 'access_lineage_designs',
  idempotent: true,
  sql: `
ALTER TABLE access_rules ADD COLUMN IF NOT EXISTS covers_derived BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE access_members ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'person';
ALTER TABLE access_members DROP CONSTRAINT IF EXISTS access_members_kind_check;
ALTER TABLE access_members ADD CONSTRAINT access_members_kind_check CHECK (kind IN ('person', 'audience'));
CREATE OR REPLACE FUNCTION gbrain_access_lineage_rules(p_source TEXT, p_rules TEXT[]) RETURNS TEXT[]
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT CASE WHEN p_rules IS NULL THEN NULL ELSE (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(p_rules) AS x
    WHERE NOT EXISTS (SELECT 1 FROM access_rules r WHERE r.source_id = p_source AND x = p_source || ':' || r.rule_id AND NOT r.covers_derived)) END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_origin_restricted(p_id INTEGER, p_source_id TEXT, p_type TEXT, fm JSONB) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF p_type = 'atom' THEN
    IF EXISTS (SELECT 1 FROM pages o WHERE o.source_id = p_source_id AND o.slug IN (SELECT fm->>'source_slug' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = p_source_id AND a.alias_slug = fm->>'source_slug'
          UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = p_source_id AND h.old_slug = fm->>'source_slug')
        AND ${RESTRICTED('o')}) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'question' OR (p_type = 'concept' AND fm->>'synthesized_by' IS NOT NULL) THEN
    IF EXISTS (SELECT 1 FROM links l JOIN pages i ON i.id = l.to_page_id
        WHERE l.from_page_id = p_id AND l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from'
          AND (${RESTRICTED('i')}
            OR EXISTS (SELECT 1 FROM pages io WHERE io.source_id = i.source_id
              AND io.slug IN (SELECT i.frontmatter->>'source_slug' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = i.source_id AND a.alias_slug = i.frontmatter->>'source_slug'
                UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = i.source_id AND h.old_slug = i.frontmatter->>'source_slug')
              AND ${RESTRICTED('io')}))) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'event' AND fm->>'captured_via' LIKE 'life-chronicle:%' THEN
    IF EXISTS (SELECT 1 FROM pages c WHERE c.source_id = p_source_id AND c.slug IN (SELECT fm->'event'->>'depth' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = p_source_id AND a.alias_slug = fm->'event'->>'depth'
          UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = p_source_id AND h.old_slug = fm->'event'->>'depth')
        AND ${RESTRICTED('c')}) THEN
      RETURN true;
    END IF;
  END IF;
  IF jsonb_typeof(fm->'derived_from') IN ('array', 'string') THEN
    RETURN EXISTS (SELECT 1 FROM pages d WHERE d.source_id = p_source_id
      AND ${RESTRICTED('d')}
      AND d.slug = ANY(ARRAY(WITH declared(slug) AS (SELECT regexp_replace(x, '\\.md$', '') FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(fm->'derived_from') = 'array' THEN fm->'derived_from' ELSE jsonb_build_array(fm->'derived_from') END) AS x)
        SELECT slug FROM declared UNION SELECT a.canonical_slug FROM slug_aliases a JOIN declared ON a.alias_slug = declared.slug WHERE a.source_id = p_source_id
        UNION SELECT h.new_slug FROM slug_rename_history h JOIN declared ON h.old_slug = declared.slug WHERE h.source_id = p_source_id)));
  END IF;
  RETURN false;
END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_origin_closed_for(o_source TEXT, o_slug TEXT, o_frontmatter JSONB, o_readers TEXT[], o_rules TEXT[],
    p_identity TEXT[], p_satisfied TEXT[], p_open BOOLEAN, p_own_page TEXT, p_audience_pages TEXT[]) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT gbrain_access_pending_covers(o_source, o_slug)
    OR ((NOT p_open OR (starts_with(o_slug, 'memory/members/') AND o_slug IS DISTINCT FROM p_own_page AND NOT COALESCE(o_slug = ANY(p_audience_pages), false)))
      AND NOT (((o_readers IS NULL AND NOT (o_frontmatter ? 'readable_by')) OR COALESCE(o_readers && p_identity, false) OR COALESCE(o_slug = ANY(p_audience_pages), false))
        AND (o_rules IS NULL OR o_rules <@ p_satisfied OR COALESCE(gbrain_access_lineage_rules(o_source, o_rules) <@ p_satisfied, true))))
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_origin_hidden_for(p_id INTEGER, p_source_id TEXT, p_type TEXT, fm JSONB,
    p_identity TEXT[], p_satisfied TEXT[], p_open BOOLEAN, p_own_page TEXT, p_audience_pages TEXT[]) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF p_type = 'atom' THEN
    IF EXISTS (SELECT 1 FROM pages o WHERE o.source_id = p_source_id AND o.slug IN (SELECT fm->>'source_slug' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = p_source_id AND a.alias_slug = fm->>'source_slug'
          UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = p_source_id AND h.old_slug = fm->>'source_slug')
        AND ${CLOSED('o')}) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'question' OR (p_type = 'concept' AND fm->>'synthesized_by' IS NOT NULL) THEN
    IF EXISTS (SELECT 1 FROM links l JOIN pages i ON i.id = l.to_page_id
        WHERE l.from_page_id = p_id AND l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from'
          AND (${CLOSED('i')}
            OR EXISTS (SELECT 1 FROM pages io WHERE io.source_id = i.source_id
              AND io.slug IN (SELECT i.frontmatter->>'source_slug' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = i.source_id AND a.alias_slug = i.frontmatter->>'source_slug'
                UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = i.source_id AND h.old_slug = i.frontmatter->>'source_slug')
              AND ${CLOSED('io')}))) THEN
      RETURN true;
    END IF;
  ELSIF p_type = 'event' AND fm->>'captured_via' LIKE 'life-chronicle:%' THEN
    IF EXISTS (SELECT 1 FROM pages c WHERE c.source_id = p_source_id AND c.slug IN (SELECT fm->'event'->>'depth' UNION SELECT a.canonical_slug FROM slug_aliases a WHERE a.source_id = p_source_id AND a.alias_slug = fm->'event'->>'depth'
          UNION SELECT h.new_slug FROM slug_rename_history h WHERE h.source_id = p_source_id AND h.old_slug = fm->'event'->>'depth')
        AND ${CLOSED('c')}) THEN
      RETURN true;
    END IF;
  END IF;
  IF jsonb_typeof(fm->'derived_from') IN ('array', 'string') THEN
    RETURN EXISTS (SELECT 1 FROM pages d WHERE d.source_id = p_source_id
      AND ${CLOSED('d')}
      AND d.slug = ANY(ARRAY(WITH declared(slug) AS (SELECT regexp_replace(x, '\\.md$', '') FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(fm->'derived_from') = 'array' THEN fm->'derived_from' ELSE jsonb_build_array(fm->'derived_from') END) AS x)
        SELECT slug FROM declared UNION SELECT a.canonical_slug FROM slug_aliases a JOIN declared ON a.alias_slug = declared.slug WHERE a.source_id = p_source_id
        UNION SELECT h.new_slug FROM slug_rename_history h JOIN declared ON h.old_slug = declared.slug WHERE h.source_id = p_source_id)));
  END IF;
  RETURN false;
END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_origin_closed_for(o_source TEXT, o_slug TEXT, o_frontmatter JSONB, o_readers TEXT[], o_rules TEXT[],
    p_identity TEXT[], p_satisfied TEXT[], p_open BOOLEAN, p_own_page TEXT) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT gbrain_access_origin_closed_for(o_source, o_slug, o_frontmatter, o_readers, o_rules, p_identity, p_satisfied, p_open, p_own_page, ARRAY[]::text[])
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_origin_hidden_for(p_id INTEGER, p_source_id TEXT, p_type TEXT, fm JSONB,
    p_identity TEXT[], p_satisfied TEXT[], p_open BOOLEAN, p_own_page TEXT) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT gbrain_access_origin_hidden_for(p_id, p_source_id, p_type, fm, p_identity, p_satisfied, p_open, p_own_page, ARRAY[]::text[])
$fn$;
`,
};
