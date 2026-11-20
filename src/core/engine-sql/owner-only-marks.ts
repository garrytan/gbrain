/**
 * BrainEngine.ownerOnlyMarkTriggers (GST-3032, migration v322): the BEFORE DELETE triggers that mark, before an owner-only
 * origin row goes, every row derived from it (owner_only_marks). CREATE TRIGGER needs the table's owner, so a trigger on
 * a table another role owns is left and reported, never skipped silently. While one is missing on a brain that holds an
 * owner-only source or a mark, the unguarded mark reads owner-only lineage closed (v322's gbrain_owner_only_lineage).
 */
import type { OwnerOnlyTriggerState, OwnerOnlyTriggerTable } from '../access/owner-only-marks.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment } from './fragment.ts';

/** Each guarded table: its trigger, the function it must run, and the one statement that (re)creates it atomically. */
const TRIGGERS = {
  sources: {
    trigger: 'gbrain_owner_only_source_changed_trg',
    fn: 'gbrain_owner_only_source_changed',
    create: 'DO $t$ BEGIN DROP TRIGGER IF EXISTS gbrain_owner_only_source_changed_trg ON sources; CREATE TRIGGER gbrain_owner_only_source_changed_trg BEFORE INSERT OR UPDATE OF config OR DELETE ON sources FOR EACH ROW EXECUTE FUNCTION gbrain_owner_only_source_changed(); END $t$',
  },
  pages: {
    trigger: 'gbrain_owner_only_row_deleted_trg',
    fn: 'gbrain_owner_only_row_deleted',
    create: 'DO $t$ BEGIN DROP TRIGGER IF EXISTS gbrain_owner_only_row_deleted_trg ON pages; CREATE TRIGGER gbrain_owner_only_row_deleted_trg BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION gbrain_owner_only_row_deleted(); END $t$',
  },
  facts: {
    trigger: 'gbrain_owner_only_row_deleted_trg',
    fn: 'gbrain_owner_only_row_deleted',
    create: 'DO $t$ BEGIN DROP TRIGGER IF EXISTS gbrain_owner_only_row_deleted_trg ON facts; CREATE TRIGGER gbrain_owner_only_row_deleted_trg BEFORE DELETE ON facts FOR EACH ROW EXECUTE FUNCTION gbrain_owner_only_row_deleted(); END $t$',
  },
  takes: {
    trigger: 'gbrain_owner_only_row_deleted_trg',
    fn: 'gbrain_owner_only_row_deleted',
    create: 'DO $t$ BEGIN DROP TRIGGER IF EXISTS gbrain_owner_only_row_deleted_trg ON takes; CREATE TRIGGER gbrain_owner_only_row_deleted_trg BEFORE DELETE ON takes FOR EACH ROW EXECUTE FUNCTION gbrain_owner_only_row_deleted(); END $t$',
  },
  timeline_entries: {
    trigger: 'gbrain_owner_only_row_deleted_trg',
    fn: 'gbrain_owner_only_row_deleted',
    create: 'DO $t$ BEGIN DROP TRIGGER IF EXISTS gbrain_owner_only_row_deleted_trg ON timeline_entries; CREATE TRIGGER gbrain_owner_only_row_deleted_trg BEFORE DELETE ON timeline_entries FOR EACH ROW EXECUTE FUNCTION gbrain_owner_only_row_deleted(); END $t$',
  },
} as const;

const TABLES = Object.keys(TRIGGERS) as OwnerOnlyTriggerTable[];

/**
 * The logins that read `sources` but cannot both read and add every owner_only_marks row (no grant, or row-level security
 * without a permissive policy for them that reads and adds every row, USING (true) and WITH CHECK (true), or with a
 * restrictive policy that applies to them; v328): on a brain that has held owner-only data they read owner-only lineage
 * closed and their permanent deletes are refused. Superusers, BYPASSRLS logins and the table's owner (without FORCE)
 * need nothing.
 */
