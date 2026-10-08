import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { acquireWorktree, getWorktreeBinding, type WorktreeBinding } from './ownership.ts';
import { localHostId, existingLocalHostId, persistenceHome, registerLocalWriter } from './identity.ts';
import { nativeLockCapability, tryAcquireNativeLock, type NativeLockHandle } from './native-lock.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { assertWriterAdminState, WRITER_INSPECTION_HINT } from './admin-intent.ts';
import { assertWriterAdminUnlocked } from './admin-lock.ts';
import { notQuiescedError } from './blocking-effects.ts';
import { inspectLegacyWriterLocks } from './legacy-locks.ts';
import { deleteLockRowExact } from '../db-lock.ts';
import { catalogueError } from '../error-catalogue.ts';
import { isConnectorSourceKind } from './connector-identity.ts';

export interface ActivationReport {
  enabled: boolean;
  activated: boolean;
  filesystem_sources: number;
  native_lock: { target: string; napi: 3 };
  drift_audit?: { sources: Array<Record<string, unknown>>; complete: boolean; snapshot_only: true };
  legacy_locks?: Awaited<ReturnType<typeof inspectLegacyWriterLocks>>;
}
interface SourceRoot { id: string; incarnation: string; root: string | null; connector: boolean; }
const quiescence = () => new OperationError('writer_not_quiesced', 'Managed activation requires all older writers and maintenance jobs to be stopped.',
  WRITER_INSPECTION_HINT);

const writerStatusFix = (why: string, sourceId?: string): Action => readFix(why,
  { argv: ['gbrain', 'sources', 'writer', 'status', ...(sourceId ? ['--source', sourceId] : []), '--json'] });

async function configuredSources(engine: BrainEngine, lock = false): Promise<SourceRoot[]> {
  const sources = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null; kind: string | null }>(
    `SELECT id,incarnation,local_path,config->>'kind' AS kind FROM sources WHERE archived=false ORDER BY id${lock ? ' FOR UPDATE' : ''}`);
  const fallback = await engine.getConfig('sync.repo_path');
  return sources.map(source => ({ id: source.id, incarnation: source.incarnation, connector: isConnectorSourceKind(source.kind),
    root: source.local_path || (source.id === 'default' ? fallback : null) }));
}
/** #5206: a recorded source directory that vanished is a named blocker with its exits, never a bare ENOENT. */
function sourcePathMissing(source: SourceRoot, claimedRoot: string | null): OperationError {
  const error = catalogueError('activation_source_path_missing',
    `Source '${source.id}' records the local path ${source.root}, which does not exist on this host, so activation cannot verify its canonical directory.`,
    `Point it at its checkout with gbrain sources set-path ${source.id} ${claimedRoot ? JSON.stringify(claimedRoot) : '<directory>'}, or remove it with gbrain sources remove ${source.id} --confirm-destructive; then rerun gbrain sources writer activate --confirm-quiesced --dry-run.`);
  error.detail = 'source_path_missing';
  return error;
}
async function validatedBindings(engine: BrainEngine, sources: SourceRoot[], hostId: string | null, lock = false): Promise<WorktreeBinding[]> {
  const bindings: WorktreeBinding[] = [];
  for (const source of sources) {
    let binding = await getWorktreeBinding(engine, source.id, hostId);
    if ((!source.root || source.connector) && !binding) continue;
    if (!binding && !source.connector && !existsSync(resolve(source.root!))) throw sourcePathMissing(source, null);
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
    if (!owner?.local_path || !owner.coordination_path) {
      throw opError('writer_registration_required', 'The canonical owner registration is incomplete.',
        `Source '${source.id}' has an owner without a complete host registration (checkout and coordination paths), so activation stopped and nothing changed. Inspect its writer status; repairing ownership is a deliberate topology change the operator reviews, not routine repair.`,
        { fix: writerStatusFix(`Shows source ${source.id}'s owner host and registration, read-only.`, source.id) });
    }
    if (binding.owner_host_id === hostId) {
      if (source.root && !existsSync(resolve(source.root))) throw sourcePathMissing(source, binding.local_path && join(binding.local_path, binding.relative_path));
      if (!binding.local_path || !binding.coordination_path
        || source.root && realpathSync(resolve(source.root)) !== realpathSync(join(binding.local_path, binding.relative_path))) {
        throw opError('source_changed', `Source '${source.id}' no longer matches its registered canonical directory.`,
          `Source '${source.id}' records ${source.root ?? 'no path'}, but its registered canonical directory is ${binding.local_path ? join(binding.local_path, binding.relative_path) : 'incomplete'}, so activation stopped and nothing changed. Inspect its writer status and ask the user which directory is canonical before changing either.`,
          { fix: writerStatusFix(`Shows source ${source.id}'s registered canonical directory, read-only.`, source.id) });
      }
    }
    bindings.push(binding);
  }
  return bindings;
}

