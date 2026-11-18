/**
 * The connect gate's persistence reads (BrainEngine hasPersistenceTable, listManagedRootBindings,
 * readGraduationGateRow, listRetiredDeactivations), answered in TypeScript from what the store keeps.
 *
 * The store keeps the persistence state of one unmanaged brain (readManagedModeRows answers `enabled: false`), so
 * every persistence table reads as present and holds nothing a gate acts on: no host or source binding, no
 * graduation custody row (no graduation targets this engine) and no committed writer deactivation. The only rows are
 * the sources with a local path, which `listManagedRootBindings` lists as PGLite's UNION does.
 *
 * What each member answers and why: rust/docs/store/journal.md ("TypeScript journal members").
 */
import type { GraduationGateRow, ManagedRootBindingRow, PersistenceTable, RetiredDeactivationRow } from '../../engine-sql/connect-gate.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The store has every persistence table a gate probes; each answers its empty state. */
export const hasPersistenceTable: StoreMember<[table: PersistenceTable], boolean> = async () => true;

/** No host binds a managed worktree on this engine, so the rows are the sources with a local path (archived ones too). */
export const listManagedRootBindings: StoreMember<[hostId: string, opts?: { signal?: AbortSignal }], ManagedRootBindingRow[]> =
  async (brain, _hostId, opts) => {
    opts?.signal?.throwIfAborted();
    const rows = await storeCall({ member: 'listManagedRootBindings' }, () => brain.listAllSources({ includeArchived: true })) as
      Array<{ id: string; local_path: string | null; incarnation: string }>;
    return rows.filter(row => row.local_path != null).map(row => ({
      local_path: row.local_path as string, source_id: row.id, source_incarnation: row.incarnation, worktree_id: null, topology_generation: null,
    }));
  };

/** No graduation targets or leaves this engine, so there is no custody row. */
export const readGraduationGateRow: StoreMember<[opts?: { withRunSetting?: boolean }], GraduationGateRow | null> = async () => null;

/** A brain on this engine is never managed, so no writer deactivation ever committed. */
export const listRetiredDeactivations: StoreMember<[], RetiredDeactivationRow[]> = async () => [];
