import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { acquireWorktree, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { localHostId, existingLocalHostId, persistenceHome, registerLocalWriter } from './identity.ts';
import { nativeLockCapability, tryAcquireNativeLock, type NativeLockHandle } from './native-lock.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { assertWriterAdminState, WRITER_INSPECTION_HINT } from './admin-intent.ts';

export interface ActivationReport {
  enabled: boolean;
  activated: boolean;
  filesystem_sources: number;
  native_lock: { target: string; napi: 3 };
  drift_audit?: { sources: Array<Record<string, unknown>>; complete: boolean; snapshot_only: true };
}
interface SourceRoot { id: string; incarnation: string; root: string | null; }
const quiescence = () => new OperationError('writer_not_quiesced', 'Managed activation requires all older writers and maintenance jobs to be stopped.',
  WRITER_INSPECTION_HINT);

async function configuredSources(engine: BrainEngine, lock = false): Promise<SourceRoot[]> {
  const sources = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null }>(
    `SELECT id,incarnation,local_path FROM sources WHERE archived=false ORDER BY id${lock ? ' FOR UPDATE' : ''}`);
  const fallback = await engine.getConfig('sync.repo_path');
  return sources.map(source => ({ id: source.id, incarnation: source.incarnation,
    root: source.local_path || (source.id === 'default' ? fallback : null) }));
}
async function validatedBindings(engine: BrainEngine, sources: SourceRoot[], hostId: string | null, lock = false): Promise<WorktreeBinding[]> {
  const bindings: WorktreeBinding[] = [];
  for (const source of sources) {
    let binding = await getWorktreeBinding(engine, source.id, hostId);
    if (!source.root && !binding) continue;
    if (binding && lock) {
      await engine.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [binding.worktree_id]);
      binding = await getWorktreeBinding(engine, source.id, hostId);
    }
    if (!binding || binding.source_incarnation !== source.incarnation || !binding.owner_host_id || binding.state !== 'active') {
      throw new OperationError('writer_registration_required', `Source '${source.id}' needs an active canonical owner before activation.`,
        WRITER_INSPECTION_HINT);
    }
    const [owner] = await engine.executeRaw<{ local_path: string; coordination_path: string }>(
      'SELECT local_path,coordination_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid', [binding.worktree_id, binding.owner_host_id]);
    if (!owner?.local_path || !owner.coordination_path) throw new OperationError('writer_registration_required', 'The canonical owner registration is incomplete.');
    if (binding.owner_host_id === hostId) {
      if (!binding.local_path || !binding.coordination_path
        || source.root && realpathSync(resolve(source.root)) !== realpathSync(join(binding.local_path, binding.relative_path))) {
        throw new OperationError('source_changed', `Source '${source.id}' no longer matches its registered canonical directory.`);
      }
    }
    bindings.push(binding);
  }
  return bindings;
}

