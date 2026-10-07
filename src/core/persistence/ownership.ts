import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Action } from '../agent-output.ts';
import { discoverGitRoot } from '../sync-git.ts';
import { cliOptsToProgressOptions, getCliOptions } from '../cli-options.ts';
import type { ProgressOptions } from '../progress.ts';
import { detectManifestScope, storedManifestScope, worktreeManifest, type StoredWorktreeManifest, type WorktreeManifest } from './worktree-manifest.ts';
import { localHostId, persistenceHome } from './identity.ts';
import type { SqlEngine, WriteRequest } from './model.ts';
import { acquireNativeLock, tryAcquireNativeLock, type NativeLockHandle } from './native-lock.ts';
import { acquireShared, yieldLease } from './worktree-lease.ts';
import { managedFilesystemDatastorePath, refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { assertPhysicalRoot, claimPhysicalRoot, preparePhysicalRootTransfer, readPhysicalRootReservation, restampPhysicalRoot } from './physical-root.ts';
import { readPhysicalRootStamp } from './physical-root-record.ts';
import { canonicalFilesystemPath, nativeFilesystemPath } from './root-registry.ts';
import { assertWriterAdminState } from './admin-intent.ts';
import { assertWriterAdminUnlocked } from './admin-lock.ts';
import { inspectPhysicalRootRecovery, repairPhysicalRoot, type PhysicalRootRecovery } from './physical-root-recovery.ts';

const writerStatusFix = (sourceId: string): Action => readFix(
  `Shows source ${sourceId}'s owner host, epoch, worktree state, admin_state and any publication still recovering, read-only.`,
  { argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });

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
/** `automatic` is only the ordinary first-write claim; the writer admin lock never blocks it. */
export async function claimWorktree(engine: BrainEngine, sourceId: string, path: string, hostId = localHostId(), expectedAdminState?: string,
  options: { automatic?: boolean } = {}): Promise<WorktreeBinding> {
  if(await managedPersistenceEnabled(engine)) {
    if(hostId!==localHostId()) throw opError('permission_denied','A source can be claimed only by the local registered host.',
      `Source ${sourceId} can only be claimed from the host that will own its checkout; nothing was claimed. Run the claim in a terminal on that host after reviewing writer status there.`,
      { fix: writerStatusFix(sourceId) });
    const { runManagedSourceLifecycle }=await import('./source-lifecycle.ts');
    await runManagedSourceLifecycle(engine,{operation:'claim',sourceId,path,expectedAdminState,automaticClaim:options.automatic});
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
  if (!probe) throw opError('writer_lock_unavailable', 'Cannot acquire the new worktree coordination lock.',
    `Another gbrain process holds the coordination lock for this checkout, so source ${sourceId} was not claimed. Check writer status and run the claim again once that process has finished.`,
    { fix: writerStatusFix(sourceId) });
  await probe.release();
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
    await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await assertWriterAdminState(tx, expectedAdminState);
    if (!options.automatic) await assertWriterAdminUnlocked(tx);
    const [source] = await tx.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    if (!source || source.archived) throw opError('source_changed', 'Only an active registered source can claim a worktree.',
      `Source ${sourceId} is missing or archived, so it cannot own a checkout; nothing was claimed. Check the registered sources; restoring an archived source is the user's decision.`,
      { fix: readFix('Lists the registered sources with their archived state, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
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
      VALUES($1,$2::uuid,$3::uuid,$4)`, [sourceId, source.incarnation, id,
      relative(nativeFilesystemPath(root), nativeFilesystemPath(sourceRoot)).split(sep).join('/')]);
    await refreshManagedFilesystemRoots(tx, managedFilesystemDatastorePath(engine));
  });
  return (await getWorktreeBinding(engine, sourceId, hostId))!;
}
/**
 * With an engine, a device-only physical-root change (#5604) is re-stamped under
 * this native lock after database ownership is verified; otherwise it refuses
 * with the filled self-transfer commands.
 */
export async function acquireWorktree(binding: WorktreeBinding, waitMs = 0, signal?: AbortSignal, engine?: BrainEngine): Promise<NativeLockHandle | null> {
  if (!binding.local_path || !binding.coordination_path) return null;
  // #5984 lanes: an exclusive writer drains this process's lane lease first; while lanes still hold it the worktree is busy.
  if (!await yieldLease(binding.coordination_path, waitMs, signal)) return null;
  return lockWorktree(binding, waitMs, signal, engine);
}
/** #5984 lanes: database-only lane publications share one native lock in this process (worktree-lease.ts). */
export async function acquireWorktreeShared(binding: WorktreeBinding, engine: BrainEngine): Promise<NativeLockHandle | null> {
  if (!binding.local_path || !binding.coordination_path) return null;
  return acquireShared(binding.coordination_path, () => lockWorktree(binding, 0, undefined, engine));
}
async function lockWorktree(binding: WorktreeBinding, waitMs: number, signal: AbortSignal | undefined, engine: BrainEngine | undefined): Promise<NativeLockHandle | null> {
  if (!binding.coordination_path || !binding.local_path) return null;
  const lock = await (waitMs > 0 ? acquireNativeLock(binding.coordination_path, { timeoutMs: waitMs, signal })
    : tryAcquireNativeLock(binding.coordination_path));
  if (!lock) return null;
  const identity = { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path };
  try { assertPhysicalRoot(binding.local_path, identity); return lock; }
  catch (error) {
    try {
      if (!(error instanceof OperationError) || error.detail !== 'physical_root_device_changed') throw error;
      if (engine && await restampPhysicalRoot(engine, binding, localHostId())) { assertPhysicalRoot(binding.local_path, identity); return lock; }
      const why = !engine ? 'this caller cannot verify database ownership'
        : readPhysicalRootStamp(binding.local_path)?.birth === '0' ? 'this filesystem reports no birth time'
          : 'database ownership of this checkout did not verify';
      error.suggestion = `The automatic device re-stamp did not apply because ${why}. On the brain host, run gbrain sources writer status ${binding.source_id} and note admin_state, `
        + `then gbrain sources writer transfer prepare ${binding.source_id} --self-transfer --admin-intent writer_transfer_prepare --expected-state <admin_state>, `
        + `then gbrain sources writer transfer accept ${binding.source_id} --path ${binding.local_path} --expected-epoch ${binding.owner_epoch} --manifest <manifest digest printed by prepare> `
        + `--self-transfer --admin-intent writer_transfer_accept --expected-state <admin_state from a fresh status>. Retry the original write with the same request_id afterwards.`;
      throw error;
    } catch (failure) { await lock.release(); throw failure; }
  }
}
/**
 * How long a managed writer's preflight probe waits for the worktree lock.
 * This process's own persistence consumer holds it while it finishes
 * publishing the previous write, after that write's receipt already reads
 * committed, so a zero-wait probe refused on our own writer. A holder still
 * busy after the wait is a real conflict.
 */
export const MANAGED_WRITER_PROBE_WAIT_MS = 1000;

/** Acquire-and-release probe of the worktree lock within MANAGED_WRITER_PROBE_WAIT_MS; false when it stayed busy. */
export async function probeWorktreeWriter(binding: WorktreeBinding, engine?: BrainEngine): Promise<boolean> {
  const lock = await acquireWorktree(binding, MANAGED_WRITER_PROBE_WAIT_MS, undefined, engine);
  if (!lock) return false;
  await lock.release();
  return true;
}
export async function guardOwnership(tx: SqlEngine, row: WriteRequest, hostId: string): Promise<WorktreeBinding | null> {
  if (!row.worktree_id) return null;
  const [owner] = await tx.executeRaw<{ owner_host_id: string; owner_epoch: string | number; state: string }>(
    'SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [row.worktree_id]);
  const binding = await getWorktreeBinding(tx, row.source_id, hostId);
  if (!owner || !binding || binding.worktree_id !== row.worktree_id || binding.source_incarnation !== row.source_incarnation ||
    owner.owner_host_id !== hostId || owner.state !== 'active' || String(binding.topology_generation) !== String(row.topology_generation)) {
    throw opError('owner_unavailable', 'The accepted worktree ownership or source topology changed.',
      `Source ${row.source_id}'s owner, epoch or topology changed after request ${row.request_id} was accepted, so this host did not publish it. Inspect the owner and the request's receipt (on the channel that submitted it) before resubmitting anything.`,
      { fix: writerStatusFix(row.source_id) });
  }
  return binding;
}
export async function activateManagedPersistence(engine: BrainEngine, opts: { confirmQuiesced?: boolean } = {}): Promise<void> {
  const { activatePersistence } = await import('./activation.ts');
  await activatePersistence(engine, opts);
}

export { MANIFEST_PROGRESS_MIN_FILES, compactStoredManifest, storedManifestScope, worktreeManifest,
  type StoredWorktreeManifest, type WorktreeManifest, type WorktreeManifestScope } from './worktree-manifest.ts';

/**
 * #6099: why a successor checkout does not verify, agent-first. A transfer an older release prepared in tree scope
 * (every file, ignored ones included) is re-prepared in Git scope rather than asking the user to copy ignored files.
 */
export function successorManifestMismatch(sourceId: string, root: string, expected: string, prepared: StoredWorktreeManifest | null,
  candidate: WorktreeManifest): OperationError {
  if (storedManifestScope(prepared) === 'tree' && detectManifestScope(root) === 'git') return opError('writer_manifest_rescope_required',
    'The transfer was prepared over every file of the old checkout, ignored files included; prepare it again so it covers tracked Git files only.',
    `Source ${sourceId}'s transfer manifest ${expected} was recorded by an older release over every file in the owner's checkout, including files Git ignores (such as .env files), so a clean clone at ${root} cannot match it and nothing was accepted. `
      + `Do not copy ignored files across. On the owner host, prepare the transfer again (it now records tracked Git files only), then accept with the new epoch and manifest it prints.`,
    { fix: { argv: ['gbrain', 'sources', 'writer', 'transfer', 'prepare', sourceId, '--admin-intent', 'writer_transfer_prepare', '--expected-state', '<admin_state>'],
      inputs: [{ name: 'admin_state', how: `admin_state from gbrain sources writer status ${sourceId} --json on the owner host` }],
      consent: [], actor: 'host_admin', requires_exclusive: false, docs: 'docs/architecture/topologies.md#transfer-manifest-scope',
      why: 'Re-records the transfer manifest over tracked Git files on the owner host; the successor then accepts with the printed epoch and manifest.' } });
  const untracked = candidate.scope === 'git' && candidate.untracked_count ? ` ${candidate.untracked_count} untracked file(s) here that Git does not ignore are not part of the manifest and do not cause this.` : '';
  return opError('writer_manifest_mismatch', 'Successor checkout differs from the recorded canonical manifest.',
    candidate.scope === 'git'
      ? `The tracked Git files at ${root} (${candidate.file_count} present) do not hash to manifest ${expected} that the owner recorded for source ${sourceId}; nothing was accepted. A tracked file differs, is missing or is extra.${untracked} `
        + `Make ${root} a clean clone of the owner's repository at the same commit (git clone <owner repository> ${root}, then git -C ${root} checkout <owner commit>), compare with git -C ${root} status, then accept again.`
      : `The checkout at ${root} does not hash to manifest ${expected} that the owner recorded for source ${sourceId}; nothing was accepted. Bring it to exactly the prepared content (same files, no extras or deletions), then accept again.`,
    { fix: writerStatusFix(sourceId) });
}

/** Human-mode progress for manifest hashing; JSON and quiet modes report nothing. */
export function humanManifestProgress(): ProgressOptions | undefined {
  const options = cliOptsToProgressOptions(getCliOptions());
  return options.mode === 'auto' ? options : undefined;
}

export async function prepareWriterTransfer(engine: BrainEngine, sourceId: string, hostId = localHostId(), expectedAdminState?: string,
  opts: { selfTransfer?: boolean; dryRun?: boolean } = {}): Promise<{ worktree_id: string; owner_epoch: string; manifest: StoredWorktreeManifest }> {
  const binding = await getWorktreeBinding(engine, sourceId, hostId);
  if (!binding || binding.owner_host_id !== hostId || !binding.local_path) throw opError('permission_denied', 'Only the current owner can prepare this transfer.',
    `This host does not own source ${sourceId}'s checkout, so nothing was prepared. Check which host owns it; transfer preparation runs in a terminal on that host.`,
    { fix: writerStatusFix(sourceId) });
  if (!binding.coordination_path) throw opError('recovery_required', 'The recorded coordination path is missing.',
    `Source ${sourceId}'s host binding has no coordination lock path, so no transfer was prepared. Inspect writer status and show it to the user; repairing the binding is a deliberate topology change (docs/architecture/topologies.md).`,
    { fix: writerStatusFix(sourceId) });
  const lock = opts.selfTransfer ? await acquireNativeLock(binding.coordination_path, { timeoutMs: 5000 }) : await acquireWorktree(binding, 5000);
  if (!lock) throw opError('write_pending', 'The worktree is busy; retry transfer preparation.',
    `A write still holds source ${sourceId}'s worktree lock, so nothing was prepared. Wait until writer status shows no write in flight, then run transfer prepare again.`,
    { fix: writerStatusFix(sourceId) });
  try {
    // The native lock already excludes writers, so hash before checking out a
    // connection. A hashing failure surfaces after the root checks below, as before.
    const hashed = (() => { try { return worktreeManifest(binding.local_path!, { progress: humanManifestProgress() }); } catch (error) { return error as Error; } })();
    return await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
      await assertWriterAdminState(tx, expectedAdminState);
      await assertWriterAdminUnlocked(tx);
      const [owner] = await tx.executeRaw<{ owner_host_id: string; owner_epoch: string; state: string }>('SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [binding.worktree_id]);
      const current = await getWorktreeBinding(tx, sourceId, hostId);
      if (!owner || owner.owner_host_id !== hostId || JSON.stringify(current) !== JSON.stringify(binding)) throw opError('owner_unavailable', 'Ownership changed during transfer.',
        `Source ${sourceId}'s owner or binding changed while the transfer was being prepared, so nothing was recorded. Inspect writer status again before deciding on any transfer.`,
        { fix: writerStatusFix(sourceId) });
      if (owner.state !== 'active' && owner.state !== 'draining') throw opError('writer_transfer_conflict', 'Finish publication recovery before preparing a transfer.',
        `Source ${sourceId}'s worktree is in state ${owner.state}, not active, so no transfer was prepared. Let the owner finish publication recovery (writer status shows it), then prepare again.`,
        { fix: writerStatusFix(sourceId) });
      const pending = await tx.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND
        (state IN ('running','recovering') OR recovery IS NOT NULL) LIMIT 1`, [binding.worktree_id]);
      const mirrors = await tx.executeRaw('SELECT id FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1', [binding.worktree_id]);
      if (pending.length || mirrors.length) throw opError('recovery_required', 'Resolve outstanding publication before transfer.',
        `Source ${sourceId}'s worktree still has a write or mirror effect publishing or recovering, so no transfer was prepared. Inspect writer status and wait for it to settle on the owner before preparing again.`,
        { fix: writerStatusFix(sourceId) });
      const [brain] = await tx.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
      const recovery = opts.selfTransfer ? inspectPhysicalRootRecovery(binding.local_path!, { brainId: brain.brain_id,
        worktreeId: binding.worktree_id, hostId, coordinationPath: binding.coordination_path! }) : undefined;
      if (!opts.selfTransfer) assertPhysicalRoot(binding.local_path!, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path });
      if (hashed instanceof Error) throw hashed;
      const manifest: StoredWorktreeManifest = { ...hashed, ...(recovery ? { self_transfer: recovery } : {}) };
      if (!opts.dryRun) await tx.executeRaw(`UPDATE persistence_worktrees SET state='draining',manifest=$2::text::jsonb WHERE id=$1::uuid`, [binding.worktree_id, JSON.stringify(manifest)]);
      return { worktree_id: binding.worktree_id, owner_epoch: String(owner.owner_epoch), manifest };
    });
  } finally { await lock.release(); }
}
export async function acceptWriterTransfer(engine: BrainEngine, sourceId: string, path: string, expectedEpoch: string, expectedManifest: string, hostId = localHostId(), expectedAdminState?: string,
  opts: { selfTransfer?: boolean; dryRun?: boolean } = {}): Promise<void> {
  const root = realpathSync(resolve(path));
  const binding = await getWorktreeBinding(engine, sourceId, hostId);
  if (!binding) throw opError('not_found', 'Source has no worktree owner.',
    `Source ${sourceId} has no canonical owner to transfer from, so nothing was accepted. Check writer status; a source without an owner is claimed, not transferred, and claiming is the user's decision.`,
    { fix: writerStatusFix(sourceId) });
  if (opts.selfTransfer && binding.owner_host_id !== hostId) throw opError('permission_denied', 'Self-transfer requires the current owner host.',
    `This host does not own source ${sourceId}, so a self-transfer cannot run here; nothing was accepted. Run it on the owner host, or accept an ordinary transfer prepared by the owner.`,
    { fix: writerStatusFix(sourceId) });
  if (opts.selfTransfer && root !== binding.local_path) throw opError('source_changed', 'Self-transfer must target the recorded canonical path.',
    `A self-transfer of source ${sourceId} only repairs its recorded checkout, so nothing was accepted. Pass --path ${binding.local_path ?? 'with the recorded canonical path from writer status'} instead.`,
    { fix: writerStatusFix(sourceId) });
  const coordination = opts.selfTransfer ? binding.coordination_path : readPhysicalRootReservation(root)?.coordinationPath ?? join(persistenceHome(), 'locks', `${binding.worktree_id}.lock`);
  if (!coordination) throw opError('recovery_required', 'The recorded coordination path is missing.',
    `Source ${sourceId}'s host binding has no coordination lock path, so no transfer was accepted. Inspect writer status and show it to the user; repairing the binding is a deliberate topology change (docs/architecture/topologies.md).`,
    { fix: writerStatusFix(sourceId) });
  const lock = await acquireNativeLock(coordination, { timeoutMs: 5000 });
  if (!lock) throw opError('write_pending', 'Successor worktree is busy.',
    `Another gbrain process holds the successor checkout's coordination lock, so source ${sourceId}'s transfer was not accepted. Run transfer accept again once that process has finished.`,
    { fix: writerStatusFix(sourceId) });
  try {
    // #6099: verify in the scope the owner recorded (a manifest an older release prepared is in tree scope).
    const [prepared] = await engine.executeRaw<{ manifest: StoredWorktreeManifest | null }>('SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [binding.worktree_id]);
    const candidate = worktreeManifest(root, { progress: humanManifestProgress(), scope: storedManifestScope(prepared?.manifest) });
    if (candidate.digest !== expectedManifest) throw successorManifestMismatch(sourceId, root, expectedManifest, prepared?.manifest ?? null, candidate);
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
      await assertWriterAdminState(tx, expectedAdminState);
      await assertWriterAdminUnlocked(tx);
      const [owner] = await tx.executeRaw<{ owner_epoch: string; state: string; manifest: { digest: string; self_transfer?: PhysicalRootRecovery } }>('SELECT owner_epoch,state,manifest FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [binding.worktree_id]);
      if (!owner || owner.state !== 'draining' || String(owner.owner_epoch) !== expectedEpoch || owner.manifest?.digest !== expectedManifest) throw opError('writer_transfer_conflict', 'Transfer preparation or epoch changed.',
        `Source ${sourceId} is no longer prepared at epoch ${expectedEpoch} with manifest ${expectedManifest}, so nothing was accepted. Read writer status and use the epoch and manifest of the current preparation, or have the owner prepare again.`,
        { fix: writerStatusFix(sourceId) });
      if (!!owner.manifest.self_transfer !== !!opts.selfTransfer || JSON.stringify(await getWorktreeBinding(tx, sourceId, hostId)) !== JSON.stringify(binding)) throw opError('writer_transfer_conflict', 'The prepared transfer mode or binding changed.',
        `Source ${sourceId} was prepared ${owner.manifest.self_transfer ? 'as' : 'without'} a self-transfer, or its binding changed since then, so nothing was accepted. Accept with the same --self-transfer choice used at prepare, after re-reading writer status.`,
        { fix: writerStatusFix(sourceId) });
      const pending = await tx.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND (state IN ('running','recovering') OR recovery IS NOT NULL) LIMIT 1`, [binding.worktree_id]);
      const mirrors = await tx.executeRaw('SELECT id FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1', [binding.worktree_id]);
      if (pending.length || mirrors.length) throw opError('recovery_required', 'Transfer state changed; prepare again.',
        `A write or mirror effect started publishing in source ${sourceId}'s worktree after preparation, so nothing was accepted. Wait for writer status to show it settled, then have the owner prepare the transfer again.`,
        { fix: writerStatusFix(sourceId) });
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
