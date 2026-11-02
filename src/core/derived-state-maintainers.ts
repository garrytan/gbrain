/**
 * #7637: the derived-state maintainer triggers (page retrievals, atom scan state, tag revisions, version trust and
 * attribution snapshots, the page search vector, the projection queue, the trust generation) run SECURITY INVOKER and
 * read or write tables other than the one being written. Under row-level security, a role with no policy on such a
 * table read it empty and wrote nothing, so a deleted page kept its retrieval rows and other derived state went stale,
 * or the write failed with a raw RLS error.
 *
 * Each maintainer now checks first, the way the writer fences do since v278 (#7636): when RLS applies to the caller on
 * a table the maintainer needs and no permissive policy for the caller covers a command it runs there, it raises
 * writer_coordinator_required (unreadable_state) naming the table, so an empty read never counts as "nothing to do".
 * The owner (without FORCE ROW LEVEL SECURITY), a role that bypasses RLS and PGLite (no roles) never reach the policy
 * lookup. The check trusts the caller's policies: one that filters rows the maintainer needs keeps them as before,
 * which is why the docs/ENGINES.md recipe opens the maintainer tables to the writer. No SECURITY DEFINER (#7659).
 * Built-ins are schema-qualified and every operator compares exact types, so a closer overload in public cannot
 * replace the check.
 */

export type PolicyCommand = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
const POLICY_COMMAND: Record<PolicyCommand, string> = { SELECT: 'r', INSERT: 'a', UPDATE: 'w', DELETE: 'd' };

/** PL/pgSQL for a trigger body: refuse unless the caller may run every one of `commands` on `table`. `pad` indents lines after the first. */
export function requireMaintainerPoliciesSql(table: string, commands: readonly PolicyCommand[], pad = '  '): string {
  return [
    `IF pg_catalog.row_security_active('${table}') THEN`,
    `  IF EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY[${commands.map(c => `'${POLICY_COMMAND[c]}'`).join(',')}]) AS needed(cmd) WHERE NOT EXISTS (`,
    `      SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = '${table}'::regclass::oid AND p.polpermissive AND p.polcmd::text IN ('*', needed.cmd)`,
    `        AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.polroles) AS r(id) WHERE CASE WHEN r.id = 0::oid THEN true ELSE pg_catalog.pg_has_role(r.id, 'USAGE') END))) THEN`,
    `    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: writer state is unreadable to this database role',`,
    `      TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='managed_writer_guard:unreadable_state',`,
    `      DETAIL=pg_catalog.jsonb_build_object('op',TG_OP,'relationship','unreadable_state','state','${table}')::text;`,
    '  END IF;',
    'END IF;',
  ].join(`\n${pad}`);
}

/**
 * page_retrievals has no foreign key (v224): this statement trigger removes the rows of hard-deleted pages. A schema
 * blob fragment, so every boot's replay keeps this body.
 */
export const PAGE_RETRIEVALS_FORGET_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION gbrain_forget_page_retrievals() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM gbrain_deleted_pages) THEN
    ${requireMaintainerPoliciesSql('page_retrievals', ['SELECT', 'DELETE'], '    ')}
    DELETE FROM page_retrievals r USING gbrain_deleted_pages d WHERE r.page_id = d.id;
  END IF;
  RETURN NULL;
END $$;`;

/** A page leaving its source or soft-deleted (or restored) drops its atom scan state (v163). Migration-only. */
export const CLEAR_ATOM_PAGE_STATE_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION gbrain_clear_atom_page_state() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    ${requireMaintainerPoliciesSql('extract_atoms_page_state', ['SELECT', 'DELETE'], '    ')}
    DELETE FROM extract_atoms_page_state WHERE page_id=OLD.id;
  END IF;
  RETURN NEW;
END $fn$`;
