import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { discoverGitRoot } from '../sync-git.ts';
import { digest, sha256 } from './digest.ts';
import { localHostId, persistenceHome } from './identity.ts';
import type { SqlEngine, WriteRequest } from './model.ts';
import { acquireNativeLock, tryAcquireNativeLock, type NativeLockHandle } from './native-lock.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { assertPhysicalRoot, claimPhysicalRoot, isPhysicalRootMetadata, preparePhysicalRootTransfer, readPhysicalRootReservation } from './physical-root.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { assertWriterAdminState } from './admin-intent.ts';
import { inspectPhysicalRootRecovery, repairPhysicalRoot, type PhysicalRootRecovery } from './physical-root-recovery.ts';

export interface WorktreeBinding {
  worktree_id: string;
  source_id: string;
  source_incarnation: string;
  relative_path: string;
  topology_generation: string | number;
  owner_host_id: string | null;
  owner_epoch: string | number;
  state: 'active' | 'draining' | 'recovering';
  local_path: string | null;
  coordination_path: string | null;
}
export function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
export async function managedPersistenceEnabled(engine: SqlEngine): Promise<boolean> {
  const [row] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  return row?.enabled === true;
}
export async function getWorktreeBinding(engine: SqlEngine, sourceId: string, hostId: string | null = localHostId()): Promise<WorktreeBinding | null> {
  const [row] = await engine.executeRaw<WorktreeBinding>(`SELECT s.source_id,s.source_incarnation,s.worktree_id,s.relative_path,
    s.topology_generation::text AS topology_generation,w.owner_host_id,w.owner_epoch::text AS owner_epoch,w.state,
    h.local_path,h.coordination_path FROM persistence_source_bindings s
    JOIN persistence_worktrees w ON w.id=s.worktree_id
    LEFT JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=$2::uuid
    WHERE s.source_id=$1`, [sourceId, hostId]);
  return row ?? null;
}
export async function claimWorktree(engine: BrainEngine, sourceId: string, path: string, hostId = localHostId(), expectedAdminState?: string): Promise<WorktreeBinding> {
  if(await managedPersistenceEnabled(engine)) {
    if(hostId!==localHostId()) throw new OperationError('permission_denied','A source can be claimed only by the local registered host.');
    const { runManagedSourceLifecycle }=await import('./source-lifecycle.ts');
    await runManagedSourceLifecycle(engine,{operation:'claim',sourceId,path,expectedAdminState});
    return (await getWorktreeBinding(engine,sourceId,hostId))!;
  }
  let sourceRoot: string;
  try {
    sourceRoot = realpathSync(resolve(path));
    if (!statSync(sourceRoot).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new OperationError('storage_error', 'Configured canonical source root is unavailable or is not a directory.',
      'Restore access to the configured source directory before retrying.');
  }
  let root = sourceRoot;
  try { root = realpathSync(discoverGitRoot(root)); } catch { /* ordinary directory source */ }
  // Probe the native capability before recording ownership. Stable lock lives
  // outside any source directory, so reclone cannot produce a second inode.
  const existingPhysical = readPhysicalRootReservation(root);
  const candidateId = existingPhysical?.worktreeId ?? randomUUID();
  const lockPath = existingPhysical?.coordinationPath ?? canonicalFilesystemPath(join(persistenceHome(), 'locks', `${candidateId}.lock`));
  const probe = await tryAcquireNativeLock(lockPath);
  if (!probe) throw new OperationError('writer_lock_unavailable', 'Cannot acquire the new worktree coordination lock.');
  await probe.release();
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await assertWriterAdminState(tx, expectedAdminState);
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    if (!source || source.archived) throw new OperationError('source_changed', 'Only an active registered source can claim a worktree.');
    const current = await getWorktreeBinding(tx, sourceId, hostId);
    if (current) {
      if (current.source_incarnation !== source.incarnation || current.owner_host_id !== hostId || current.local_path !== root) {
        throw new OperationError('writer_transfer_required', 'This source already has an owner or a different binding.', 'Use a verified source writer transfer.');
      }
      assertPhysicalRoot(root, { worktreeId: current.worktree_id, coordinationPath: current.coordination_path });
      await refreshManagedFilesystemRoots(tx, managedFilesystemDatastorePath(engine));
      return;
    }
    const local = await tx.executeRaw<{ worktree_id: string; local_path: string; coordination_path: string; owner_host_id: string | null }>(
      `SELECT h.*,w.owner_host_id FROM persistence_host_bindings h JOIN persistence_worktrees w ON w.id=h.worktree_id WHERE h.host_id=$1::uuid`, [hostId]);
    const overlap = local.find(b => containsPath(b.local_path, root) || containsPath(root, b.local_path));
    let id: string = candidateId;
    if (overlap) {
      if (overlap.owner_host_id !== hostId || !containsPath(overlap.local_path, root)) throw new OperationError('topology_change_required', 'Adding this source would replace or overlap another owner root.', 'Drain affected worktrees and explicitly rebind their topology.');
      id = overlap.worktree_id; root = overlap.local_path;
      assertPhysicalRoot(root, { worktreeId: id, coordinationPath: overlap.coordination_path });
    } else {
      const physical = await claimPhysicalRoot(tx, root, { hostId, worktreeId: candidateId, coordinationPath: lockPath });
      id = physical.worktreeId;
      await tx.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch) VALUES($1::uuid,$2::uuid,1)', [id, hostId]);
      await tx.executeRaw(`INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path)
        VALUES($1::uuid,$2::uuid,$3,$4)`, [id, hostId, root, physical.coordinationPath]);
    }
    await tx.executeRaw(`INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id,relative_path)
      VALUES($1,$2::uuid,$3::uuid,$4)`, [sourceId, source.incarnation, id, relative(root, sourceRoot).split(sep).join('/')]);
    await refreshManagedFilesystemRoots(tx, managedFilesystemDatastorePath(engine));
  });
  return (await getWorktreeBinding(engine, sourceId, hostId))!;
}
export async function acquireWorktree(binding: WorktreeBinding, waitMs = 0, signal?: AbortSignal): Promise<NativeLockHandle | null> {
  if (!binding.local_path || !binding.coordination_path) return null;
  const lock = await (waitMs > 0 ? acquireNativeLock(binding.coordination_path, { timeoutMs: waitMs, signal })
    : tryAcquireNativeLock(binding.coordination_path));
  if (!lock) return null;
  try { assertPhysicalRoot(binding.local_path, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path }); return lock; }
  catch (error) { await lock.release(); throw error; }
}
export async function guardOwnership(tx: SqlEngine, row: WriteRequest, hostId: string): Promise<WorktreeBinding | null> {
  if (!row.worktree_id) return null;
  const [owner] = await tx.executeRaw<{ owner_host_id: string; owner_epoch: string | number; state: string }>(
    'SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [row.worktree_id]);
  const binding = await getWorktreeBinding(tx, row.source_id, hostId);
  if (!owner || !binding || binding.worktree_id !== row.worktree_id || binding.source_incarnation !== row.source_incarnation ||
    owner.owner_host_id !== hostId || owner.state !== 'active' || String(binding.topology_generation) !== String(row.topology_generation)) {
    throw new OperationError('owner_unavailable', 'The accepted worktree ownership or source topology changed.');
  }
  return binding;
}
export async function activateManagedPersistence(engine: BrainEngine, opts: { confirmQuiesced?: boolean } = {}): Promise<void> {
  const { activatePersistence } = await import('./activation.ts');
  await activatePersistence(engine, opts);
}

/** Deterministic content manifest includes deletions by exact path-set equality. */
export function worktreeManifest(root: string): { digest: string; files: Record<string, string> } {
  const canonical = realpathSync(root);
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === '.gbrain-managed' || isPhysicalRootMetadata(name)) continue;
      const path = join(dir, name), info = lstatSync(path);
      if (info.isSymbolicLink()) throw new OperationError('writer_manifest_unsafe', 'Canonical worktree transfer requires a symlink-free manifest.');
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) files[relative(canonical, path).split(sep).join('/')] = sha256(readFileSync(path));
    }
  };
  visit(canonical);
  return { digest: digest(files), files };
}
export async function prepareWriterTransfer(engine: BrainEngine, sourceId: string, hostId = localHostId(), expectedAdminState?: string,
  opts: { selfTransfer?: boolean; dryRun?: boolean } = {}): Promise<{ worktree_id: string; owner_epoch: string; manifest: ReturnType<typeof worktreeManifest> }> {
  const binding = await getWorktreeBinding(engine, sourceId, hostId);
  if (!binding || binding.owner_host_id !== hostId || !binding.local_path) throw new OperationError('permission_denied', 'Only the current owner can prepare this transfer.');
  if (!binding.coordination_path) throw new OperationError('recovery_required', 'The recorded coordination path is missing.');
  const lock = opts.selfTransfer ? await acquireNativeLock(binding.coordination_path, { timeoutMs: 5000 }) : await acquireWorktree(binding, 5000);
  if (!lock) throw new OperationError('write_pending', 'The worktree is busy; retry transfer preparation.');
  try {
    return await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
      await assertWriterAdminState(tx, expectedAdminState);
      const [owner] = await tx.executeRaw<{ owner_host_id: string; owner_epoch: string; state: string }>('SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [binding.worktree_id]);
      const current = await getWorktreeBinding(tx, sourceId, hostId);
      if (!owner || owner.owner_host_id !== hostId || JSON.stringify(current) !== JSON.stringify(binding)) throw new OperationError('owner_unavailable', 'Ownership changed during transfer.');
      if (owner.state !== 'active' && owner.state !== 'draining') throw new OperationError('writer_transfer_conflict', 'Finish publication recovery before preparing a transfer.');
      const pending = await tx.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND
        (state IN ('running','recovering') OR recovery IS NOT NULL) LIMIT 1`, [binding.worktree_id]);
      const mirrors = await tx.executeRaw('SELECT id FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1', [binding.worktree_id]);
      if (pending.length || mirrors.length) throw new OperationError('recovery_required', 'Resolve outstanding publication before transfer.');
      const [brain] = await tx.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
      const recovery = opts.selfTransfer ? inspectPhysicalRootRecovery(binding.local_path!, { brainId: brain.brain_id,
        worktreeId: binding.worktree_id, hostId, coordinationPath: binding.coordination_path! }) : undefined;
      if (!opts.selfTransfer) assertPhysicalRoot(binding.local_path!, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path });
      const manifest = { ...worktreeManifest(binding.local_path!), ...(recovery ? { self_transfer: recovery } : {}) };
      if (!opts.dryRun) await tx.executeRaw(`UPDATE persistence_worktrees SET state='draining',manifest=$2::text::jsonb WHERE id=$1::uuid`, [binding.worktree_id, JSON.stringify(manifest)]);
      return { worktree_id: binding.worktree_id, owner_epoch: String(owner.owner_epoch), manifest };
    });
  } finally { await lock.release(); }
}
export async function acceptWriterTransfer(engine: BrainEngine, sourceId: string, path: string, expectedEpoch: string, expectedManifest: string, hostId = localHostId(), expectedAdminState?: string,
  opts: { selfTransfer?: boolean; dryRun?: boolean } = {}): Promise<void> {
  const root = realpathSync(resolve(path));
  const manifest = worktreeManifest(root);
  if (manifest.digest !== expectedManifest) throw new OperationError('writer_manifest_mismatch', 'Successor checkout differs from the recorded canonical manifest.');
  const binding = await getWorktreeBinding(engine, sourceId, hostId);
  if (!binding) throw new OperationError('not_found', 'Source has no worktree owner.');
  if (opts.selfTransfer && binding.owner_host_id !== hostId) throw new OperationError('permission_denied', 'Self-transfer requires the current owner host.');
  if (opts.selfTransfer && root !== binding.local_path) throw new OperationError('source_changed', 'Self-transfer must target the recorded canonical path.');
  const coordination = opts.selfTransfer ? binding.coordination_path : readPhysicalRootReservation(root)?.coordinationPath ?? join(persistenceHome(), 'locks', `${binding.worktree_id}.lock`);
  if (!coordination) throw new OperationError('recovery_required', 'The recorded coordination path is missing.');
  const lock = await acquireNativeLock(coordination, { timeoutMs: 5000 });
  if (!lock) throw new OperationError('write_pending', 'Successor worktree is busy.');
  try {
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
      await assertWriterAdminState(tx, expectedAdminState);
      const [owner] = await tx.executeRaw<{ owner_epoch: string; state: string; manifest: { digest: string; self_transfer?: PhysicalRootRecovery } }>('SELECT owner_epoch,state,manifest FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [binding.worktree_id]);
      if (!owner || owner.state !== 'draining' || String(owner.owner_epoch) !== expectedEpoch || owner.manifest?.digest !== expectedManifest) throw new OperationError('writer_transfer_conflict', 'Transfer preparation or epoch changed.');
      if (!!owner.manifest.self_transfer !== !!opts.selfTransfer || JSON.stringify(await getWorktreeBinding(tx, sourceId, hostId)) !== JSON.stringify(binding)) throw new OperationError('writer_transfer_conflict', 'The prepared transfer mode or binding changed.');
      const pending = await tx.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND (state IN ('running','recovering') OR recovery IS NOT NULL) LIMIT 1`, [binding.worktree_id]);
      const mirrors = await tx.executeRaw('SELECT id FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1', [binding.worktree_id]);
      if (pending.length || mirrors.length || worktreeManifest(root).digest !== expectedManifest) throw new OperationError('recovery_required', 'Transfer state changed; prepare again.');
      if (opts.selfTransfer) repairPhysicalRoot(root, owner.manifest.self_transfer!, { hostId, worktreeId: binding.worktree_id, coordinationPath: coordination }, opts.dryRun);
      else if (!opts.dryRun) await preparePhysicalRootTransfer(tx, root, { hostId, worktreeId: binding.worktree_id, coordinationPath: coordination, expectedEpoch });
      if (opts.dryRun) return;
      await tx.executeRaw(`INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path)
        VALUES($1::uuid,$2::uuid,$3,$4) ON CONFLICT(worktree_id,host_id) DO UPDATE SET local_path=EXCLUDED.local_path,coordination_path=EXCLUDED.coordination_path`, [binding.worktree_id, hostId, root, coordination]);
      await tx.executeRaw(`UPDATE persistence_worktrees SET owner_host_id=$2::uuid,owner_epoch=owner_epoch+1,state='active',heartbeat_at=now() WHERE id=$1::uuid`, [binding.worktree_id, hostId]);
      await refreshManagedFilesystemRoots(tx, managedFilesystemDatastorePath(engine));
    });
  } finally { await lock.release(); }
}
