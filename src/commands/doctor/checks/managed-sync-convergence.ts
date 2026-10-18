/**
 * managed_sync_convergence (#6712 PR 4a): the read-only shadow of the level-triggered managed-sync pass, as counts. For
 * every managed source this host owns it reads the level (sync-pass.ts) and reports the per-class counts, the predicted
 * decisions, `legacy_unverified`, `would_hold` and the delete valve's verdict (sync-convergence.ts). It is
 * informational in PR 4a: always `ok`, never a warning, and it writes nothing. A full level read is heavy, so the
 * check runs in the `deep` tier (`gbrain doctor --tier deep --json`, or `--only managed_sync_convergence`).
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { readManagedMode } from '../../../core/persistence/ownership.ts';
import { statusConvergence } from '../../../core/persistence/sync-pass.ts';
import { checkError } from '../check-fix.ts';
import { localHostId } from '../../../core/persistence/identity.ts';

async function runManagedSyncConvergenceCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    if (!await readManagedMode(engine)) {
      checks.push({ name: 'managed_sync_convergence', status: 'ok', message: 'Not a managed brain; there is no managed sync to shadow.', details: { sources: [] } });
      return checks;
    }
    const sources = await engine.executeRaw<{ id: string }>(`SELECT s.id FROM sources s JOIN persistence_source_bindings b ON b.source_id=s.id
      JOIN persistence_worktrees w ON w.id=b.worktree_id WHERE NOT s.archived AND s.config->>'kind' IS NULL AND w.owner_host_id=$1::uuid ORDER BY s.id`, [localHostId()]);
    const rows = [];
    for (const { id } of sources) {
      const receipt = await statusConvergence(engine, id);
      if (!receipt) continue;
      rows.push('status' in receipt ? { source_id: id, status: 'unavailable', code: receipt.code }
        : { source_id: id, status: 'read', mode: receipt.mode, target: receipt.target, candidates: receipt.candidates, in_flight: receipt.in_flight, counts: receipt.counts,
          decisions: receipt.decisions, legacy_unverified: receipt.legacy_unverified, would_hold: receipt.would_hold, deletes: { count: receipt.deletes.count, verdict: receipt.deletes.verdict },
          duration_ms: receipt.duration_ms });
    }
    const read = rows.filter(row => row.status === 'read') as Array<{ source_id: string; candidates: number; would_hold: number }>;
    checks.push({ name: 'managed_sync_convergence', status: 'ok', severity: 'info', details: { dry_run: true, sources: rows },
      message: rows.length
        ? `Convergence shadow (read-only): ${read.map(row => `${row.source_id} ${row.candidates} unsettled, ${row.would_hold} would hold`).join('; ') || 'no source could be read'}`
          + `${rows.length > read.length ? `; ${rows.length - read.length} source(s) not readable on this host` : ''}. Detail per source: gbrain sync --dry-run --json --source <id>.`
        : 'No managed source is owned here.' });
  } catch (error) {
    checks.push(checkError('managed_sync_convergence', 'read the convergence shadow', error, { details: { dry_run: true } }));
  }
  return checks;
}

/** A full level read per source: the deep tier only. */
export const managedSyncConvergenceEntry: DoctorEntry = { name: 'managed_sync_convergence', emits: ['managed_sync_convergence'], tier: 'deep', run: runManagedSyncConvergenceCheck };