const DENIED_LOGINS_SQL = `
  SELECT pg_catalog.quote_ident(r.rolname) AS login, pg_catalog.quote_ident('owner_only_marks_read_' || r.rolname) AS read_policy,
         pg_catalog.quote_ident('owner_only_marks_add_' || r.rolname) AS add_policy FROM pg_catalog.pg_roles r, pg_catalog.pg_class c
   WHERE c.oid = 'public.owner_only_marks'::pg_catalog.regclass AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
     AND pg_catalog.has_table_privilege(r.oid, 'public.sources', 'SELECT')
     AND (NOT pg_catalog.pg_has_role(r.oid, c.relowner, 'USAGE') OR c.relforcerowsecurity)
     AND (NOT pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT') OR NOT pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT')
          OR (c.relrowsecurity AND (NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive AND p.polcmd::text IN ('*', 'r')
                 AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true'
                 AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.polroles) AS pr(id) WHERE pr.id = 0::oid OR pg_catalog.pg_has_role(r.oid, pr.id, 'USAGE')))
            OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive AND p.polcmd::text IN ('*', 'a')
                 AND pg_catalog.pg_get_expr(coalesce(p.polwithcheck, p.polqual), p.polrelid) = 'true'
                 AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.polroles) AS pr(id) WHERE pr.id = 0::oid OR pg_catalog.pg_has_role(r.oid, pr.id, 'USAGE')))
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND NOT p.polpermissive AND p.polcmd::text IN ('*', 'r', 'a')
                 AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.polroles) AS pr(id) WHERE pr.id = 0::oid OR pg_catalog.pg_has_role(r.oid, pr.id, 'USAGE'))))))
   ORDER BY 1`;

/**
 * The logins that read `sources` but not every row of one of the owner-only lineage tables (no SELECT grant, or row-level
 * security without a permissive USING (true) policy for them, or with a restrictive one): on a brain that has held
 * owner-only data they read owner-only lineage closed (v328). Superusers, BYPASSRLS logins and each table's owner (without
 * FORCE) read it all.
 */
const CLOSED_LOGINS_SQL = `
  SELECT pg_catalog.quote_ident(r.rolname) AS login, pg_catalog.quote_ident('gbrain_lineage_read_' || r.rolname) AS policy,
         pg_catalog.array_agg(c.relname::text ORDER BY c.relname) AS tables FROM pg_catalog.pg_roles r, pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::pg_catalog.regnamespace AND c.relname IN ('sources', 'facts', 'derivation_inputs', 'links', 'pages', 'takes', 'timeline_entries')
     AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND pg_catalog.has_table_privilege(r.oid, 'public.sources', 'SELECT')
     AND (NOT pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT')
          OR (c.relrowsecurity AND (NOT pg_catalog.pg_has_role(r.oid, c.relowner, 'USAGE') OR c.relforcerowsecurity)
            AND (NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive AND p.polcmd::text IN ('*', 'r')
                   AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true'
                   AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.polroles) AS pr(id) WHERE pr.id = 0::oid OR pg_catalog.pg_has_role(r.oid, pr.id, 'USAGE')))
              OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid AND NOT p.polpermissive AND p.polcmd::text IN ('*', 'r')
                   AND EXISTS (SELECT 1 FROM pg_catalog.unnest(p.polroles) AS pr(id) WHERE pr.id = 0::oid OR pg_catalog.pg_has_role(r.oid, pr.id, 'USAGE'))))))
   GROUP BY r.rolname ORDER BY 1`;

