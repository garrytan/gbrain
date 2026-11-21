import type { Migration } from './types.ts';
import { OWNER_ONLY_HELD, OWNER_ONLY_LINEAGE_FN } from '../access/owner-only.ts';
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
// page, and marks each one, the deleted rows included (so a derivation recorded later against one reads owner-only).
// Nothing derived is deleted or rewritten; a mark only ever narrows who reads a row. The triggers run as the deleting
// role (no SECURITY DEFINER, #7659), and a role whose reads row-level security limits could miss derived rows: its delete
// of a row it reads as owner-only is refused (owner_only_lineage_unreadable), and its delete of a row it reads as open,
// on a brain that has held owner-only data, goes through but sets the row-security mark ('*', 'row_security'), which closes
// owner-only lineage like the unguarded mark below. Takes and timeline rows are classified by their own lineage as well
// as their page's.
// gbrain_owner_only_lineage(table, id) now answers true for a marked row and for a row whose recorded inputs reach one or
// reach a row in an owner-only source, at any depth (v320 stopped at 8 hops, so a row nine derivations away read as
// open); both walks are cycle-safe because UNION keeps each (table, id) once. gbrain_owner_only_lineage() answers true
// once the brain has held owner-only data: an owner-only source exists, or the one-way flag OWNER_ONLY_HELD is set, a
// comment on owner_only_marks that the first owner-only source (the sources trigger), the first mark and this
// migration set. It is a catalog read, so no missing grant or row-level security policy hides it from a login, and a
// brain that never held owner-only data never reads owner_only_marks: a non-owner login there reads and deletes as on
// v321 with no new grant. Only the owner of owner_only_marks can set the flag; any other writer is refused.
//
// owner_only_marks follows the sibling pattern: row-level security on, no policy. A login that cannot read every mark (no
// SELECT grant, or row-level security with no permissive policy for it) reads owner-only lineage closed, never open and
// never an error, and on a brain that has held owner-only data its permanent deletes are refused naming the grant
// (owner_only_marks_unwritable). Doctor (owner_only_marks_triggers) prints the GRANT and CREATE POLICY statements for each
// such login; the operator runs them.
//
// The triggers are created by the handler (BrainEngine.ownerOnlyMarkTriggers), which every migration run repeats: a table
// another role owns is named on stderr and by doctor (owner_only_marks_triggers) with its owner fix, never an abort.
// While a trigger is missing on a brain that holds an owner-only source or a mark, the unguarded mark ('*', 'unguarded')
// closes owner-only lineage: every row with a recorded derivation input and every synthesized concept or question counts
// as owner-only. A trigger found missing after v322 installed it (dropped or disabled later) sets it too, before it is
// re-created. It stays until the owner clears it, because a delete in the gap left no marks; the triggers decide marks
// with gbrain_owner_only_lineage_strict, which ignores it, so the closed mode never writes a permanent mark. The kinds and the flag
// repeat OWNER_ONLY_KINDS and OWNER_ONLY_FLAG (the owner-only tests keep them equal). A brain that never held an
// owner-only source pays one guard read per deleted row and stores nothing. No schema.sql mirror, like v320: the table
// and the functions exist only through migrations.
const OWNER_ONLY_SOURCE = `config->>'kind' IN ('imessage') OR config->>'owner_only' = 'true'`;
export { OWNER_ONLY_HELD };
/** The held flag test, inline: a nested function call per deleted row costs a search_path switch (GST-3032 timing). */
const HELD_SQL = `EXISTS (SELECT 1 FROM pg_catalog.pg_description d WHERE d.objoid = 'public.owner_only_marks'::pg_catalog.regclass
    AND d.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.objsubid = 0 AND d.description = '${OWNER_ONLY_HELD}')`;
