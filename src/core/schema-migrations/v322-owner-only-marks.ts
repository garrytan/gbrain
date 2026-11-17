import type { Migration } from './types.ts';
import { OWNER_ONLY_LINEAGE_FN } from '../access/owner-only.ts';
import { ownerOnlyTriggersLeftLine } from '../access/owner-only-marks.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-3032: owner-only lineage outlives its origin. v320 decides at read time whether a row is owner-only by following it
// to a row held in an owner-only source, so deleting the origin (removing the source, or hard-deleting the page, fact,
// take or timeline row) dropped the restriction from every row derived from it. owner_only_marks records those derived
// rows at the moment their origin goes: a BEFORE DELETE trigger on sources (an owner-only source, before its rows cascade)
// and on pages, facts, takes and timeline_entries (a row that is owner-only, or whose page is) walks derivation_inputs
// down from the deleted rows to the end of the chain, and the synthesized concepts and questions that name a deleted
// page, and marks each one. Nothing derived is deleted or rewritten; a mark only ever narrows who reads a row.
// gbrain_owner_only_lineage(table, id) now answers true for a marked row and for a row whose recorded inputs reach one or
// reach a row in an owner-only source, at any depth (v320 stopped at 8 hops, so a row nine derivations away read as
// open); both walks are cycle-safe because UNION keeps each (table, id) once. gbrain_owner_only_lineage() answers true
// while any mark exists, so the guard stays on after the last owner-only source is removed.
//
// The triggers are created by the handler (BrainEngine.ownerOnlyMarkTriggers), which every migration run repeats: a table
// another role owns is named on stderr and by doctor (owner_only_marks_triggers) with its owner fix, never an abort.
// While a trigger is missing on a brain that holds an owner-only source or a mark, the unguarded mark ('*', 'unguarded')
// closes owner-only lineage: every row with a recorded derivation input and every synthesized concept or question counts
// as owner-only. It stays until the owner clears it, because a delete in the gap left no marks. The kinds and the flag
// repeat OWNER_ONLY_KINDS and OWNER_ONLY_FLAG (the owner-only tests keep them equal). A brain that never held an
// owner-only source pays one guard read per deleted row and stores nothing. No schema.sql mirror, like v320: the table
// and the functions exist only through migrations.
const OWNER_ONLY_SOURCE = `config->>'kind' IN ('imessage') OR config->>'owner_only' = 'true'`;

export const v322: Migration = {
  version: 322,
  name: 'owner_only_marks',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS owner_only_marks (
  row_table TEXT NOT NULL,
  row_id TEXT NOT NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (row_table, row_id)
);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE owner_only_marks ENABLE ROW LEVEL SECURITY;
  END IF;
  -- Marks hold no content and only narrow reads: any role a grant lets read or add them sees and adds every one (so RLS
  -- never reads them empty), and none but the owner removes one.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'owner_only_marks' AND policyname = 'owner_only_marks_read') THEN
    CREATE POLICY owner_only_marks_read ON owner_only_marks FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'owner_only_marks' AND policyname = 'owner_only_marks_add') THEN
    CREATE POLICY owner_only_marks_add ON owner_only_marks FOR INSERT WITH CHECK (true);
  END IF;