async function readState(exec: SqlExecutor): Promise<OwnerOnlyTriggerState> {
  const { rows } = await exec.run<{ tbl: OwnerOnlyTriggerTable; owner: string; owned: boolean }>(sqlFragment`
    SELECT g.tbl, pg_get_userbyid(c.relowner)::text AS owner, pg_has_role(current_user, c.relowner, 'USAGE') AS owned
      FROM unnest(${TABLES}::text[], ${TABLES.map(t => TRIGGERS[t].trigger)}::text[], ${TABLES.map(t => TRIGGERS[t].fn)}::text[]) AS g(tbl, trg, fn)
      JOIN pg_class c ON c.relname = g.tbl AND c.relnamespace = 'public'::regnamespace
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = g.trg AND NOT t.tgisinternal
                         AND t.tgenabled <> 'D' AND t.tgfoid = to_regprocedure('public.' || g.fn || '()'))
     ORDER BY g.tbl`);
  const { rows: [state] } = await exec.query<{ role: string; closed: boolean; row_security: boolean; held: boolean; unflagged: boolean }>(
    `SELECT quote_ident(current_user) AS role, EXISTS (SELECT 1 FROM owner_only_marks m WHERE m.row_table = '*' AND m.row_id = 'unguarded') AS closed,
            EXISTS (SELECT 1 FROM owner_only_marks m WHERE m.row_table = '*' AND m.row_id = 'row_security') AS row_security,
            gbrain_owner_only_held() AS held,
            NOT gbrain_owner_only_held() AND EXISTS (SELECT 1 FROM owner_only_marks) AS unflagged`);
  const logins = state!.held ? (await exec.query<{ login: string; read_policy: string; add_policy: string }>(DENIED_LOGINS_SQL)).rows
    .map(r => ({ login: r.login, readPolicy: r.read_policy, addPolicy: r.add_policy })) : [];
  const closedLogins = state!.held ? (await exec.query<{ login: string; policy: string; tables: string[] }>(CLOSED_LOGINS_SQL)).rows : [];
  return { missing: rows.map(r => ({ table: r.tbl, owner: r.owner, owned: r.owned })), role: state!.role, closed: state!.closed, rowSecurity: state!.row_security,
    held: state!.held, unflagged: state!.unflagged, deniedLogins: logins, closedLogins };
}

/**
 * Marks copied in without a trigger (engine graduation, a data-only restore) arrive without the held flag, a catalog
 * comment no data copy carries: set it, so the guard reads them. Only the owner of owner_only_marks can; another role
 * leaves it to doctor (owner_only_marks_triggers names the state).
 */
async function holdCopiedMarks(exec: SqlExecutor): Promise<void> {
  const { rows: [state] } = await exec.query<{ unflagged: boolean; owns: boolean }>(
    `SELECT NOT gbrain_owner_only_held() AND EXISTS (SELECT 1 FROM owner_only_marks) AS unflagged,
            pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.owner_only_marks'::regclass), 'USAGE') AS owns`);
  if (state!.unflagged && state!.owns) await exec.query('SELECT gbrain_owner_only_hold()');
}

/**
 * A trigger found missing or disabled after v322 installed them is a gap in which a delete left no marks, so on a brain
 * that holds an owner-only source or a mark the unguarded mark is set before it is re-created (`installing`: v322's own
 * first creation, which is no gap).
 */
export async function ownerOnlyMarkTriggers(exec: SqlExecutor, opts?: { ensure?: boolean; installing?: boolean }): Promise<OwnerOnlyTriggerState> {
  if (opts?.ensure) await holdCopiedMarks(exec);
  const before = await readState(exec);
  if (!opts?.ensure || before.missing.length === 0) return before;
  const closeIfPresent = async () => {
    await exec.query(`SELECT gbrain_owner_only_hold() WHERE gbrain_owner_only_lineage()`);
    await exec.query(`INSERT INTO owner_only_marks (row_table, row_id) SELECT '*', 'unguarded' WHERE gbrain_owner_only_lineage() ON CONFLICT DO NOTHING`);
  };
  if (!opts.installing) await closeIfPresent();
  const owned = before.missing.filter(m => m.owned);
  for (const { table } of owned) await exec.query(TRIGGERS[table].create);
  const after = owned.length ? await readState(exec) : before;
  if (after.missing.length > 0) await closeIfPresent();
  return readState(exec);
}