/** Explicit coordinated-upgrade boundary. Refusal records become durable before enabled does. */
export async function activatePersistence(engine: BrainEngine, opts: { confirmQuiesced?: boolean; dryRun?: boolean; expectedState?: string; cleanupDeadLocalLocks?: boolean } = {}): Promise<ActivationReport> {
  if (opts.confirmQuiesced !== true) throw quiescence();
  if (Number(await engine.getConfig('version')) < 157) {
    throw opError('writer_upgrade_required', 'Apply the canonical writer guard, outbox, and source lifecycle migrations before activation.',
      'This brain\'s schema predates managed persistence. List the pending migrations, ask the user to approve applying them, then rerun gbrain sources writer activate --confirm-quiesced --dry-run.',
      { fix: { argv: ['gbrain', 'apply-migrations', '--dry-run', '--json'], consent: [], actor: 'agent', why: 'Lists the pending migrations without applying them.', requires_exclusive: false } });
  }
  const native = await nativeLockCapability();
  const probe = await tryAcquireNativeLock(join(persistenceHome(), 'locks', 'activation-probe.lock'));
  if (!probe) {
    throw opError('writer_lock_unavailable', 'Another activation probe is running.',
      'Another activation is running on this host and this attempt changed nothing. Let it finish, check the writer status, then rerun with --dry-run before activating.',
      { fix: writerStatusFix('Shows whether managed persistence is now enabled and which owners are active, read-only.') });
  }
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
      const lock = await acquireWorktree(binding, 0, undefined, undefined, { yieldLanes: true });
      if (!lock) throw quiescence();
      locks.push(lock);
    }
    return await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('lock_timeout','2000ms',true),set_config('synchronous_commit','on',true)");
      await assertWriterAdminState(tx, opts.expectedState);
      const [current] = await tx.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1 FOR UPDATE');
      await assertWriterAdminUnlocked(tx);
      if (current?.enabled) return { enabled: true, activated: false, filesystem_sources: initial.length, native_lock: native };
      const currentSources = await configuredSources(tx, true);
      const bindings = await validatedBindings(tx, currentSources, hostId, true);
      const identity = (rows: WorktreeBinding[]) => JSON.stringify(rows.map(row => [row.source_id,row.source_incarnation,row.worktree_id,row.owner_host_id,
        String(row.owner_epoch),String(row.topology_generation),row.relative_path,row.local_path,row.coordination_path]));
      if (identity(bindings) !== identity(initial) || JSON.stringify(currentSources) !== JSON.stringify(sources)) {
        throw opError('source_changed', 'Source ownership changed during activation; inspect writer status and retry.',
          'Sources or their owners changed while activation ran, so it rolled back and nothing was activated. Inspect the writer status, then rerun gbrain sources writer activate --confirm-quiesced --dry-run before activating again.',
          { fix: writerStatusFix('Shows the current sources, owners and registrations, read-only.') });
      }
      // Block fresh legacy lease admission for the duration of this commit.
      // Even an expired row needs explicit inspection/removal; TTL is not proof
      // that a legacy process has stopped touching canonical files.
      await tx.executeRaw('LOCK TABLE gbrain_cycle_locks IN SHARE ROW EXCLUSIVE MODE');
      const legacyLocks = await inspectLegacyWriterLocks(tx);
      if (legacyLocks.some(row => !opts.cleanupDeadLocalLocks || row.liveness !== 'dead_eligible')) throw quiescence();
      if ((await tx.executeRaw(`SELECT id FROM persistence_requests WHERE state IN ('queued','running','recovering') OR recovery IS NOT NULL LIMIT 1`)).length
        || (await tx.executeRaw('SELECT id FROM persistence_effects WHERE recovery IS NOT NULL LIMIT 1')).length) throw await notQuiescedError(tx, quiescence().message, { queuedEffects: false });
      if (opts.dryRun) return { enabled: false, activated: false, filesystem_sources: bindings.length, native_lock: native, legacy_locks: legacyLocks, drift_audit: driftAudit };
      for (const row of legacyLocks) {
        if (!(await deleteLockRowExact(tx, row.id, row.holder_pid, row.acquisition_token)).deleted) throw quiescence();
      }
      await registerLocalWriter(tx, 'cli');
      await registerLocalWriter(tx, 'stdio');
      await tx.executeRaw('UPDATE persistence_brain SET enabled=true,activated_at=COALESCE(activated_at,now()),mode_epoch=mode_epoch+1 WHERE singleton=1');
      // Any fsync/marker failure rolls back enabled=true. A conservative stale
      // refusal record after rollback is safe and cannot grant writer authority.
      await refreshManagedFilesystemRoots(tx, managedFilesystemDatastorePath(engine));
      return { enabled: true, activated: true, filesystem_sources: bindings.length, native_lock: native, legacy_locks: legacyLocks };
    });
  } finally { for (const lock of locks.reverse()) await lock.release(); }
}