END $rls$;
CREATE OR REPLACE FUNCTION ${OWNER_ONLY_LINEAGE_FN}(p_table TEXT, p_id BIGINT) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE COST 1 SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  owner_only TEXT[];
BEGIN
  IF p_id IS NULL THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM owner_only_marks m WHERE m.row_table = p_table AND m.row_id = p_id::text) THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM owner_only_marks m WHERE m.row_table = '*') AND (
      EXISTS (SELECT 1 FROM derivation_inputs d WHERE d.derived_table = p_table AND d.derived_id = p_id::text)
      OR (p_table = 'pages' AND EXISTS (SELECT 1 FROM pages p WHERE p.id = p_id AND p.type IN ('concept', 'question')))) THEN
    RETURN true;
  END IF;
  SELECT coalesce(array_agg(s.id), '{}') INTO owner_only FROM sources s WHERE ${OWNER_ONLY_SOURCE.replace(/config/g, 's.config')};
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
  RETURN EXISTS (WITH RECURSIVE up(t, id) AS (
      SELECT d.input_table, d.input_id FROM derivation_inputs d WHERE d.derived_table = p_table AND d.derived_id = p_id::text
      UNION SELECT d.input_table, d.input_id FROM derivation_inputs d JOIN up ON d.derived_table = up.t AND d.derived_id = up.id)
    SELECT 1 FROM up WHERE EXISTS (SELECT 1 FROM owner_only_marks m WHERE m.row_table = up.t AND m.row_id = up.id) OR (up.id ~ '^[0-9]{1,18}$' AND (
      (up.t = 'pages' AND EXISTS (SELECT 1 FROM pages ip WHERE ip.id = up.id::bigint AND ip.source_id = ANY(owner_only)))
      OR (up.t = 'facts' AND EXISTS (SELECT 1 FROM facts f WHERE f.id = up.id::bigint AND f.source_id = ANY(owner_only)))
      OR (up.t = 'takes' AND EXISTS (SELECT 1 FROM takes tk JOIN pages tp ON tp.id = tk.page_id WHERE tk.id = up.id::bigint AND tp.source_id = ANY(owner_only)))
      OR (up.t = 'timeline_entries' AND EXISTS (SELECT 1 FROM timeline_entries te JOIN pages tep ON tep.id = te.page_id WHERE te.id = up.id::bigint AND tep.source_id = ANY(owner_only))))));
END
$fn$;
CREATE OR REPLACE FUNCTION ${OWNER_ONLY_LINEAGE_FN}() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM sources s WHERE ${OWNER_ONLY_SOURCE.replace(/config/g, 's.config')}) OR EXISTS (SELECT 1 FROM owner_only_marks)
$fn$;
CREATE OR REPLACE FUNCTION gbrain_owner_only_mark_derived(p_table TEXT, p_ids BIGINT[]) RETURNS void
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;
  WITH RECURSIVE seed(t, id) AS (
      SELECT p_table, x::text FROM unnest(p_ids) x
      UNION ALL SELECT 'takes', tk.id::text FROM takes tk WHERE p_table = 'pages' AND tk.page_id = ANY(p_ids)
      UNION ALL SELECT 'timeline_entries', te.id::text FROM timeline_entries te WHERE p_table = 'pages' AND te.page_id = ANY(p_ids)),
    down(t, id) AS (
      SELECT d.derived_table, d.derived_id FROM derivation_inputs d JOIN seed s ON d.input_table = s.t AND d.input_id = s.id
      UNION SELECT d.derived_table, d.derived_id FROM derivation_inputs d JOIN down ON d.input_table = down.t AND d.input_id = down.id),
    concepts(t, id) AS (
      SELECT 'pages', p.id::text FROM links l JOIN pages p ON p.id = l.from_page_id
      WHERE p_table = 'pages' AND l.to_page_id = ANY(p_ids) AND p.type IN ('concept', 'question')
        AND l.link_source = 'concept-provenance' AND l.link_type = 'synthesized_from')
  INSERT INTO owner_only_marks (row_table, row_id)
  SELECT t, id FROM down UNION SELECT t, id FROM concepts
  ON CONFLICT DO NOTHING;
END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_owner_only_source_deleted() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF OLD.${OWNER_ONLY_SOURCE.replace(' OR config', ' OR OLD.config')} THEN
    PERFORM gbrain_owner_only_mark_derived('pages', ARRAY(SELECT p.id FROM pages p WHERE p.source_id = OLD.id));
    PERFORM gbrain_owner_only_mark_derived('facts', ARRAY(SELECT f.id FROM facts f WHERE f.source_id = OLD.id));
  END IF;
  RETURN OLD;
END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_owner_only_row_deleted() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NOT ${OWNER_ONLY_LINEAGE_FN}() THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME IN ('pages', 'facts') THEN
    IF ${OWNER_ONLY_LINEAGE_FN}(TG_TABLE_NAME, OLD.id) THEN
      PERFORM gbrain_owner_only_mark_derived(TG_TABLE_NAME, ARRAY[OLD.id]);
    END IF;
  ELSIF ${OWNER_ONLY_LINEAGE_FN}('pages', OLD.page_id) THEN
    PERFORM gbrain_owner_only_mark_derived(TG_TABLE_NAME, ARRAY[OLD.id]);
  END IF;
  RETURN OLD;
END
$fn$;
`,
  handler: async engine => {
    const left = await engine.ownerOnlyMarkTriggers({ ensure: true });
    if (left.missing.length) process.stderr.write(ownerOnlyTriggersLeftLine(left));
  },
};
