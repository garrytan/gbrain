/**
 * The connect gate's persistence reads (BrainEngine hasPersistenceTable, listManagedRootBindings,
 * readGraduationGateRow, listRetiredDeactivations), answered in TypeScript from what the store keeps.
 *
 * The store keeps one brain row with its stored mode (readManagedModeRows), so every persistence table reads as present.
 * A gate acts on the worktree bindings a claim keeps and on the committed writer deactivations; there is no graduation
 * custody row (no graduation targets this engine).
 * `listManagedRootBindings` lists this host's bound sources and the sources with a local path, as PGLite's UNION does.
 *
 * What each member answers and why: rust/docs/store/journal.md ("TypeScript journal members").
 */
import type { GraduationGateRow, ManagedRootBindingRow, PersistenceTable, RetiredDeactivationRow } from '../../engine-sql/connect-gate.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The store has every persistence table a gate probes; each answers its empty state. */
export const hasPersistenceTable: StoreMember<[table: PersistenceTable], boolean> = async () => true;

/**
 * The sources bound under a worktree this host binds (gbrain-store `persistence::worktrees`), then the sources with a
 * local path (archived ones too); a row both halves name comes back once, as from the UNION.
 */
export const listManagedRootBindings: StoreMember<[hostId: string, opts?: { signal?: AbortSignal }], ManagedRootBindingRow[]> =
  async (brain, hostId, opts) => {
    opts?.signal?.throwIfAborted();
    const bound = await storeCall({ member: 'listManagedRootBindings' }, () => brain.listHostRootBindings(hostId)) as ManagedRootBindingRow[];
    const rows = await storeCall({ member: 'listManagedRootBindings' }, () => brain.listAllSources({ includeArchived: true })) as
      Array<{ id: string; local_path: string | null; incarnation: string }>;
    const out: ManagedRootBindingRow[] = [], seen = new Set<string>();
    for (const row of [...bound, ...rows.filter(row => row.local_path != null).map(row => ({
      local_path: row.local_path as string, source_id: row.id, source_incarnation: row.incarnation, worktree_id: null, topology_generation: null,
    }))]) {
      const key = JSON.stringify([row.local_path, row.source_id, row.source_incarnation, row.worktree_id, row.topology_generation]);
      if (!seen.has(key)) { seen.add(key); out.push(row); }
    }
    return out;
  };

/** No graduation targets or leaves this engine, so there is no custody row. */
export const readGraduationGateRow: StoreMember<[opts?: { withRunSetting?: boolean }], GraduationGateRow | null> = async () => null;

/** The outcome of every committed `writer_deactivate` topology change (gbrain-store `persistence::topology`). */
export const listRetiredDeactivations: StoreMember<[], RetiredDeactivationRow[]> = (brain) =>
  storeCall({ member: 'listRetiredDeactivations' }, () => brain.writerReleaseRows({ kind: 'retired_deactivations' }));
