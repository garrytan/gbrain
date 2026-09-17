import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlEngine } from './model.ts';
import { persistenceHome } from './identity.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { adoptTransferredRootStamp, assertNoPhysicalRootOverlap, assertPhysicalRoot, assertPhysicalRootStamp, PHYSICAL_ROOT_MARKER, physicalRootError,
  readPhysicalRootReservation, reservePhysicalRootRecord, writePhysicalRootStamp, type PhysicalRootReservation } from './physical-root-record.ts';

export { assertPhysicalRoot, isPhysicalRootMetadata, readPhysicalRootReservation } from './physical-root-record.ts';
export interface PhysicalRootClaim { hostId: string; worktreeId?: string; coordinationPath?: string; }
async function brainIdentity(tx: SqlEngine): Promise<string> {
  const [brain] = await tx.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
  if (!brain) throw physicalRootError();
  return brain.brain_id;
}
/**
 * Caller holds the brain/topology transaction guard. The private shared-path
 * reservation is a veto, never database ownership authority. It is deliberately
 * retained after a transaction rollback or process death.
 */
export async function reservePhysicalRoot(tx: SqlEngine, path: string, opts: PhysicalRootClaim): Promise<PhysicalRootReservation> {
  const root = canonicalFilesystemPath(path), brainId = await brainIdentity(tx);
  const previous = readPhysicalRootReservation(root);
  const worktreeId = opts.worktreeId ?? previous?.worktreeId ?? randomUUID();
  const coordinationPath = opts.coordinationPath ?? previous?.coordinationPath ?? canonicalFilesystemPath(join(persistenceHome(), 'locks', `${worktreeId}.lock`));
  // A copied marker without its original sibling reservation is not a new root.
  if (!previous && existsSync(join(root, PHYSICAL_ROOT_MARKER))) throw physicalRootError();
  const reservation = previous ?? reservePhysicalRootRecord(root, { brainId, worktreeId, hostId: opts.hostId, coordinationPath });
  if (reservation.brainId !== brainId || reservation.worktreeId !== worktreeId || reservation.coordinationPath !== coordinationPath) throw physicalRootError();
  const [owner] = await tx.executeRaw<{ owner_host_id: string | null }>('SELECT owner_host_id FROM persistence_worktrees WHERE id=$1::uuid', [worktreeId]);
  if (owner ? owner.owner_host_id !== opts.hostId : reservation.hostId !== opts.hostId) throw physicalRootError('Another host owns or has prepared this physical checkout.');
  assertNoPhysicalRootOverlap(root);
  return reservation;
}
/** Existing bindings require their stamp; only a never-committed original claim may finish creating it. */
export async function claimPhysicalRoot(tx: SqlEngine, path: string, opts: PhysicalRootClaim): Promise<PhysicalRootReservation> {
  const reservation = await reservePhysicalRoot(tx, path, opts);
  const [owner] = await tx.executeRaw<{ state: string }>('SELECT state FROM persistence_worktrees WHERE id=$1::uuid', [reservation.worktreeId]);
  if (owner && owner.state !== 'active') throw physicalRootError('Finish the prepared transfer or recovery before claiming this root.');
  const [bound] = await tx.executeRaw<{ local_path: string; coordination_path: string }>('SELECT local_path,coordination_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid', [reservation.worktreeId, opts.hostId]);
  if (bound) {
    if (bound.local_path !== reservation.root || bound.coordination_path !== reservation.coordinationPath) throw physicalRootError('This worktree was rebound to a different checkout.');
    assertPhysicalRoot(reservation.root, reservation);
  }
  else {
    const info = statSync(reservation.root, { bigint: true });
    if (reservation.initialDevice !== info.dev.toString() || reservation.initialInode !== info.ino.toString() || reservation.initialBirth !== info.birthtimeNs.toString()) throw physicalRootError();
    writePhysicalRootStamp(reservation.root, reservation);
  }
  return reservation;
}
/**
 * Only durable directory-swap recovery may stamp a different inode. The caller
 * has verified the canonical manifest and holds the stable outside-root lock.
 * Moving this stage to target preserves the stamp and immutable reservation.
 */
export async function preparePhysicalRootReplacement(tx: SqlEngine, stage: string, target: string,
  opts: Required<PhysicalRootClaim>): Promise<void> {
  const reservation = await reservePhysicalRoot(tx, target, opts);
  const [owner] = await tx.executeRaw<{ owner_host_id: string; state: string }>('SELECT owner_host_id,state FROM persistence_worktrees WHERE id=$1::uuid', [opts.worktreeId]);
  if (owner?.owner_host_id !== opts.hostId || owner.state !== 'recovering') throw physicalRootError('A directory replacement requires durable source recovery.');
  if (existsSync(target)) assertPhysicalRoot(target, opts);
  writePhysicalRootStamp(stage, reservation);
  assertPhysicalRootStamp(stage, reservation);
}
/** Called only after the draining epoch and complete successor manifest were verified under SQL/native guards. */
export async function preparePhysicalRootTransfer(tx: SqlEngine, path: string,
  opts: Required<PhysicalRootClaim> & { expectedEpoch: string }): Promise<void> {
  const [owner] = await tx.executeRaw<{ owner_epoch: string; state: string }>('SELECT owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid', [opts.worktreeId]);
  if (owner?.state !== 'draining' || String(owner.owner_epoch) !== opts.expectedEpoch) throw physicalRootError();
  const root = canonicalFilesystemPath(path), brainId = await brainIdentity(tx);
  const reservation = readPhysicalRootReservation(root) ?? reservePhysicalRootRecord(root,
    { brainId, worktreeId: opts.worktreeId, hostId: opts.hostId, coordinationPath: opts.coordinationPath });
  if (reservation.brainId !== brainId || reservation.worktreeId !== opts.worktreeId || reservation.coordinationPath !== opts.coordinationPath) throw physicalRootError();
  assertNoPhysicalRootOverlap(root);
  adoptTransferredRootStamp(root, reservation);
}
