/**
 * The rows a repair's busy set is built from (`src/core/persistence/repair-busy.ts`): the open requests of a source, the
 * unfinished managed sync cursors of one source incarnation and the paths that incarnation holds. The Rust store answers
 * the same member in `rust/crates/gbrain-store/src/repair_plan_scans.rs`.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { GIT_HOLD_OP } from './persistence-journal.ts';

/** One open request of the source: its slug, path, origin path and both endpoints of a rename. */
export interface RepairBusyPendingRow { slug: string | null; path: string | null; source_path: string | null; rename_slug: string | null; rename_source_path: string | null }
/** One unfinished managed sync cursor: its run id and the index of the next manifest entry it admits. */
export interface RepairBusyCursorRow { run_id: string | null; index: string | number | null }
export interface RepairBusyRows { pending: RepairBusyPendingRow[]; cursors: RepairBusyCursorRow[]; held: string[] }

/**
 * Requests of `sourceId` that are queued, deferred, running or recovering, or carry a recovery, by sequence; the unfinished
 * `managed-sync` cursors of `sourceId` at `incarnation`; and, when a cursor is open, the paths of its Git holds at
 * `incarnation`. Cursors and holds sort by fingerprint in byte order.
 */
export async function readRepairBusyRows(exec: LegacyUnscopedRead, sourceId: string, incarnation: string): Promise<RepairBusyRows> {
  const pending = await exec.executeRaw<RepairBusyPendingRow>(`SELECT slug, intent->>'path' AS path, intent->>'sourcePath' AS source_path,
        intent->'renameFrom'->>'slug' AS rename_slug, intent->'renameFrom'->>'sourcePath' AS rename_source_path
      FROM persistence_requests WHERE source_id=$1 AND (state IN ('queued','deferred','running','recovering') OR recovery IS NOT NULL) ORDER BY sequence`, [sourceId]);
  const cursors = await exec.executeRaw<RepairBusyCursorRow>(`SELECT completed_keys->0->>'runId' AS run_id, completed_keys->0->>'index' AS index
      FROM op_checkpoints WHERE op='managed-sync' AND COALESCE(completed_keys->0->>'done','false')<>'true'
        AND completed_keys->0->>'sourceId'=$1 AND completed_keys->0->>'incarnation'=$2 ORDER BY fingerprint COLLATE "C"`, [sourceId, incarnation]);
  if (!cursors.length) return { pending, cursors, held: [] };
  const held = await exec.executeRaw<{ path: string | null }>(`SELECT completed_keys->0->>'path' AS path FROM op_checkpoints
      WHERE op=$1 AND completed_keys->0->>'source_id'=$2 AND completed_keys->0->>'incarnation'=$3 ORDER BY fingerprint COLLATE "C"`, [GIT_HOLD_OP, sourceId, incarnation]);
  return { pending, cursors, held: held.flatMap(row => row.path === null ? [] : [row.path]) };
}
