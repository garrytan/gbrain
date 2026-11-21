import type { Migration } from './types.ts';
import { OWNER_ONLY_LINEAGE_FN, OWNER_ONLY_READ_MODE_FN } from '../access/owner-only.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-3032 part 2: owner-only lineage read by a login whose reads are not complete. v322 read the marks closed for a
// login that could not read them (no grant, or row-level security with no permissive policy), but counted any
// permissive policy as complete, and walked the other lineage tables as the caller even when row-level security narrowed
// them, so a row derived from an owner-only row the login cannot see read as open. A table now reads complete for a login
// only when it holds the privilege and either row-level security does not apply to it (the owner without FORCE, a
// BYPASSRLS role, row-level security off) or a permissive policy for it reads every row (USING (true), and WITH CHECK
// (true) for an add) and no restrictive policy applies: the shape doctor prints. Anything else counts as limited.
//
// gbrain_owner_only_read_mode() answers once per statement how a login reads owner-only lineage:
//   all     no privilege on a lineage table, or derivation_inputs not complete: every row counts as owner-only;
//   source  the marks are not complete: rows with a recorded input, synthesized concepts and questions, and pages and facts in an
//           owner-only source, or in a source row the login cannot read, count as owner-only (v322's closed mode for an
//           unreadable mark, which looked the source up as the caller, so a source row its policy hid read as open);
//   closed  another lineage table is not complete, or the unguarded or row-security mark is set: the same closed rows
//           (a source row hidden from the login included), plus the exact walk, which only adds;
//   exact   the walk alone.
// gbrain_owner_only_lineage(table, id, mode) applies it; reads from v328 pass the mode as an InitPlan, and the
// two-argument form (reads that recorded v320 to v322) computes it per call. A missing or unknown mode counts as all.
// Plpgsql keeps each table read in its own statement, so a login without a grant on a table never plans a read of it.
//
// gbrain_owner_only_hold() is unchanged: COMMENT takes a SHARE UPDATE EXCLUSIVE lock on owner_only_marks, so two sessions
// recording the flag at once queue on it and both commit, under READ COMMITTED and REPEATABLE READ alike (the scoped-login
// test pins it). Functions only; no table, trigger or row changes. No schema.sql mirror, like v320 and v322.
const ownerOnlySource = (alias: string) => `${alias}.config->>'kind' IN ('imessage') OR ${alias}.config->>'owner_only' = 'true'`;
const LINEAGE_TABLES = ['sources', 'facts', 'derivation_inputs', 'links', 'pages', 'takes', 'timeline_entries'];
const openSourceMissing = (alias: string) => `NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = ${alias}.source_id AND NOT coalesce((${ownerOnlySource('s')}), false))`;
const complete = (table: string) => `gbrain_owner_only_reads_complete('public.${table}', 'r')`;

export const v328: Migration = {
  version: 328,
  name: 'owner_only_reads_complete',
  idempotent: true,
  sql: `
CREATE OR REPLACE FUNCTION gbrain_owner_only_reads_complete(p_rel regclass, p_cmd TEXT) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT pg_catalog.has_table_privilege(p_rel, CASE p_cmd WHEN 'a' THEN 'INSERT' ELSE 'SELECT' END)
    AND (NOT pg_catalog.row_security_active(p_rel) OR (
      EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = p_rel AND p.polpermissive AND p.polcmd::text IN ('*', p_cmd)
        AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.polroles) AS r(id) WHERE r.id = 0::oid OR pg_catalog.pg_has_role(r.id, 'USAGE'))
        AND pg_catalog.pg_get_expr(CASE p_cmd WHEN 'a' THEN coalesce(p.polwithcheck, p.polqual) ELSE p.polqual END, p.polrelid) = 'true')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = p_rel AND NOT p.polpermissive AND p.polcmd::text IN ('*', p_cmd)
        AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.polroles) AS r(id) WHERE r.id = 0::oid OR pg_catalog.pg_has_role(r.id, 'USAGE')))))
$fn$;
CREATE OR REPLACE FUNCTION gbrain_owner_only_marks_denied(p_cmd TEXT) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
  SELECT NOT gbrain_owner_only_reads_complete('public.owner_only_marks', p_cmd)
$fn$;
CREATE OR REPLACE FUNCTION ${OWNER_ONLY_READ_MODE_FN}() RETURNS text
  LANGUAGE plpgsql STABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NOT (${LINEAGE_TABLES.map(table => `pg_catalog.has_table_privilege('public.${table}', 'SELECT')`).join(' AND ')}) THEN
    RETURN 'all';
  END IF;
  IF NOT ${complete('derivation_inputs')} THEN
    RETURN 'all';
  END IF;
  IF gbrain_owner_only_marks_denied('r') THEN
    RETURN 'source';
  END IF;
  IF NOT (${LINEAGE_TABLES.filter(table => table !== 'derivation_inputs').map(complete).join(' AND ')}) THEN
    RETURN 'closed';
  END IF;
  IF EXISTS (SELECT 1 FROM owner_only_marks m WHERE m.row_table = '*') THEN
    RETURN 'closed';
  END IF;
  RETURN 'exact';
END
$fn$;
CREATE OR REPLACE FUNCTION ${OWNER_ONLY_LINEAGE_FN}(p_table TEXT, p_id BIGINT, p_mode TEXT) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE COST 1 SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF p_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('source', 'closed', 'exact') THEN
    RETURN true;
  END IF;
  IF p_mode <> 'exact' AND (
      EXISTS (SELECT 1 FROM derivation_inputs d WHERE d.derived_table = p_table AND d.derived_id = p_id::text)
      OR (p_table = 'pages' AND EXISTS (SELECT 1 FROM pages p WHERE p.id = p_id AND p.type IN ('concept', 'question')))) THEN
    RETURN true;
  END IF;
  IF p_mode <> 'exact' AND (
      (p_table = 'pages' AND EXISTS (SELECT 1 FROM pages p WHERE p.id = p_id AND ${openSourceMissing('p')}))
      OR (p_table = 'facts' AND EXISTS (SELECT 1 FROM facts f WHERE f.id = p_id AND ${openSourceMissing('f')}))) THEN
    RETURN true;
  END IF;
  IF p_mode = 'source' THEN
    RETURN false;
  END IF;
  RETURN gbrain_owner_only_lineage_strict(p_table, p_id);
END
$fn$;
CREATE OR REPLACE FUNCTION ${OWNER_ONLY_LINEAGE_FN}(p_table TEXT, p_id BIGINT) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE COST 1 SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF p_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN ${OWNER_ONLY_LINEAGE_FN}(p_table, p_id, ${OWNER_ONLY_READ_MODE_FN}());
END
$fn$;
`,
};
