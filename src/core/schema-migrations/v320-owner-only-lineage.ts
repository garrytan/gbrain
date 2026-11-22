import type { Migration } from './types.ts';
import { OWNER_ONLY_LINEAGE_FN } from '../access/owner-only.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Owner-only sources (access/owner-only.ts): gbrain_owner_only_lineage() answers whether the brain holds an owner-only
// source at all (the guard, planned as one Result node instead of a scan of sources), and gbrain_owner_only_lineage(table, id) answers whether the row (a page or a
// fact) is held in an owner-only source, is a synthesized concept or question with an input page there, or reaches a
// row there through its recorded derivation inputs (derivation_inputs, followed up to 8 hops). Every read policy that
// hides owner-only rows calls it behind one uncorrelated test of whether the brain has an owner-only source at all, so
// a brain without one never calls it, and the planner sees one function call instead of the lineage walk (planned
// inline, the walk doubled the read policy's planning time). The kinds and the flag repeat OWNER_ONLY_KINDS and
// OWNER_ONLY_FLAG (test/imessage-owner-only.test.ts keeps them equal). Nothing is stored per row and nothing is
// rewritten. COST 1: the guard keeps a brain without an owner-only source from ever calling it, so the planner must not
// charge the default 100 per row (that pushed a 500-page read past jit_above_cost). No schema.sql mirror: like v283, v285 and v305, the function exists only through migrations. Reads call it
// only at or above OWNER_ONLY_LINEAGE_SINCE (keep it equal to this version on a renumber) and run the walk inline below.
export const v320: Migration = {
  version: 320,
  name: 'owner_only_lineage',
  idempotent: true,
  sql: `
CREATE OR REPLACE FUNCTION ${OWNER_ONLY_LINEAGE_FN}(p_table TEXT, p_id BIGINT) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE COST 1 SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  owner_only TEXT[];
BEGIN
  SELECT array_agg(s.id) INTO owner_only FROM sources s WHERE s.config->>'kind' IN ('imessage') OR s.config->>'owner_only' = 'true';
  IF owner_only IS NULL OR p_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_table = 'pages' THEN
    IF EXISTS (SELECT 1 FROM pages p WHERE p.id = p_id AND p.source_id = ANY(owner_only)) THEN
      RETURN true;
    END IF;
    IF EXISTS (SELECT 1 FROM pages p JOIN links l ON l.from_page_id = p.id JOIN pages i ON i.id = l.to_page_id
        WHERE p.id = p_id AND p.type IN ('concept', 'question') AND l.link_source = 'concept-provenance'
          AND l.link_type = 'synthesized_from' AND i.source_id = ANY(owner_only)) THEN
      RETURN true;
    END IF;
  ELSIF p_table = 'facts' THEN
    IF EXISTS (SELECT 1 FROM facts f WHERE f.id = p_id AND f.source_id = ANY(owner_only)) THEN
      RETURN true;
    END IF;
  END IF;
  RETURN EXISTS (WITH RECURSIVE up(t, id, depth) AS (
      SELECT d.input_table, d.input_id, 1 FROM derivation_inputs d WHERE d.derived_table = p_table AND d.derived_id = p_id::text
      UNION SELECT d.input_table, d.input_id, up.depth + 1 FROM derivation_inputs d JOIN up ON d.derived_table = up.t AND d.derived_id = up.id
        WHERE up.depth < 8)
    SELECT 1 FROM up WHERE up.id ~ '^[0-9]{1,18}$' AND (
      (up.t = 'pages' AND EXISTS (SELECT 1 FROM pages ip WHERE ip.id = up.id::bigint AND ip.source_id = ANY(owner_only)))
      OR (up.t = 'facts' AND EXISTS (SELECT 1 FROM facts f WHERE f.id = up.id::bigint AND f.source_id = ANY(owner_only)))
      OR (up.t = 'takes' AND EXISTS (SELECT 1 FROM takes tk JOIN pages tp ON tp.id = tk.page_id WHERE tk.id = up.id::bigint AND tp.source_id = ANY(owner_only)))
      OR (up.t = 'timeline_entries' AND EXISTS (SELECT 1 FROM timeline_entries te JOIN pages tep ON tep.id = te.page_id WHERE te.id = up.id::bigint AND tep.source_id = ANY(owner_only)))));
END
$fn$;
CREATE OR REPLACE FUNCTION ${OWNER_ONLY_LINEAGE_FN}() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM sources s WHERE s.config->>'kind' IN ('imessage') OR s.config->>'owner_only' = 'true')
$fn$;
`,
};
