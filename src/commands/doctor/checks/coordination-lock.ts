import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';

const DOCS = 'docs/architecture/topologies.md#coordination-lock';

/**
 * v3 review (#6765): a checkout's recorded coordination lock always wins over
 * GBRAIN_COORDINATION_HOME. When the variable applies to a checkout (its
 * persistence home lies inside it) and names another directory than the lock
 * its reservation records, warn: the operator expects the lock under the
 * variable (often a mounted directory in a container) while every process keeps
 * using the recorded file. Read-only; names the recorded path and the move step.
 */
export async function checkCoordinationLockLocation(engine: BrainEngine): Promise<Check> {
  const name = 'coordination_lock_location';
  try {
    const { existsSync } = await import('node:fs');
    const { readPhysicalRootReservation } = await import('../../../core/persistence/physical-root-record.ts');
    const { coordinationHomeIgnored } = await import('../../../core/persistence/coordination-lock.ts');
    const { existingLocalHostId } = await import('../../../core/persistence/identity.ts');
    const roots = await engine.executeRaw<{ root: string; source_id: string | null }>(`
      SELECT DISTINCT local_path AS root,id AS source_id FROM sources WHERE local_path IS NOT NULL AND NOT COALESCE(archived,false)
      UNION SELECT DISTINCT h.local_path,NULL FROM persistence_host_bindings h WHERE h.host_id=$1::uuid`, [existingLocalHostId()]);
    const ignored: Array<{ root: string; source_id: string | null; configured_directory: string; recorded_path: string; move_step: string }> = [];
    for (const { root, source_id } of roots) {
      if (!existsSync(root)) continue;
      let recorded: string | undefined;
      try { recorded = readPhysicalRootReservation(root)?.coordinationPath; } catch { continue; }
      const mismatch = recorded ? coordinationHomeIgnored(root, recorded) : null;
      if (mismatch && !ignored.some(row => row.root === root)) ignored.push({ root, source_id, ...mismatch });
    }
    const details = { count: ignored.length, checkouts: ignored, docs: DOCS };
    if (!ignored.length) return { name, status: 'ok', details,
      message: 'Every checkout\'s recorded coordination lock agrees with GBRAIN_COORDINATION_HOME, or the variable does not apply.' };
    const first = ignored[0]!;
    return { name, status: 'warn', details, fix_unavailable_reason: 'operator_judgement',
      message: `GBRAIN_COORDINATION_HOME names ${first.configured_directory}, but ${ignored.map(row => `${row.source_id ?? row.root} records its lock at ${row.recorded_path}`).join('; ')}; `
        + `the recorded lock wins. ${first.move_step}` };
  } catch (error) {
    return { name, status: 'warn', details: { health: 'unknown' },
      message: `Coordination lock locations could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
