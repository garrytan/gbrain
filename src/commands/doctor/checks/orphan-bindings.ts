import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { listOrphanBindings } from '../../../core/persistence/orphan-bindings.ts';

const LIMIT = 1000;

/**
 * #5732: persistence source bindings whose source or source incarnation no
 * longer exists. A source re-added under the same id cannot be claimed while
 * one remains. Brain-wide; names the repair.
 */
export async function checkOrphanBindings(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await listOrphanBindings(engine, { limit: LIMIT + 1 });
    const truncated = rows.length > LIMIT;
    const bindings = rows.slice(0, LIMIT);
    const details = { count: bindings.length, truncated, bindings, repair: 'orphan-bindings', docs: 'docs/guides/repair.md#orphan-bindings' };
    if (!bindings.length) return { name: 'orphan_persistence_bindings', status: 'ok', message: 'Every persistence source binding belongs to an existing source.', details };
    return { name: 'orphan_persistence_bindings', status: 'warn', details,
      message: `${bindings.length}${truncated ? '+' : ''} persistence source binding(s) belong to a removed source or an earlier incarnation `
        + `(${bindings.map(row => row.source_id).slice(0, 10).join(', ')}); a source re-added under the same id cannot be claimed while one remains. `
        + 'Preview on the brain host: gbrain repair orphan-bindings — then apply after the user agrees: gbrain repair orphan-bindings --apply' };
  } catch (error) {
    return { name: 'orphan_persistence_bindings', status: 'warn',
      message: `Persistence source bindings could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown', truncated: true } };
  }
}

/**
 * #5808: ownership markers (`.gbrain-owner.json` inside a source checkout and
 * the private `.gbrain-owner-<sha>.json` reservation beside it) that name a
 * brain other than this one, or a worktree this brain does not know. An
 * earlier brain on the same checkout (a PGLite brain later moved to Postgres,
 * a re-init) leaves them behind, and every claim then refuses
 * `recovery_required` without saying which file or which brain. Read-only:
 * doctor names the file and the brain it records; removing a marker is the
 * operator's decision, and only once the recorded brain is retired.
 */
export async function checkForeignOwnershipMarkers(engine: BrainEngine): Promise<Check> {
  const name = 'foreign_ownership_marker';
  try {
    const { readPhysicalRootReservation, readPhysicalRootStamp, physicalRootReservationPath, PHYSICAL_ROOT_MARKER } = await import('../../../core/persistence/physical-root-record.ts');
    const { existingLocalHostId } = await import('../../../core/persistence/identity.ts');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton=1');
    const worktrees = new Set((await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_worktrees')).map(row => row.id));
    const roots = await engine.executeRaw<{ root: string; source_id: string | null }>(`
      SELECT DISTINCT local_path AS root,id AS source_id FROM sources WHERE local_path IS NOT NULL AND NOT COALESCE(archived,false)
      UNION SELECT DISTINCT h.local_path,NULL FROM persistence_host_bindings h WHERE h.host_id=$1::uuid`, [existingLocalHostId()]);
    const markers: Array<{ path: string; source_id: string | null; kind: 'stamp' | 'reservation'; recorded_brain: string | null; worktree_known: boolean | null; problem: string }> = [];
    for (const { root, source_id } of roots) {
      if (!existsSync(root)) continue;
      const candidates: Array<{ kind: 'stamp' | 'reservation'; path: string; read: () => { brainId: string; worktreeId: string } | null }> = [
        { kind: 'stamp', path: join(root, PHYSICAL_ROOT_MARKER), read: () => readPhysicalRootStamp(root) },
        { kind: 'reservation', path: physicalRootReservationPath(root), read: () => readPhysicalRootReservation(root) },
      ];
      for (const candidate of candidates) {
        let value: { brainId: string; worktreeId: string } | null;
        try { value = candidate.read(); }
        catch { markers.push({ path: candidate.path, source_id, kind: candidate.kind, recorded_brain: null, worktree_known: null, problem: 'unreadable: not a private, well-formed ownership marker' }); continue; }
        if (!value) continue;
        const foreignBrain = brain ? value.brainId !== brain.brain_id : false;
        const unknownWorktree = !worktrees.has(value.worktreeId);
        if (!foreignBrain && !unknownWorktree) continue;
        markers.push({ path: candidate.path, source_id, kind: candidate.kind, recorded_brain: value.brainId, worktree_known: !unknownWorktree,
          problem: foreignBrain ? `records brain ${value.brainId}, not this brain (${brain?.brain_id ?? 'unknown'})` : `records worktree ${value.worktreeId}, which this brain does not know` });
      }
    }
    const details = { count: markers.length, markers, docs: 'docs/guides/write-refusals.md#foreign-ownership-marker' };
    if (!markers.length) return { name, status: 'ok', message: 'Every ownership marker beside a source checkout belongs to this brain.', details };
    return { name, status: 'warn', details,
      message: `${markers.length} ownership marker(s) beside source checkouts do not belong to this brain: `
        + markers.slice(0, 5).map(marker => `${marker.path} (${marker.problem})`).join('; ')
        + `. A claim of that checkout refuses recovery_required while one remains. Confirm with the user that the recorded brain is retired `
        + '(moved to this database or deleted), then remove exactly the named file on the brain host and claim again; never remove a marker of a brain that is still in use.' };
  } catch (error) {
    return { name, status: 'warn', details: { count: 'unknown' },
      message: `Ownership markers could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
