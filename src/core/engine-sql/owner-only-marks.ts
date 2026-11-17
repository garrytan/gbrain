/**
 * BrainEngine.ownerOnlyMarkTriggers (GST-3032, migration v322): the BEFORE DELETE triggers that mark, before an owner-only
 * origin row goes, every row derived from it (owner_only_marks). CREATE TRIGGER needs the table's owner, so a trigger on
 * a table another role owns is left and reported, never skipped silently. While one is missing on a brain that holds an
 * owner-only source or a mark, the unguarded mark reads owner-only lineage closed (v322's gbrain_owner_only_lineage).
 */
import type { OwnerOnlyTriggerState, OwnerOnlyTriggerTable } from '../access/owner-only-marks.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment } from './fragment.ts';

/** Each guarded table: its trigger and the statements that (re)create it. */
const TRIGGERS = {
  sources: {
    trigger: 'gbrain_owner_only_source_deleted_trg',
    drop: 'DROP TRIGGER IF EXISTS gbrain_owner_only_source_deleted_trg ON sources',
    create: 'CREATE TRIGGER gbrain_owner_only_source_deleted_trg BEFORE DELETE ON sources FOR EACH ROW EXECUTE FUNCTION gbrain_owner_only_source_deleted()',
  },
  pages: {
    trigger: 'gbrain_owner_only_row_deleted_trg',
    drop: 'DROP TRIGGER IF EXISTS gbrain_owner_only_row_deleted_trg ON pages',
    create: 'CREATE TRIGGER gbrain_owner_only_row_deleted_trg BEFORE DELETE ON pages FOR EACH ROW EXECUTE FUNCTION gbrain_owner_only_row_deleted()',
  },
  facts: {
    trigger: 'gbrain_owner_only_row_deleted_trg',
    drop: 'DROP TRIGGER IF EXISTS gbrain_owner_only_row_deleted_trg ON facts',
    create: 'CREATE TRIGGER gbrain_owner_only_row_deleted_trg BEFORE DELETE ON facts FOR EACH ROW EXECUTE FUNCTION gbrain_owner_only_row_deleted()',
  },
  takes: {
    trigger: 'gbrain_owner_only_row_deleted_trg',
    drop: 'DROP TRIGGER IF EXISTS gbrain_owner_only_row_deleted_trg ON takes',
    create: 'CREATE TRIGGER gbrain_owner_only_row_deleted_trg BEFORE DELETE ON takes FOR EACH ROW EXECUTE FUNCTION gbrain_owner_only_row_deleted()',
  },
  timeline_entries: {
    trigger: 'gbrain_owner_only_row_deleted_trg',
    drop: 'DROP TRIGGER IF EXISTS gbrain_owner_only_row_deleted_trg ON timeline_entries',
    create: 'CREATE TRIGGER gbrain_owner_only_row_deleted_trg BEFORE DELETE ON timeline_entries FOR EACH ROW EXECUTE FUNCTION gbrain_owner_only_row_deleted()',
  },
} as const;

const TABLES = Object.keys(TRIGGERS) as OwnerOnlyTriggerTable[];

async function readState(exec: SqlExecutor): Promise<OwnerOnlyTriggerState> {
  const { rows } = await exec.run<{ tbl: OwnerOnlyTriggerTable; owner: string; owned: boolean }>(sqlFragment`
    SELECT g.tbl, pg_get_userbyid(c.relowner)::text AS owner, pg_has_role(current_user, c.relowner, 'USAGE') AS owned
      FROM unnest(${TABLES}::text[], ${TABLES.map(t => TRIGGERS[t].trigger)}::text[]) AS g(tbl, trg)
      JOIN pg_class c ON c.relname = g.tbl AND c.relnamespace = 'public'::regnamespace
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = g.trg AND NOT t.tgisinternal)
     ORDER BY g.tbl`);
  const { rows: [state] } = await exec.query<{ role: string; closed: boolean }>(
    `SELECT quote_ident(current_user) AS role, EXISTS (SELECT 1 FROM owner_only_marks m WHERE m.row_table = '*' AND m.row_id = 'unguarded') AS closed`);
  return { missing: rows.map(r => ({ table: r.tbl, owner: r.owner, owned: r.owned })), role: state!.role, closed: state!.closed };
}

export async function ownerOnlyMarkTriggers(exec: SqlExecutor, opts?: { ensure?: boolean }): Promise<OwnerOnlyTriggerState> {
  const before = await readState(exec);
  if (!opts?.ensure) return before;
  const owned = before.missing.filter(m => m.owned);
  for (const { table } of owned) {
    await exec.query(TRIGGERS[table].drop);
    await exec.query(TRIGGERS[table].create);
  }
  const after = owned.length ? await readState(exec) : before;
  if (after.missing.length === 0) return after;
  await exec.query(`INSERT INTO owner_only_marks (row_table, row_id) SELECT '*', 'unguarded' WHERE gbrain_owner_only_lineage() ON CONFLICT DO NOTHING`);
  return readState(exec);
}