/** Refuse a delete that needs owner_only_marks this role cannot read and add, naming the grant. */
const MARKS_DENIED_RAISE = `    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'owner_only_marks_unwritable: this brain holds owner-only data, and this database role ('
        || current_user || ') cannot read and add owner_only_marks, so deleting this row could leave a row derived from owner-only data unmarked',
      HINT = 'As the table owner run GRANT SELECT, INSERT ON public.owner_only_marks TO ' || pg_catalog.quote_ident(current_user)
        || ' and the CREATE POLICY statements gbrain doctor prints (owner_only_marks_triggers); see docs/ENGINES.md#owner-only-delete-triggers.';`;
/** Row-level security limits this role's reads of a table the owner-only lineage walk or the source trigger reads. */
const LINEAGE_TABLES = ['sources', 'facts', 'derivation_inputs', 'links', 'pages', 'takes', 'timeline_entries'];
const READS_LIMITED = LINEAGE_TABLES
  .map(table => `pg_catalog.row_security_active('${table}')`).join(' OR ');

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
END $rls$;
DROP POLICY IF EXISTS owner_only_marks_read ON owner_only_marks;
DROP POLICY IF EXISTS owner_only_marks_add ON owner_only_marks;
CREATE OR REPLACE FUNCTION gbrain_owner_only_held() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT ${HELD_SQL}
$fn$;
CREATE OR REPLACE FUNCTION gbrain_owner_only_hold() RETURNS void
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF gbrain_owner_only_held() THEN
    RETURN;
  END IF;
  BEGIN
    COMMENT ON TABLE public.owner_only_marks IS '${OWNER_ONLY_HELD}';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'owner_only_marks_unwritable: this is the brain''s first owner-only data, and only the owner of owner_only_marks ('
        || pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.owner_only_marks'::pg_catalog.regclass))
        || ') can record that owner-only lineage stays guarded from now on',
      HINT = 'Make this change once as that role; see docs/ENGINES.md#owner-only-delete-triggers.';
  END;
END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_owner_only_marks_denied(p_cmd TEXT) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT NOT pg_catalog.has_table_privilege('public.owner_only_marks', CASE p_cmd WHEN 'a' THEN 'INSERT' ELSE 'SELECT' END)
    OR (pg_catalog.row_security_active('public.owner_only_marks') AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = 'public.owner_only_marks'::pg_catalog.regclass AND p.polpermissive
        AND p.polcmd::text IN ('*', p_cmd)
        AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.polroles) AS r(id) WHERE r.id = 0::oid OR pg_catalog.pg_has_role(r.id, 'USAGE'))))
$fn$;
CREATE OR REPLACE FUNCTION gbrain_owner_only_lineage_strict(p_table TEXT, p_id BIGINT) RETURNS boolean
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
CREATE OR REPLACE FUNCTION ${OWNER_ONLY_LINEAGE_FN}(p_table TEXT, p_id BIGINT) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE COST 1 SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  denied boolean;
  closed boolean;
BEGIN
  IF p_id IS NULL THEN
    RETURN false;
  END IF;
  IF NOT (${LINEAGE_TABLES.map(t => `pg_catalog.has_table_privilege('public.${t}', 'SELECT')`).join(' AND ')}) THEN
    RETURN true;
  END IF;
  denied := gbrain_owner_only_marks_denied('r');
  IF denied THEN
    closed := true;
  ELSE
    closed := EXISTS (SELECT 1 FROM owner_only_marks m WHERE m.row_table = '*');
  END IF;
  IF closed AND (
      EXISTS (SELECT 1 FROM derivation_inputs d WHERE d.derived_table = p_table AND d.derived_id = p_id::text)
      OR (p_table = 'pages' AND EXISTS (SELECT 1 FROM pages p WHERE p.id = p_id AND p.type IN ('concept', 'question')))) THEN
    RETURN true;
  END IF;
  IF denied THEN
    RETURN (p_table = 'pages' AND EXISTS (SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id WHERE p.id = p_id AND (${OWNER_ONLY_SOURCE.replace(/config/g, 's.config')})))
      OR (p_table = 'facts' AND EXISTS (SELECT 1 FROM facts f JOIN sources s ON s.id = f.source_id WHERE f.id = p_id AND (${OWNER_ONLY_SOURCE.replace(/config/g, 's.config')})));
  END IF;
  RETURN gbrain_owner_only_lineage_strict(p_table, p_id);
