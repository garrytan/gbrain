import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { activatePersistence, type ActivationReport } from './activation.ts';
import { existingLocalHostId, localHostId } from './identity.ts';
import { acquireWorktree, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import type { NativeLockHandle } from './native-lock.ts';
import { declarePersistenceProtocol } from './protocol.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { assertWriterAdminState, WRITER_INSPECTION_HINT } from './admin-intent.ts';

export async function activateSharedSkillPersistence(engine: BrainEngine,
  options: { confirmQuiesced?: boolean; dryRun?: boolean; expectedState?: string } = {}): Promise<{ activated: boolean; protocol_version: 2; filesystem_sources: number; drift_audit?: ActivationReport['drift_audit'] }> {
  const quiescence = () => new OperationError('writer_not_quiesced',
    'Stop and exclude older canonical writers and direct-file skill servers before enabling shared skill publication.',
    'Run this activation on every canonical owner only after verifying process shutdown and canonical-root write access.');
  if (options.confirmQuiesced !== true) throw quiescence();
  const hostId = options.dryRun || options.expectedState !== undefined ? existingLocalHostId() : localHostId();
  const loadBindings = async (tx: BrainEngine): Promise<WorktreeBinding[]> => {
    const roots = await tx.executeRaw<{ source_id: string }>(`SELECT b.source_id FROM persistence_source_bindings b
      JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation WHERE NOT s.archived ORDER BY b.worktree_id,b.source_id`);
    const bindings: WorktreeBinding[] = [];
    for (const root of roots) {
      const binding = await getWorktreeBinding(tx, root.source_id, hostId);
      if (!binding || binding.owner_host_id !== hostId || binding.state !== 'active' || !binding.local_path) throw quiescence();
      bindings.push(binding);
    }
    if (!bindings.length) throw new OperationError('writer_registration_required', 'Shared publication requires a registered canonical source root.');
    return bindings;
  };
  const initial = await loadBindings(engine);
  const base = await activatePersistence(engine, { confirmQuiesced: true,
    dryRun: options.expectedState !== undefined || options.dryRun, expectedState: options.expectedState });
  if (options.expectedState !== undefined && !base.enabled) throw new OperationError('writer_registration_required',
    'Activate managed persistence first, then review fresh writer status before enabling shared skills.', WRITER_INSPECTION_HINT);
  const locks: NativeLockHandle[] = [];
  try {
    for (const binding of [...new Map(initial.map(row => [row.worktree_id, row])).values()]) {
      const lock = await acquireWorktree(binding);
      if (!lock) throw quiescence();
      locks.push(lock);
    }
    return await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true)");
      await assertWriterAdminState(tx, options.expectedState);
      await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
      await tx.executeRaw('SELECT id FROM persistence_worktrees ORDER BY id FOR UPDATE');
      await tx.executeRaw('SELECT id FROM sources ORDER BY id FOR SHARE');
      await tx.executeRaw('LOCK TABLE gbrain_cycle_locks IN SHARE MODE');
      const current = await loadBindings(tx);
      const identity = (rows: WorktreeBinding[]) => JSON.stringify(rows.map(row => [row.source_id, row.source_incarnation, row.worktree_id,
        row.owner_host_id, String(row.owner_epoch), String(row.topology_generation), row.relative_path, row.local_path, row.coordination_path]));
      if (identity(current) !== identity(initial)
        || (await tx.executeRaw('SELECT id FROM gbrain_cycle_locks LIMIT 1')).length
        || (await tx.executeRaw("SELECT id FROM persistence_requests WHERE state IN ('queued','running','recovering') OR recovery IS NOT NULL LIMIT 1")).length
        || (await tx.executeRaw("SELECT id FROM persistence_effects WHERE state IN ('queued','running') OR recovery IS NOT NULL LIMIT 1")).length) throw quiescence();
      if (options.dryRun) return { activated: false, protocol_version: 2, filesystem_sources: current.length,
        ...(base.drift_audit ? { drift_audit: base.drift_audit } : {}) };
      for (const binding of current) await tx.executeRaw(`INSERT INTO persistence_writer_protocols(worktree_id,host_id,owner_epoch,protocol_version)
        VALUES($1::uuid,$2::uuid,$3,2) ON CONFLICT(worktree_id,host_id) DO UPDATE SET
        owner_epoch=excluded.owner_epoch,protocol_version=2,registered_at=now()`, [binding.worktree_id, hostId, binding.owner_epoch]);
      await tx.executeRaw("SELECT set_config('gbrain.writer_quiesced','true',true)");
      await tx.executeRaw('UPDATE persistence_brain SET writer_protocol_floor=2,skill_bundles_enabled=true WHERE singleton=1');
      await refreshManagedFilesystemRoots(tx, managedFilesystemDatastorePath(engine));
      return { activated: true, protocol_version: 2, filesystem_sources: current.length };
    });
  } finally { for (const lock of locks.reverse()) await lock.release(); }
}
