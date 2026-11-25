/**
 * The connect gate's persistence reads: the statements a connect (and a write's admission) runs to learn whether the
 * persistence tables exist, which managed roots this host binds, whether a graduation holds the brain and which
 * epochs a deactivation retired. One SQL implementation for both engines. The statement text is what
 * persistence/filesystem-guard.ts, persistence/graduation-schema.ts, persistence/graduation-custody.ts and
 * persistence/deactivation.ts sent through `executeRaw`; the decisions (refuse, clean up, record roots) stay there.
 */
import type { LegacyUnscopedRead } from './brands.ts';

/** The persistence tables the connect gate probes before it reads them. */
export type PersistenceTable = 'persistence_brain' | 'persistence_topology_changes' | 'persistence_graduation';

/** One probe per table, as static text (the table name is never a parameter of `to_regclass`). */
const TABLE_PROBES: Record<PersistenceTable, string> = {
  persistence_brain: "SELECT to_regclass('persistence_brain') IS NOT NULL AS present",
  persistence_topology_changes: "SELECT to_regclass('persistence_topology_changes') IS NOT NULL AS present",
  persistence_graduation: `SELECT to_regclass('persistence_graduation') IS NOT NULL AS present`,
};

/** Whether `table` exists (a brain before the persistence migrations has none of them). */
export async function hasPersistenceTable(exec: LegacyUnscopedRead, table: PersistenceTable): Promise<boolean> {
  const probe = TABLE_PROBES[table];
  if (!probe) throw new Error(`hasPersistenceTable: unknown table ${String(table)}`);
  const [row] = await exec.executeRaw<{ present: boolean }>(probe);
  return row?.present === true;
}

/**
 * A managed root this host knows: a worktree this host binds (with its source binding), or a source with a local
 * path (`source_id` is the source id, `worktree_id` and `topology_generation` are null). The rows are a UNION, so a
 * repeated row comes back once; the caller deduplicates by filesystem identity.
 */
export interface ManagedRootBindingRow {
  local_path: string;
  source_id: string;
  source_incarnation: string;
  worktree_id: string | null;
  topology_generation: string | number | null;
}

/** Every managed root host `hostId` binds, plus every source with a local path, in one snapshot. */
export async function listManagedRootBindings(exec: LegacyUnscopedRead, hostId: string, opts?: { signal?: AbortSignal }): Promise<ManagedRootBindingRow[]> {
  return exec.executeRaw<ManagedRootBindingRow>(`SELECT h.local_path,s.source_id,s.source_incarnation,s.worktree_id,s.topology_generation
      FROM persistence_host_bindings h JOIN persistence_source_bindings s ON s.worktree_id=h.worktree_id WHERE h.host_id=$1::uuid
      UNION SELECT local_path,id,incarnation,NULL,NULL FROM sources WHERE local_path IS NOT NULL`, [hostId], opts?.signal ? { signal: opts.signal } : undefined);
}

/**
 * The graduation custody row as the gate reads it, plus `run`: the run the current transaction declares
 * (`gbrain.graduation_run`, null when unset), read only with `withRunSetting`.
 */
export interface GraduationGateRow {
  role: string;
  run_id: string;
  state: string;
  source_data_dir: string | null;
  run?: string | null;
}

/**
 * The custody row (`singleton = 1`), or null. Without `withRunSetting` it is the connect gate's one statement, which
 * fails with 42P01 on a brain before the migration (the caller reads that as "no row"); with it, the admission read
 * inside the admitting transaction, after the caller probed the table.
 */
export async function readGraduationGateRow(exec: LegacyUnscopedRead, opts: { withRunSetting?: boolean } = {}): Promise<GraduationGateRow | null> {
  const [row] = opts.withRunSetting
    ? await exec.executeRaw<GraduationGateRow>(
      `SELECT role, run_id::text AS run_id, state, source_data_dir, NULLIF(current_setting('gbrain.graduation_run', true), '') AS run
     FROM persistence_graduation WHERE singleton = 1`)
    : await exec.executeRaw<GraduationGateRow>(
      `SELECT role, run_id::text AS run_id, state, source_data_dir FROM persistence_graduation WHERE singleton = 1`);
  return row ?? null;
}