END
$fn$;
CREATE OR REPLACE FUNCTION ${OWNER_ONLY_LINEAGE_FN}() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM sources s WHERE ${OWNER_ONLY_SOURCE.replace(/config/g, 's.config')}) OR ${HELD_SQL}
$fn$;
CREATE OR REPLACE FUNCTION gbrain_owner_only_mark_derived(p_table TEXT, p_ids BIGINT[]) RETURNS void
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF ${READS_LIMITED} THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'owner_only_lineage_unreadable: this row is owner-only, and row-level security limits this role''s reads of the rows derived from it, so they cannot all be marked owner-only before it goes',
      HINT = 'Delete it as the table owner (without FORCE ROW LEVEL SECURITY) or a role with BYPASSRLS; see docs/ENGINES.md#owner-only-delete-triggers.';
  END IF;
  IF gbrain_owner_only_marks_denied('r') OR gbrain_owner_only_marks_denied('a') THEN
${MARKS_DENIED_RAISE}
  END IF;
  PERFORM gbrain_owner_only_hold();
  IF p_ids IS NULL OR pg_catalog.cardinality(p_ids) = 0 THEN
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
  SELECT t, id FROM seed UNION SELECT t, id FROM down UNION SELECT t, id FROM concepts
  ON CONFLICT DO NOTHING;
END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_owner_only_source_changed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF ${OWNER_ONLY_SOURCE.replace(/config/g, 'OLD.config')} THEN
      PERFORM gbrain_owner_only_mark_derived('pages', ARRAY(SELECT p.id FROM pages p WHERE p.source_id = OLD.id));
      PERFORM gbrain_owner_only_mark_derived('facts', ARRAY(SELECT f.id FROM facts f WHERE f.source_id = OLD.id));
    END IF;
    RETURN OLD;
  END IF;
  IF ${OWNER_ONLY_SOURCE.replace(/config/g, 'NEW.config')} THEN
    PERFORM gbrain_owner_only_hold();
  END IF;
  RETURN NEW;
END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_owner_only_row_deleted() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  owner_only boolean;
BEGIN
  IF NOT ${HELD_SQL} AND NOT EXISTS (SELECT 1 FROM sources s WHERE ${OWNER_ONLY_SOURCE.replace(/config/g, 's.config')}) THEN
    RETURN OLD;
  END IF;
  IF gbrain_owner_only_marks_denied('r') THEN
${MARKS_DENIED_RAISE}
  END IF;
  IF TG_TABLE_NAME IN ('pages', 'facts') THEN
    owner_only := gbrain_owner_only_lineage_strict(TG_TABLE_NAME::text, OLD.id);
  ELSE
    owner_only := gbrain_owner_only_lineage_strict(TG_TABLE_NAME::text, OLD.id) OR gbrain_owner_only_lineage_strict('pages', OLD.page_id);
  END IF;
  IF owner_only THEN
    PERFORM gbrain_owner_only_mark_derived(TG_TABLE_NAME::text, ARRAY[OLD.id]);
  ELSIF ${READS_LIMITED} THEN
    IF gbrain_owner_only_marks_denied('a') THEN
${MARKS_DENIED_RAISE}
    END IF;
    PERFORM gbrain_owner_only_hold();
    INSERT INTO owner_only_marks (row_table, row_id) VALUES ('*', 'row_security') ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END
$fn$;
DO $held$ BEGIN
  IF EXISTS (SELECT 1 FROM sources s WHERE ${OWNER_ONLY_SOURCE.replace(/config/g, 's.config')}) OR EXISTS (SELECT 1 FROM owner_only_marks) THEN
    PERFORM gbrain_owner_only_hold();
  END IF;
END $held$;
`,
  handler: async engine => {
    const left = await engine.ownerOnlyMarkTriggers({ ensure: true, installing: true });
    if (left.missing.length) process.stderr.write(ownerOnlyTriggersLeftLine(left));
  },
};