/** Explicit coordinated-upgrade boundary. Refusal records become durable before enabled does. */
export async function activatePersistence(engine: BrainEngine, opts: { confirmQuiesced?: boolean; dryRun?: boolean; expectedState?: string } = {}): Promise<ActivationReport> {
  if (opts.confirmQuiesced !== true) throw quiescence();
  if (Number(await engine.getConfig('version')) < 157) throw new OperationError('writer_upgrade_required', 'Apply the canonical writer guard, outbox, and source lifecycle migrations before activation.');
  const native = await nativeLockCapability();
  const probe = await tryAcquireNativeLock(join(persistenceHome(), 'locks', 'activation-probe.lock'));
  if (!probe) throw new OperationError('writer_lock_unavailable', 'Another activation probe is running.');
  await probe.release();
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  if (brain?.enabled && opts.expectedState === undefined) {
    const [count] = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::integer AS count FROM persistence_source_bindings b
      JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation WHERE NOT s.archived`);
    return { enabled: true, activated: false, filesystem_sources: count.count, native_lock: native };
  }
  const hostId = opts.dryRun ? existingLocalHostId() : localHostId();
  const sources = await configuredSources(engine);
  const initial = await validatedBindings(engine, sources, hostId);
  let driftAudit: ActivationReport['drift_audit'];
  if (opts.dryRun) {
    const { auditCanonicalSource } = await import('./reconcile-audit.ts');
    const audited: Array<Record<string, unknown>> = [];
    for (const binding of initial.slice(0, 4)) {
      try { audited.push(await auditCanonicalSource(engine, binding.source_id)); }
      catch (error) {
        audited.push({ source_id: binding.source_id, complete: false,
          reason: error instanceof OperationError ? error.code : 'storage_error',
          suggestion: 'Run sources reconcile --audit on this source’s canonical owner.' });
      }
    }
    driftAudit = { sources: audited, complete: initial.length <= 4 && audited.every(report => report.complete === true), snapshot_only: true };
  }
  const locks: NativeLockHandle[] = [];
  try {
    // All native acquisition precedes the transaction and any database wait.
    const local = [...new Map(initial.filter(binding => binding.owner_host_id === hostId).map(binding => [binding.worktree_id, binding])).values()]
      .sort((a, b) => a.worktree_id.localeCompare(b.worktree_id));
    for (const binding of local) {
      const lock = await acquireWorktree(binding);
      if (!lock) throw quiescence();
      locks.push(lock);
    }
    return await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('lock_timeout','2000ms',true),set_config('synchronous_commit','on',true)");
      await assertWriterAdminState(tx, opts.expectedState);
      const [current] = await tx.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1 FOR UPDATE');
      if (current?.enabled) return { enabled: true, activated: false, filesystem_sources: initial.length, native_lock: native };
      const currentSources = await configuredSources(tx, true);
      const bindings = await validatedBindings(tx, currentSources, hostId, true);
      const identity = (rows: WorktreeBinding[]) => JSON.stringify(rows.map(row => [row.source_id,row.source_incarnation,row.worktree_id,row.owner_host_id,
        String(row.owner_epoch),String(row.topology_generation),row.relative_path,row.local_path,row.coordination_path]));
      if (identity(bindings) !== identity(initial) || JSON.stringify(currentSources) !== JSON.stringify(sources)) {
        throw new OperationError('source_changed', 'Source ownership changed during activation; inspect writer status and retry.');
      }
      // Block fresh legacy lease admission for the duration of this commit.
      // Even an expired row needs explicit inspection/removal; TTL is not proof
      // that a legacy process has stopped touching canonical files.
      await tx.executeRaw('LOCK TABLE gbrain_cycle_locks IN SHARE MODE');
      if ((await tx.executeRaw('SELECT id FROM gbrain_cycle_locks LIMIT 1')).length) throw quiescence();
      if ((await tx.executeRaw(`SELECT id FROM persistence_requests WHERE state IN ('queued','running','recovering') OR recovery IS NOT NULL LIMIT 1`)).length
        || (await tx.executeRaw('SELECT id FROM persistence_effects WHERE recovery IS NOT NULL LIMIT 1')).length) throw quiescence();
      if (opts.dryRun) return { enabled: false, activated: false, filesystem_sources: bindings.length, native_lock: native, drift_audit: driftAudit };
      await registerLocalWriter(tx, 'cli');
      await registerLocalWriter(tx, 'stdio');
      await tx.executeRaw('UPDATE persistence_brain SET enabled=true,activated_at=COALESCE(activated_at,now()) WHERE singleton=1');
      // Any fsync/marker failure rolls back enabled=true. A conservative stale
      // refusal record after rollback is safe and cannot grant writer authority.
      await refreshManagedFilesystemRoots(tx, managedFilesystemDatastorePath(engine));
      return { enabled: true, activated: true, filesystem_sources: bindings.length, native_lock: native };
    });
  } finally { for (const lock of locks.reverse()) await lock.release(); }
}
